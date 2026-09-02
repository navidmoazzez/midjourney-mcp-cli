/**
 * Submitting work and following it to the end.
 *
 * This is the part the reference CLI for this API does not have, and it is the
 * part that makes the difference between a toy and something an agent can use.
 * Submitting returns a job id in about a second; the image does not exist for
 * another thirty to ninety. A tool that returns the id and stops has handed the
 * caller a polling loop to write, and a model asked to "make me a logo" will
 * either return an id nobody can use or invent a wait and guess wrong.
 *
 * So submission and completion are one operation here, with the polling,
 * back-off and terminal-state detection on this side of the boundary.
 */

import type { MidjourneyClient } from "./client.js";
import { JobTimeoutError, MidjourneyError, ValidationError } from "./errors.js";
import { extractJobs, isTerminal, type Job } from "../format/jobs.js";

export type Speed = "fast" | "relax" | "turbo";

export const ENDPOINTS = {
  submit: "/api/submit-jobs",
  jobs: "/api/imagine",
  updates: "/api/imagine-update",
  queue: "/api/user-queue",
  folders: "/api/folders",
  moodboards: "/api/moodboards",
  storage: "/api/storage",
  explore: "/api/explore",
  exploreStyleLikes: "/api/explore-styles-likes",
  personalizedProfiles: "/api/personalized-profiles",
  following: "/api/following-for-user",
  modelRatings: "/api/model-ratings",
  contestsRankingCount: "/api/contests-ranking-count",
  jobStatus: "/api/job-status",
} as const;

/** `singleplayer_<uuid>` is what the web app calls a solo user's own channel. */
export function channelIdFor(userId: string): string {
  const trimmed = userId.trim();
  return trimmed.startsWith("singleplayer_") ? trimmed : `singleplayer_${trimmed}`;
}

export type SubmitOptions = {
  speed?: Speed;
  /**
   * Reload the open window once the request lands.
   *
   * Off for a call that is about to wait: reloading tears down the page context
   * the poll loop is talking to, so every poll then pays for a reconnect and an
   * eleven-second job takes minutes. A waiting caller refreshes once at the end
   * instead, which is also the only moment there is anything to look at.
   */
  refresh?: boolean;
  private?: boolean;
  /** Counts the web app reports alongside a submission. */
  imagePromptCount?: number;
  styleRefCount?: number;
  omniRefCount?: number;
};

function metadataFor(options: SubmitOptions): Record<string, unknown> {
  return {
    isMobile: null,
    imagePrompts: options.imagePromptCount ?? 0,
    imageReferences: options.styleRefCount ?? 0,
    characterReferences: options.omniRefCount ?? 0,
    depthReferences: 0,
    lightboxOpen: null,
  };
}

/** Job ids out of a submission response, whatever it is wrapped in. */
export function extractJobIds(payload: unknown, depth = 0): string[] {
  if (depth > 5 || payload === null || payload === undefined) return [];

  if (typeof payload === "string") {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload)
      ? [payload]
      : [];
  }
  if (Array.isArray(payload)) {
    return payload.flatMap((item) => extractJobIds(item, depth + 1));
  }
  if (typeof payload !== "object") return [];

  const record = payload as Record<string, unknown>;
  const found: string[] = [];
  for (const key of ["job_id", "jobId", "id", "success_jobs", "jobs"]) {
    if (key in record) found.push(...extractJobIds(record[key], depth + 1));
  }
  if (found.length === 0) {
    for (const value of Object.values(record)) found.push(...extractJobIds(value, depth + 1));
  }
  return [...new Set(found)];
}

/** Submit an imagine. Returns the job ids Midjourney accepted. */
export async function submitImagine(
  client: MidjourneyClient,
  prompt: string,
  options: SubmitOptions = {},
): Promise<{ jobIds: string[]; raw: unknown }> {
  const userId = await client.userId();
  const body = {
    f: { mode: options.speed ?? client.config.defaultSpeed, private: options.private ?? false },
    channelId: channelIdFor(userId),
    metadata: metadataFor(options),
    t: "imagine",
    prompt,
  };

  // Never retried. A retry after a timeout would submit a second job and charge
  // for it, and there is no way from here to tell a lost response from a lost
  // request.
  const raw = await client.request<unknown>(ENDPOINTS.submit, {
    method: "POST",
    body,
    noRetry: true,
  });

  refreshView(client, options.refresh !== false);
  return { jobIds: extractJobIds(raw), raw };
}

