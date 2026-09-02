/**
 * Typed failures, each one carrying the fix.
 *
 * Midjourney has no error contract to lean on: it is a web app talking to its
 * own backend, so a failure arrives as a bare status, an HTML interstitial, or
 * a redirect to the sign-in page. Handing a model "HTTP 403" from any of those
 * tells it nothing and it gives up. Every failure here is classified into one
 * of a small number of things that actually went wrong, and each says what to
 * do about it, because the recovery is genuinely different every time: log in
 * again, wait for a challenge to clear, buy more fast hours, fix the prompt.
 */

export class MidjourneyError extends Error {
  readonly status: number;
  readonly endpoint: string;
  readonly detail: string;

  constructor(message: string, status: number, endpoint: string, detail = "") {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.endpoint = endpoint;
    this.detail = detail;
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.message,
      type: this.name,
      ...(this.status ? { status: this.status } : {}),
      endpoint: this.endpoint,
      ...(this.detail ? { detail: this.detail.slice(0, 500) } : {}),
    };
  }
}

/** Chrome could not be found, started, or driven. Nothing reached Midjourney. */
export class BrowserError extends MidjourneyError {
  constructor(message: string) {
    super(message, 0, "(browser)", "");
  }
}

/** The browser profile is not signed in to Midjourney. */
export class NotSignedInError extends MidjourneyError {}

/**
 * Cloudflare served an interstitial instead of the API.
 *
 * Distinct from a sign-in failure and worth its own class, because the fix is
 * to let the browser window solve it once, not to re-authenticate.
 */
export class ChallengeError extends MidjourneyError {}

/** Midjourney rejected the request as malformed, or the prompt as unacceptable. */
export class ValidationError extends MidjourneyError {}

/** The job, folder or asset is not there. */
export class NotFoundError extends MidjourneyError {}

/** Too many requests, or out of fast hours. */
export class RateLimitError extends MidjourneyError {}

/** Upstream 5xx. Usually transient. */
export class ServerError extends MidjourneyError {}

/** Our own deadline expired. */
export class TimeoutError extends MidjourneyError {}

/** A job was submitted but never reached a terminal state in time. */
export class JobTimeoutError extends MidjourneyError {
  readonly jobId: string;

  constructor(message: string, jobId: string) {
    super(message, 0, "(local)", "");
    this.jobId = jobId;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), job_id: this.jobId };
  }
}

/** Writes are off, or a spending tool was called without confirmation. */
export class WriteBlockedError extends MidjourneyError {
  constructor(message: string) {
    super(message, 0, "(local)", "");
  }
}

/**
 * Is this body a Cloudflare interstitial rather than an answer?
 *
 * The challenge is served with a 403 and an HTML body, and so is a genuine
 * permission failure, so the status alone cannot separate them. These markers
 * are the ones Cloudflare has kept stable across its managed-challenge and
 * JS-challenge pages.
 */
export function looksLikeChallenge(body: string): boolean {
  const head = body.slice(0, 4000).toLowerCase();
  return (
    head.includes("just a moment") ||
    head.includes("cf-browser-verification") ||
    head.includes("cf_chl_opt") ||
    head.includes("challenges.cloudflare.com") ||
    head.includes("enable javascript and cookies to continue")
  );
}

/** Is this the sign-in page, or a body that only makes sense when logged out? */
export function looksSignedOut(body: string, status: number): boolean {
  if (status === 401) return true;
  const head = body.slice(0, 4000).toLowerCase();
  return (
    head.includes('"error":"unauthorized"') ||
    head.includes("you must be logged in") ||
    (head.includes("<html") && head.includes("/auth/signin"))
  );
}

/** Pull a human-usable message out of whatever came back. */
export function describeBody(body: string): string {
  const text = body.trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      for (const key of ["message", "error", "detail", "reason"]) {
        const value = record[key];
        if (typeof value === "string" && value) return value.slice(0, 500);
      }
    }
    return text.slice(0, 500);
  } catch {
    // HTML or plain text. Strip tags so an error page does not drown the message.
    return text
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
  }
}

/** Turn a page-side response into the right error class. */
export function errorFor(status: number, endpoint: string, body: string): MidjourneyError {
  const detail = describeBody(body);

  if (looksLikeChallenge(body)) {
    return new ChallengeError(
      `Cloudflare served a challenge instead of ${endpoint}. Open the Midjourney window this server controls and let the check finish, then try again. Run \`midjourney-cli doctor\` to see the browser state.`,
      status,
      endpoint,
      detail,
    );
  }

  if (looksSignedOut(body, status)) {
    return new NotSignedInError(
      `The browser profile is not signed in to Midjourney, so ${endpoint} was refused. Run \`midjourney-cli login\` to open the window and sign in once. The session then persists.`,
      status,
      endpoint,
      detail,
    );
  }

  if (status === 429) {
    return new RateLimitError(
      `Midjourney rate limited ${endpoint}. The client already spaces requests out and retries; this failed after the last attempt.`,
      status,
      endpoint,
      detail,
    );
  }
  if (status === 402) {
    return new RateLimitError(
      `Midjourney refused ${endpoint} for billing reasons. This usually means the plan is out of fast hours, or the subscription lapsed.`,
      status,
      endpoint,
      detail,
    );
  }
  if (status === 403) {
    return new NotSignedInError(
      `Midjourney refused ${endpoint} for this account. Either the session lapsed, or the plan does not include this feature.`,
      status,
      endpoint,
      detail,
    );
  }
  if (status === 400 || status === 422) {
    return new ValidationError(
      `Midjourney rejected the request to ${endpoint}. ${detail || "Check the prompt and its parameters."}`,
      status,
      endpoint,
      detail,
    );
  }
  if (status === 404) {
    return new NotFoundError(
      `Not found via ${endpoint}. Check the job id. A job belonging to another account looks the same as one that never existed.`,
      status,
      endpoint,
      detail,
    );
  }
  if (status >= 500) {
    return new ServerError(
      `Midjourney returned ${status} for ${endpoint}. This is upstream and usually transient.`,
      status,
      endpoint,
      detail,
    );
  }
  return new MidjourneyError(`Midjourney returned ${status} for ${endpoint}.`, status, endpoint, detail);
}

/** Statuses worth another attempt. */
export const RETRYABLE = new Set([429, 500, 502, 503, 504]);
