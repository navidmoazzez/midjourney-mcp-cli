/**
 * The one place every Midjourney request goes through.
 *
 * Midjourney publishes no API. These are the same JSON endpoints its web app
 * calls, reached from inside a real logged-in page, and they can change shape
 * without notice. Routing everything through one client means an upstream
 * change is fixed in one file rather than thirty.
 *
 * What this adds over calling the transport directly:
 *   - pacing. The web app does not fire requests back to back, so neither do
 *     we. A jittered floor between calls is the difference between a session
 *     that lasts and one that trips a bot heuristic.
 *   - retries with backoff on the two failures that resolve by waiting.
 *   - a real deadline on every call.
 *   - one classification step, so a Cloudflare interstitial, a logged-out
 *     redirect and a genuine 403 stop looking identical.
 */

import type { Config } from "../config.js";
import { CdpBrowser } from "../transport/cdp.js";
import {
  MidjourneyError,
  RETRYABLE,
  TimeoutError,
  errorFor,
  looksLikeChallenge,
} from "./errors.js";

export type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Skip the retry loop, for calls where a second attempt would double an effect. */
  noRetry?: boolean;
};

/** Endpoints observed to carry the signed-in user's own id. */
const USER_ID_ENDPOINTS = ["/api/moodboards", "/api/personalized-profiles", "/api/user-queue"];

export class MidjourneyClient {
  readonly config: Config;
  private readonly browser: CdpBrowser;
  private lastRequestAt = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private cachedUserId?: string;

  constructor(config: Config, browser?: CdpBrowser) {
    this.config = config;
    this.browser =
      browser ??
      new CdpBrowser({
        cdpUrl: config.cdpUrl,
        profileDir: config.profileDir,
        chromePath: config.chromePath,
        autoLaunch: config.autoLaunch,
        headless: config.headless,
        timeoutMs: config.requestTimeoutMs,
        origin: config.origin,
      });
  }

  get transport(): CdpBrowser {
    return this.browser;
  }