/**
 * Nudge the open window, without ever letting it affect the result.
 *
 * Deliberately not awaited: the generation has already been paid for by the
 * time this runs, and a cosmetic reload must not be able to turn a successful
 * submission into a thrown error.
 */
function refreshView(client: MidjourneyClient, enabled = true): void {
  if (!enabled || !client.config.refreshView) return;
  void client.transport.refreshView().catch(() => undefined);
}

/** Re-run an existing job, unchanged or with a new prompt. */
export async function submitRerun(
  client: MidjourneyClient,
  jobId: string,
  options: SubmitOptions & { newPrompt?: string } = {},
): Promise<{ jobIds: string[]; raw: unknown }> {
  const userId = await client.userId();
  const body = {
    f: { mode: options.speed ?? client.config.defaultSpeed, private: options.private ?? false },
    channelId: channelIdFor(userId),
    metadata: metadataFor(options),
    t: "reroll",
    newPrompt: options.newPrompt ?? null,
    id: jobId.trim(),
  };

  const raw = await client.request<unknown>(ENDPOINTS.submit, {
    method: "POST",
    body,
    noRetry: true,
  });

  refreshView(client, options.refresh !== false);
  return { jobIds: extractJobIds(raw), raw };
}

/**
 * Vary one image from a finished grid.
 *
 * Captured from the web app rather than guessed: `Vary Subtle` and `Vary
 * Strong` are the same job type with a `strong` boolean, addressing one tile by
 * `index`. Note the metadata block here is all nulls, where an imagine sends
 * counts. That difference is what the app sends, so it is what we send.
 */
export async function submitVary(
  client: MidjourneyClient,
  jobId: string,
  index: number,
  options: SubmitOptions & { strong?: boolean } = {},
): Promise<{ jobIds: string[]; raw: unknown }> {
  const userId = await client.userId();
  const body = {
    f: { mode: options.speed ?? client.config.defaultSpeed, private: options.private ?? false },
    channelId: channelIdFor(userId),
    metadata: {
      isMobile: null,
      imagePrompts: null,
      imageReferences: null,
      characterReferences: null,
      depthReferences: null,
      lightboxOpen: null,
    },
    t: "vary",
    strong: options.strong ?? false,
    v8_1_hd: null,
    v8_2_hd: null,
    id: jobId.trim(),
    index,
  };

  const raw = await client.request<unknown>(ENDPOINTS.submit, {
    method: "POST",
    body,
    noRetry: true,
  });
  refreshView(client, options.refresh !== false);
  return { jobIds: extractJobIds(raw), raw };
}

/**
 * Submit an arbitrary job type.
 *
 * The escape hatch, and deliberately not dressed up as anything else. Only
 * `imagine` and `reroll` are confirmed against observed traffic. The web app
 * sends other values of `t` for upscales and variations, but guessing at their
 * payloads and shipping them as named tools would mean charging the user for
 * requests that quietly do nothing. Capture the real traffic first:
 * `midjourney-cli capture` records what the app actually sends.
 */
export async function submitRaw(
  client: MidjourneyClient,
  jobType: string,
  extra: Record<string, unknown>,
  options: SubmitOptions = {},
): Promise<{ jobIds: string[]; raw: unknown }> {
  if (!jobType.trim()) throw new ValidationError("A job type is required.", 0, "(local)");

  const userId = await client.userId();
  const body = {
    f: { mode: options.speed ?? client.config.defaultSpeed, private: options.private ?? false },
    channelId: channelIdFor(userId),
    metadata: metadataFor(options),
    t: jobType.trim(),
    ...extra,
  };

  const raw = await client.request<unknown>(ENDPOINTS.submit, {
    method: "POST",
    body,
    noRetry: true,
  });
  refreshView(client, options.refresh !== false);
  return { jobIds: extractJobIds(raw), raw };
}

export type ListOptions = { limit?: number; cursor?: string; userId?: string };

/** Recent jobs for the signed-in account. */
export async function listJobs(client: MidjourneyClient, options: ListOptions = {}): Promise<{
  jobs: Job[];
  raw: unknown;
}> {
  const userId = options.userId ?? (await client.userId());
  const raw = await client.request<unknown>(ENDPOINTS.jobs, {
    query: {
      user_id: userId.replace(/^singleplayer_/, ""),
      page_size: options.limit ?? 25,
      cursor: options.cursor,
    },
  });
  return { jobs: extractJobs(raw), raw };
}

