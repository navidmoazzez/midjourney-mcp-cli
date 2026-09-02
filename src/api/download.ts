/**
 * Getting the actual files onto disk.
 *
 * Worth spelling out why this is not a fetch. Midjourney's CDN refuses plain
 * server-side clients, and it does not send CORS headers that would let a
 * script inside midjourney.com read the bytes either. Both obvious routes are
 * closed, which is why the reference CLI for this API falls back to
 * screenshotting the rendered <img> element.
 *
 * A screenshot is not the file. It is re-encoded, clipped to the element box at
 * whatever size the page happened to lay it out, and stripped of everything the
 * original carried. Downloading a 2048px upscale and getting a 512px PNG of how
 * it looked in a browser window is not a download.
 *
 * Navigating a throwaway tab straight to the asset and reading the bytes back
 * out of the resource cache avoids both problems: a top-level navigation is not
 * a cross-origin subresource request, so CORS does not apply, and the browser
 * is a browser, so the CDN serves it.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

import type { MidjourneyClient } from "./client.js";
import { MidjourneyError, NotFoundError, ValidationError } from "./errors.js";
import { findJob } from "./jobs.js";
import { mimeFromUrl } from "../transport/cdp.js";

export type SavedFile = {
  url: string;
  path: string;
  bytes: number;
  mime_type: string;
};

/** A filesystem-safe name derived from the asset URL, falling back to the job id. */
export function fileNameFor(url: string, jobId: string, index: number): string {
  let candidate = "";
  try {
    candidate = basename(new URL(url).pathname);
  } catch {
    candidate = "";
  }

  const extension = extname(candidate) || extensionFor(mimeFromUrl(url));
  const stem = candidate ? candidate.slice(0, candidate.length - extname(candidate).length) : "";

  // Midjourney names most assets `0_<index>.png`, which collides across every
  // job in a folder, so the job id goes in front. The stem itself is dropped
  // when it is just the grid position again: `<job>-0-0_0.png` says nothing
  // that `<job>-0.png` does not.
  const redundant = /^\d+_\d+$/.test(stem);
  const safeStem = redundant ? "" : stem.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 60);
  return `${jobId}-${index}${safeStem ? `-${safeStem}` : ""}${extension}`;
}

function extensionFor(mime: string): string {
  switch (mime) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "video/mp4":
      return ".mp4";
    case "video/webm":
      return ".webm";
    default:
      return ".bin";
  }
}

/** Download one URL to a directory. */
export async function saveUrl(
  client: MidjourneyClient,
  url: string,
  outDir: string,
  fileName: string,
): Promise<SavedFile> {
  if (!/^https?:\/\//i.test(url)) {
    throw new ValidationError(`Not a downloadable URL: '${url}'.`, 0, "(local)");
  }

  const { base64, mimeType } = await client.transport.fetchBinary(url);
  const buffer = Buffer.from(base64, "base64");

  if (buffer.byteLength === 0) {
    throw new MidjourneyError(
      `The browser fetched ${url} but the body was empty. The asset may have expired, or the session may not have access to it.`,
      0,
      "(download)",
    );
  }

  const directory = resolve(outDir);
  await mkdir(directory, { recursive: true });
  const path = join(directory, fileName);
  await writeFile(path, buffer);

  return { url, path, bytes: buffer.byteLength, mime_type: mimeType };
}

export type DownloadJobOptions = {
  /** Which images to take. Omitted means all of them. */
  indexes?: number[];
  outDir?: string;
};

/** Download every rendered image on a job, or a chosen subset. */
export async function downloadJob(
  client: MidjourneyClient,
  jobId: string,
  options: DownloadJobOptions = {},
): Promise<{ job_id: string; saved: SavedFile[]; skipped: string[] }> {
  const job = await findJob(client, jobId);
  if (!job) {
    throw new NotFoundError(
      `No job ${jobId} in this account's recent history. Only jobs still in the imagine feed can be resolved; older work has to be downloaded from the web app.`,
      404,
      "(download)",
    );
  }
  if (job.images.length === 0) {
    throw new NotFoundError(
      `Job ${jobId} has no rendered images. Its status is '${job.status}'${job.rawStatus ? ` (${job.rawStatus})` : ""}, so it may still be running, or it may have been moderated.`,
      404,
      "(download)",
    );
  }

  const wanted =
    options.indexes && options.indexes.length > 0
      ? options.indexes
      : job.images.map((_, index) => index);

  const outDir = options.outDir ?? client.config.downloadDir;
  const saved: SavedFile[] = [];
  const skipped: string[] = [];

  for (const index of wanted) {
    const url = job.images[index];
    if (!url) {
      skipped.push(`index ${index}: this job has ${job.images.length} image(s)`);
      continue;
    }
    try {
      saved.push(await saveUrl(client, url, outDir, fileNameFor(url, job.id, index)));
    } catch (error) {
      skipped.push(`index ${index}: ${(error as Error).message}`);
    }
  }

  return { job_id: job.id, saved, skipped };
}
