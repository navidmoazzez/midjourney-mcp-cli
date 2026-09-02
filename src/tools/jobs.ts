/** Reading what the account has made and what it is making now. */

import { z } from "zod";

import { ENDPOINTS, findJob, jobUpdates, listJobs, waitForJob } from "../api/jobs.js";
import { NotFoundError } from "../api/errors.js";
import { summariseJob } from "../format/jobs.js";
import { clamp, defineTool, pageArgs } from "./kit.js";

export const jobTools = [
  defineTool({
    name: "list_jobs",
    title: "List recent generations",
    description:
      "List the account's recent Midjourney jobs, newest first, with their status and the URLs of any finished images.\n\nThis is the account's own history, not the public feed. Use explore_feed for other people's work.",
    schema: {
      ...pageArgs,
      status: z
        .enum(["queued", "running", "completed", "failed", "moderated"])
        .optional()
        .describe("Only return jobs in this state. Filtered here, since the endpoint has no filter."),
      include_raw: z
        .boolean()
        .optional()
        .describe(
          "Return the untouched API response alongside the parsed jobs. Useful when a field looks wrong and you need to see what actually came back.",
        ),
    },
    risk: "read",
    handler: async (args, ctx) => {
      const limit = clamp(args.limit, 25);
      const { jobs, raw } = await listJobs(ctx.client, { limit, cursor: args.cursor });
      const filtered = args.status ? jobs.filter((job) => job.status === args.status) : jobs;
      return {
        count: filtered.length,
        jobs: filtered.map(summariseJob),
        ...(args.include_raw ? { raw } : {}),
      };
    },
  }),

  defineTool({
    name: "get_job",
    title: "Look up one job",
    description:
      "Look up a single job by id and return its status and image URLs. Checks the live update feed first, then recent history.\n\nOnly jobs still in the account's recent feed can be resolved this way. Older work has to be opened in the web app.",
    schema: {
      job_id: z.string().describe("The job id, a UUID."),
      include_raw: z.boolean().optional().describe("Also return the untouched job record."),
    },
    risk: "read",
    handler: async (args, ctx) => {
      const job = await findJob(ctx.client, args.job_id);
      if (!job) {
        throw new NotFoundError(
          `No job ${args.job_id} in this account's recent history.`,
          404,
          ENDPOINTS.jobs,
        );
      }
      return { ...summariseJob(job), ...(args.include_raw ? { raw: job.raw } : {}) };
    },
  }),

  defineTool({
    name: "wait_for_job",
    title: "Wait for a job to finish",
    description:
      "Block until a job reaches a finished, failed or moderated state, then return it with its image URLs.\n\nThe poll interval widens as the wait goes on, so a long relax-mode job does not turn into hundreds of requests. Times out after MIDJOURNEY_JOB_TIMEOUT_MS, ten minutes by default; a timeout does not cancel the job, it is still running.",
    schema: {
      job_id: z.string().describe("The job id to wait on."),
      timeout_ms: z
        .number()
        .optional()
        .describe("Give up after this long. Defaults to MIDJOURNEY_JOB_TIMEOUT_MS."),
    },
    risk: "read",
    handler: async (args, ctx) =>
      summariseJob(await waitForJob(ctx.client, args.job_id, { timeoutMs: args.timeout_ms })),
  }),

  defineTool({
    name: "get_queue",
    title: "Show what is running now",
    description:
      "Show the account's current Midjourney queue: what is running, what is waiting, and how much concurrency the plan allows.\n\nThe first thing to check when a submitted job is not appearing. Accounts have a concurrent-job limit, and work past it silently queues behind the rest.",
    schema: {},
    risk: "read",
    handler: async (_args, ctx) => ctx.client.request(ENDPOINTS.queue),
  }),

  defineTool({
    name: "job_updates",
    title: "Poll the live update feed",
    description:
      "Poll the feed the web app itself watches while work is in flight. Returns jobs whose state has changed recently.\n\nPass the checkpoint from a previous response to get only what has changed since. Most callers want wait_for_job instead, which drives this loop for you.",
    schema: {
      ...pageArgs,
      checkpoint: z.string().optional().describe("Checkpoint token from a previous response."),
    },
    risk: "read",
    handler: async (args, ctx) => {
      const { jobs, raw } = await jobUpdates(ctx.client, {
        limit: clamp(args.limit, 25),
        checkpoint: args.checkpoint,
      });
      return { count: jobs.length, jobs: jobs.map(summariseJob), raw };
    },
  }),
];