/** The update feed, which is what the web app polls while work is running. */
export async function jobUpdates(
  client: MidjourneyClient,
  options: ListOptions & { checkpoint?: string } = {},
): Promise<{ jobs: Job[]; raw: unknown }> {
  const userId = options.userId ?? (await client.userId());
  const raw = await client.request<unknown>(ENDPOINTS.updates, {
    query: {
      user_id: userId.replace(/^singleplayer_/, ""),
      page_size: options.limit ?? 25,
      checkpoint: options.checkpoint,
    },
  });
  return { jobs: extractJobs(raw), raw };
}

/**
 * Ask about specific jobs by id.
 *
 * The one endpoint that answers "is this done?" honestly. It carries
 * `current_status`, and it works for a job that has not reached the history
 * feed yet, which is every job while it is still rendering.
 *
 * Everything else here was built before this was found, by inferring completion
 * from whether image URLs could be derived. That inference happened to be right
 * because the history feed only lists finished work, but it could never have
 * reported "running" for anything.
 */
export async function jobStatus(client: MidjourneyClient, jobIds: string[]): Promise<Job[]> {
  if (jobIds.length === 0) return [];
  const raw = await client.request<unknown>(ENDPOINTS.jobStatus, {
    method: "POST",
    body: { jobIds, _frontend_source: "midjourney-mcp" },
  });
  return extractJobs(raw);
}

/** One job by id, asking the status endpoint first. */
export async function findJob(client: MidjourneyClient, jobId: string): Promise<Job | undefined> {
  const id = jobId.trim();

  const direct = await jobStatus(client, [id]).catch(() => []);
  const found = direct.find((job) => job.id === id);
  if (found) return found;

  // Fallbacks, for a job the status endpoint does not know: it may have been
  // submitted a moment ago, or belong to an older model line.
  const fromUpdates = await jobUpdates(client, { limit: 50 }).catch(() => undefined);
  const inUpdates = fromUpdates?.jobs.find((job) => job.id === id);
  if (inUpdates) return inUpdates;

  const fromList = await listJobs(client, { limit: 50 }).catch(() => undefined);
  return fromList?.jobs.find((job) => job.id === id);
}

export type WaitOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Called on every poll, for a CLI progress line. */
  onProgress?: (job: Job | undefined, elapsedMs: number) => void;
};

/**
 * Poll until a job reaches a terminal state.
 *
 * The interval widens as the wait goes on. A generation is quick at fast speed
 * and can be twenty minutes at relax, and polling every three seconds for
 * twenty minutes is four hundred requests nobody needs, on an endpoint we would
 * rather not be conspicuous on.
 */
export async function waitForJob(
  client: MidjourneyClient,
  jobId: string,
  options: WaitOptions = {},
): Promise<Job> {
  const timeoutMs = options.timeoutMs ?? client.config.jobTimeoutMs;
  const baseInterval = options.pollIntervalMs ?? client.config.jobPollIntervalMs;
  const startedAt = Date.now();

  for (let poll = 0; ; poll++) {
    const elapsed = Date.now() - startedAt;
    if (elapsed > timeoutMs) {
      throw new JobTimeoutError(
        `Job ${jobId} had not finished after ${Math.round(timeoutMs / 1000)}s. It may still be running: check with get_job. Relax-mode jobs regularly take longer than the default timeout, so raise MIDJOURNEY_JOB_TIMEOUT_MS if this is normal for your plan.`,
        jobId,
      );
    }

    const job = await findJob(client, jobId).catch((error: unknown) => {
      // A single failed poll is not a failed job. Keep waiting unless the
      // failure is one that will repeat forever.
      if (error instanceof MidjourneyError && ["NotSignedInError", "WriteBlockedError"].includes(error.name)) {
        throw error;
      }
      return undefined;
    });

    options.onProgress?.(job, elapsed);

    if (job && isTerminal(job.status)) {
      // Again on completion: the reload at submit time showed an empty slot,
      // this one shows the finished images.
      refreshView(client);
      return job;
    }

    // 3s, 3s, 4.5s, 6.75s ... capped at 20s.
    const interval = Math.min(baseInterval * Math.pow(1.5, Math.max(0, poll - 1)), 20_000);
    await new Promise((resolve) => setTimeout(resolve, interval));

    // No early bail-out for a job that has not appeared yet.
    //
    // `/api/imagine` is a history feed: a job shows up in it once it has
    // finished, not while it renders. So "not in the feed" is the normal state
    // for the entire render, and giving up after a handful of polls would fail
    // every relax-mode job, which is exactly when waiting matters most.
    // Verified: a fast v8.1 job is absent at t+5s and present, complete, at
    // t+10s. The only honest deadline is the timeout the caller asked for.
  }
}
