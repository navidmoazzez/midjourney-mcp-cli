/**
 * Getting files onto disk.
 *
 * These are `risk: "write"`, not read. Nothing changes at Midjourney, but they
 * write to the local filesystem, and a client deciding what to auto-approve
 * should be told that.
 */

import { z } from "zod";

import { downloadJob, fileNameFor, saveUrl } from "../api/download.js";
import { defineTool } from "./kit.js";

export const downloadTools = [
  defineTool({
    name: "download_job",
    title: "Save a job's images to disk",
    description:
      "Download the finished images from a job and write them to disk, returning the local paths and byte counts.\n\nThese are the real files as the CDN served them, not screenshots: full resolution, original encoding. Files are named `<job-id>-<index>.png` so a directory of downloads from different jobs stays usable.\n\nMidjourney's CDN refuses ordinary HTTP clients, so this goes through the browser. Expect a second or two per image.",
    schema: {
      job_id: z.string().describe("The job whose images to download."),
      indexes: z
        .array(z.number().int().min(0))
        .optional()
        .describe("Which images to take, zero-based. Omit for all of them."),
      out_dir: z
        .string()
        .optional()
        .describe("Directory to write into, created if needed. Defaults to MIDJOURNEY_DOWNLOAD_DIR."),
    },
    risk: "write",
    idempotent: true,
    summary: (args) => `download images from job ${String(args.job_id)}`,
    handler: async (args, ctx) =>
      downloadJob(ctx.client, args.job_id, { indexes: args.indexes, outDir: args.out_dir }),
  }),

  defineTool({
    name: "download_url",
    title: "Save one Midjourney asset by URL",
    description:
      "Download a single Midjourney asset by its direct URL. For image URLs already in hand, from list_jobs, explore_feed or a moodboard, where going back through a job id would be a detour.\n\nOnly useful for URLs the signed-in browser session can reach.",
    schema: {
      url: z.string().describe("Direct URL to the asset."),
      out_dir: z.string().optional().describe("Directory to write into. Defaults to MIDJOURNEY_DOWNLOAD_DIR."),
      file_name: z.string().optional().describe("Override the filename. Derived from the URL otherwise."),
    },
    risk: "write",
    idempotent: true,
    summary: (args) => `download ${String(args.url).slice(0, 100)}`,
    handler: async (args, ctx) =>
      saveUrl(
        ctx.client,
        args.url,
        args.out_dir ?? ctx.config.downloadDir,
        args.file_name ?? fileNameFor(args.url, "asset", 0),
      ),
  }),
];
