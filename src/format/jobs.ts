/**
 * Normalising jobs out of an API with no contract.
 *
 * Everything here is defensive on purpose. Midjourney's web endpoints are not
 * published, are not versioned and have already changed field names more than
 * once, so anything that assumes an exact shape will break on a Tuesday for
 * reasons nobody can debug from a stack trace.
 *
 * The rule this file follows: read what is recognisable, keep the untouched
 * original alongside it, and never throw because a field moved. A tool that
 * returns a job with a missing prompt is still useful. A tool that throws
 * because `image_paths` became `imagePaths` is not.
 */

export type JobStatus = "queued" | "running" | "completed" | "failed" | "moderated" | "unknown";

export type Job = {
  id: string;
  status: JobStatus;
  /** The raw status string, because ours is a lossy mapping. */
  rawStatus?: string;
  prompt?: string;
  fullCommand?: string;
  /** Direct URLs to the rendered images, when the job has finished. */
  images: string[];
  createdAt?: string;
  finishedAt?: string;
  /** Percentage, when the app reported one. */
  progress?: number;
  eventType?: string;
  parentId?: string;
  width?: number;
  height?: number;
  /** How many images the job rendered. 4 for a normal grid. */
  batchSize?: number;
  /** Midjourney's own name for the job, e.g. `v8-1_diffusion`. */
  jobType?: string;
  /** True when the job rendered video rather than stills. */
  isVideo?: boolean;
  /** Whatever else came back, untouched. */
  raw: Record<string, unknown>;
};

const TERMINAL: ReadonlySet<JobStatus> = new Set(["completed", "failed", "moderated"]);

export const CDN_ORIGIN = "https://cdn.midjourney.com";

/**
 * Where a finished job's images live.
 *
 * The history endpoint returns no image URLs at all, only the job id and a
 * `batch_size`. The assets sit at a predictable path, which is how the web app
 * renders a grid without a second request per tile. Verified against a real
 * job: `<id>/0_0.png` is the full-resolution render, matching the `width` and
 * `height` on the record.
 *
 * This is a derived URL, not a documented one. If Midjourney moves its assets
 * these stop resolving, which is why `download_job` reports per-image failures
 * rather than throwing the batch away.
 */
/**
 * Where a finished video's files live.
 *
 * Videos do not follow the image pattern: they sit under a `/video/` path and
 * are numbered without the grid prefix. Deriving `.png` names for a video job
 * yields four URLs that all 404, which is what `download_job` did before.
 */
export function videoUrlsFor(jobId: string, count: number): string[] {
  const n = Number.isFinite(count) && count > 0 ? Math.min(Math.trunc(count), 8) : 1;
  return Array.from({ length: n }, (_, index) => `${CDN_ORIGIN}/video/${jobId}/${index}.mp4`);
}

export function imageUrlsFor(jobId: string, batchSize: number): string[] {
  const count = Number.isFinite(batchSize) && batchSize > 0 ? Math.min(Math.trunc(batchSize), 16) : 1;
  return Array.from({ length: count }, (_, index) => `${CDN_ORIGIN}/${jobId}/0_${index}.png`);
}

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL.has(status);
}

export function normaliseStatus(value: unknown): { status: JobStatus; raw?: string } {
  if (typeof value !== "string") return { status: "unknown" };
  const raw = value.toLowerCase();

  if (["completed", "complete", "done", "success", "succeeded"].includes(raw)) {
    return { status: "completed", raw: value };
  }
  if (["running", "in_progress", "in-progress", "processing", "started"].includes(raw)) {
    return { status: "running", raw: value };
  }
  if (["pending", "queued", "waiting", "submitted", "enqueued"].includes(raw)) {
    return { status: "queued", raw: value };
  }
  if (["failed", "failure", "error", "cancelled", "canceled"].includes(raw)) {
    return { status: "failed", raw: value };
  }
  if (["moderated", "rejected", "flagged", "unqualified", "banned_prompt"].includes(raw)) {
    return { status: "moderated", raw: value };
  }
  return { status: "unknown", raw: value };
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value)) return Number(value);
  }
  return undefined;
}