  /**
   * Space requests out, serialised through a promise chain so concurrent tool
   * calls queue rather than all firing at once.
   *
   * The jitter matters. A request every 700ms exactly is a signature no human
   * produces; spreading it over a range is both closer to real use and cheap.
   */
  private throttle<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const floor = this.config.minRequestIntervalMs;
      if (floor > 0) {
        const jitter = Math.floor(Math.random() * floor * 0.4);
        const waitFor = this.lastRequestAt + floor + jitter - Date.now();
        if (waitFor > 0) await sleep(waitFor);
      }
      this.lastRequestAt = Date.now();
      return work();
    });
    // Keep the chain alive even when one call rejects, or every later call
    // inherits that rejection.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private buildPath(path: string, query?: RequestOptions["query"]): string {
    if (!query) return path;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === "") continue;
      params.set(key, String(value));
    }
    const qs = params.toString();
    return qs ? `${path}${path.includes("?") ? "&" : "?"}${qs}` : path;
  }

  /** Issue one request and return the parsed JSON body. */
  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const target = this.buildPath(path, options.query);
    const attempts = options.noRetry ? 1 : this.config.maxRetries + 1;
    let lastError: MidjourneyError | undefined;

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        // Exponential with jitter, capped, so a burst of retries does not become
        // its own rate-limit problem.
        const backoff = Math.min(1000 * 2 ** (attempt - 1), 15_000);
        await sleep(backoff + Math.floor(Math.random() * 500));
      }

      const response = await this.throttle(() =>
        this.browser.apiFetch(target, {
          method: options.method ?? "GET",
          body: options.body,
          headers: options.headers,
        }),
      );

      if (response.networkError) {
        lastError = new MidjourneyError(
          `The browser could not reach ${target}: ${response.networkError}`,
          0,
          target,
          response.networkError,
        );
        continue;
      }

      if (response.ok && !looksLikeChallenge(response.body)) {
        return parseJson<T>(response.body, target);
      }

      const error = errorFor(response.status, target, response.body);
      lastError = error;

      // A challenge and a rate limit both clear on their own; everything else
      // will fail identically on a second attempt, so stop.
      const worthRetrying = RETRYABLE.has(response.status) || error.name === "ChallengeError";
      if (!worthRetrying) throw error;
    }

    throw lastError ?? new TimeoutError(`No response from ${target}.`, 0, target);
  }

  /**
   * Midjourney's own id for the signed-in user.
   *
   * Several endpoints want it and the web app has it in memory, so rather than
   * ask the user to dig it out of DevTools we read it from the page. The shapes
   * below are the ones the app has used; none is contractual, so this is
   * best-effort and MIDJOURNEY_USER_ID overrides it when the app moves again.
   */
  async userId(): Promise<string> {
    if (this.config.userId) return this.config.userId;
    if (this.cachedUserId) return this.cachedUserId;

    const found = await this.probeUserId();
    if (!found) {
      throw new MidjourneyError(
        "Could not work out the Midjourney user id from the page. Open midjourney.com in the controlled window, confirm you are signed in, then set MIDJOURNEY_USER_ID if this keeps happening.",
        0,
        "(local)",
      );
    }
    this.cachedUserId = found;
    return found;
  }

  /**
   * Two strategies, cheapest first.
   *
   * The endpoints all take a user id and none of them returns one, so reading a
   * response only works when some unrelated field happens to carry it. The app
   * itself has always known: it is in the Next.js payload the page booted with.
   * Neither route is contractual, which is why MIDJOURNEY_USER_ID exists.
   */
  private async probeUserId(): Promise<string | undefined> {
    const fromPage = await this.probeUserIdFromPage().catch(() => undefined);
    if (fromPage) return fromPage;

    // Endpoints that carry a user_id, cheapest first. user-queue is checked
    // last and rarely helps: it answers with the queue and nothing else, which
    // is why the first version of this probe never worked.
    for (const path of USER_ID_ENDPOINTS) {
      const response = await this.throttle(() => this.browser.apiFetch(path, { method: "GET" }));
      if (!response.ok) continue;
      const guess = findUserId(safeParse(response.body));
      if (guess) return guess;
    }
    return undefined;
  }

  /** Read the id out of the running app's own state. */
  private async probeUserIdFromPage(): Promise<string | undefined> {
    const expression = `(() => {
      const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const KEYS = ['userId', 'user_id', 'id', 'midjourney_id', 'mjUserId'];
      const seen = new Set();

      const walk = (value, depth) => {
        if (depth > 8 || value === null || typeof value !== 'object') return undefined;
        if (seen.has(value)) return undefined;
        seen.add(value);
        if (Array.isArray(value)) {
          for (const item of value) {
            const found = walk(item, depth + 1);
            if (found) return found;
          }
          return undefined;
        }
        for (const key of KEYS) {
          const candidate = value[key];
          if (typeof candidate === 'string' && UUID.test(candidate.replace(/^singleplayer_/, ''))) {
            return candidate.replace(/^singleplayer_/, '');
          }
        }
        for (const nested of Object.values(value)) {
          const found = walk(nested, depth + 1);
          if (found) return found;
        }
        return undefined;
      };

      const next = document.getElementById('__NEXT_DATA__');
      if (next && next.textContent) {
        try {
          const found = walk(JSON.parse(next.textContent), 0);
          if (found) return found;
        } catch {}
      }

      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (!key) continue;
          const raw = localStorage.getItem(key);
          if (!raw) continue;
          if (UUID.test(raw)) return raw;
          if (raw.startsWith('{') || raw.startsWith('[')) {
            try {
              const found = walk(JSON.parse(raw), 0);
              if (found) return found;
            } catch {}
          }
        }
      } catch {}

      return undefined;
    })()`;

    const found = await this.browser.evaluateInPage<string | undefined>(expression);
    return typeof found === "string" && looksLikeMidjourneyId(found) ? found : undefined;
  }

  close(): void {
    this.browser.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseJson<T>(body: string, endpoint: string): T {
  if (body.trim() === "") return undefined as T;
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new MidjourneyError(
      `${endpoint} answered with something that is not JSON. The endpoint may have moved, or the session may have been bounced to a sign-in page.`,
      200,
      endpoint,
      body.slice(0, 300),
    );
  }
}

/** Walk a response looking for anything that reads like the user's own id. */
export function findUserId(value: unknown, depth = 0): string | undefined {
  if (depth > 6 || value === null || typeof value !== "object") return undefined;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUserId(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }

  const record = value as Record<string, unknown>;
  // Only the explicitly-named keys. A bare `id` is almost never the account:
  // /api/folders returns folders whose `id` is the folder, and taking it would
  // silently use a folder id as the user id on every call after this one.
  for (const key of ["user_id", "userId"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && looksLikeMidjourneyId(candidate)) {
      return candidate.replace(/^singleplayer_/, "");
    }
  }
  for (const nested of Object.values(record)) {
    const found = findUserId(nested, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** Midjourney ids are UUIDs, sometimes with a `singleplayer_` prefix. */
export function looksLikeMidjourneyId(value: string): boolean {
  return /^(singleplayer_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