/** Every image URL we can find on a job record, in order, deduplicated. */
export function extractImages(record: Record<string, unknown>): string[] {
  const found: string[] = [];

  const push = (value: unknown): void => {
    if (typeof value === "string" && /^https?:\/\//i.test(value)) found.push(value);
  };

  for (const key of ["image_paths", "imagePaths", "image_urls", "imageUrls", "images", "urls"]) {
    const value = record[key];
    if (Array.isArray(value)) for (const item of value) push(item);
  }
  for (const key of ["image_path", "imagePath", "image_url", "imageUrl", "url", "uri"]) {
    push(record[key]);
  }

  return [...new Set(found)];
}

export function normaliseJob(input: unknown): Job | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;

  const id = firstString(record, ["id", "job_id", "jobId", "uuid"]);
  if (!id) return undefined;

  // `current_status` is the authoritative field, returned by /api/job-status.
  // The others are fallbacks for records that come from the history feed, which
  // carries no status at all. `event_type` is last because it describes what
  // KIND of job this is ("diffusion"), not how it is going, so reading it as a
  // status is a guess and it is only better than nothing.
  const { status, raw } = normaliseStatus(
    record.current_status ?? record.status ?? record.state ?? record.job_status ?? record.event_type,
  );

  const job: Job = {
    id,
    status,
    images: extractImages(record),
    raw: record,
  };

  if (raw) job.rawStatus = raw;

  const prompt = firstString(record, ["prompt", "text_prompt", "textPrompt", "full_command"]);
  if (prompt) job.prompt = prompt;

  const fullCommand = firstString(record, ["full_command", "fullCommand", "command"]);
  if (fullCommand) job.fullCommand = fullCommand;

  const createdAt = firstString(record, ["enqueue_time", "enqueueTime", "created_at", "createdAt"]);
  if (createdAt) job.createdAt = createdAt;

  const finishedAt = firstString(record, ["finish_time", "finishTime", "completed_at", "updated_at"]);
  if (finishedAt) job.finishedAt = finishedAt;

  const progress = firstNumber(record, ["progress", "percentage_complete", "percent"]);
  if (progress !== undefined) job.progress = progress;

  const eventType = firstString(record, ["event_type", "eventType", "type"]);
  if (eventType) job.eventType = eventType;

  const parentId = firstString(record, ["parent_id", "parentId", "parent_grid"]);
  if (parentId) job.parentId = parentId;

  const width = firstNumber(record, ["width"]);
  if (width !== undefined) job.width = width;

  const height = firstNumber(record, ["height"]);
  if (height !== undefined) job.height = height;

  const jobType = firstString(record, ["job_type", "jobType"]);
  if (jobType) job.jobType = jobType;

  const batchSize = firstNumber(record, ["batch_size", "batchSize"]);
  if (batchSize !== undefined) job.batchSize = batchSize;

  // A video job is recognisable by its type, and its files are elsewhere.
  const isVideo = /video|_i2v_/i.test(`${jobType ?? ""} ${record.event_type ?? ""}`);
  if (isVideo) job.isVideo = true;

  // Neither endpoint returns file URLs. Derive them when the record says how
  // many were rendered, so a finished job is usable rather than reported as
  // having produced nothing.
  if (job.images.length === 0) {
    if (isVideo) {
      const segments = Array.isArray(record.video_segments) ? record.video_segments.length : 1;
      job.images = videoUrlsFor(job.id, Math.max(segments, batchSize ?? 1));
    } else if (batchSize !== undefined && batchSize > 0) {
      job.images = imageUrlsFor(job.id, batchSize);
    }
  }

  // A job with images but no recognisable status has finished, whatever the app
  // is calling it this month.
  if (job.status === "unknown" && job.images.length > 0) job.status = "completed";

  return job;
}

/**
 * Find the job array inside whatever envelope came back.
 *
 * The app has returned a bare array, `{jobs: []}`, `{data: []}` and
 * `{results: []}` at different times. Rather than track which, look for the
 * first array whose members look like jobs.
 */
export function extractJobs(payload: unknown, depth = 0): Job[] {
  if (depth > 4 || payload === null || payload === undefined) return [];

  if (Array.isArray(payload)) {
    const jobs = payload.map(normaliseJob).filter((job): job is Job => job !== undefined);
    return jobs;
  }

  if (typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;

  for (const key of ["jobs", "data", "results", "items", "grids"]) {
    if (key in record) {
      const jobs = extractJobs(record[key], depth + 1);
      if (jobs.length > 0) return jobs;
    }
  }

  // A single job returned bare.
  const single = normaliseJob(record);
  if (single) return [single];

  for (const value of Object.values(record)) {
    const jobs = extractJobs(value, depth + 1);
    if (jobs.length > 0) return jobs;
  }
  return [];
}

/** The compact shape tools return, so a model is not handed forty raw fields. */
export function summariseJob(job: Job): Record<string, unknown> {
  return {
    id: job.id,
    status: job.status,
    ...(job.rawStatus && job.rawStatus.toLowerCase() !== job.status ? { raw_status: job.rawStatus } : {}),
    ...(job.prompt ? { prompt: job.prompt } : {}),
    ...(job.progress !== undefined ? { progress: job.progress } : {}),
    ...(job.createdAt ? { created_at: job.createdAt } : {}),
    ...(job.finishedAt ? { finished_at: job.finishedAt } : {}),
    ...(job.parentId ? { parent_id: job.parentId } : {}),
    ...(job.width && job.height ? { size: `${job.width}x${job.height}` } : {}),
    ...(job.jobType ? { job_type: job.jobType } : {}),
    ...(job.isVideo ? { is_video: true } : {}),
    image_count: job.images.length,
    ...(job.images.length > 0 ? { images: job.images } : {}),
  };
}
