/** The account's own organised work: folders, moodboards, storage. */

import { z } from "zod";

import { ENDPOINTS } from "../api/jobs.js";
import {
  addToMoodboard,
  createMoodboard,
  listMoodboards,
  matchMoodboard,
  pickReferences,
  removeFromMoodboard,
} from "../api/moodboards.js";
import { findJob } from "../api/jobs.js";
import { NotFoundError } from "../api/errors.js";
import { confirmArg } from "./kit.js";
import { defineTool } from "./kit.js";

export const libraryTools = [
  defineTool({
    name: "list_folders",
    title: "List organise folders",
    description:
      "List the folders in the account's Organise view, the ones used to sort generations in the web app.",
    schema: {},
    risk: "read",
    handler: async (_args, ctx) => ctx.client.request(ENDPOINTS.folders),
  }),

  defineTool({
    name: "list_moodboards",
    title: "List moodboards",
    description:
      "List the account's moodboards with how many reference images each holds.\n\nA moodboard is a curated pile of images defining a look. Any of these can be passed straight to imagine as `moodboard: \"High Fashion\"`, which turns its images into style references. That is usually a better way to get a consistent look than describing it in words.\n\nBoards showing 0 images exist but are empty, so they cannot be used as a reference until something is added in the web app.",
    schema: {
      with_images: z
        .boolean()
        .optional()
        .describe("Include every image URL. Off by default: a large board is hundreds of URLs."),
    },
    risk: "read",
    handler: async (args, ctx) => {
      const boards = await listMoodboards(ctx.client);
      return {
        count: boards.length,
        moodboards: boards.map((board) => ({
          id: board.id,
          title: board.title,
          image_count: board.images.length,
          usable_as_reference: board.images.length > 0,
          ...(args.with_images ? { images: board.images.map((image) => image.url) } : {}),
        })),
      };
    },
  }),

  defineTool({
    name: "get_moodboard",
    title: "Look up one moodboard",
    description:
      "Look up a moodboard by name or id and return its reference images.\n\nPartial names work: 'High Fashion' finds 'High Fashion | Woman'. An ambiguous name is an error listing the candidates rather than a guess, because quietly picking the wrong board costs a generation to discover.\n\nUse `references` to get the sampled subset a generation would actually use, spread across the board rather than taken from the front.",
    schema: {
      moodboard: z.string().describe("Name or id. Partial names are fine when unambiguous."),
      references: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("Return this many sampled image URLs, as imagine would use them."),
    },
    risk: "read",
    handler: async (args, ctx) => {
      const board = matchMoodboard(await listMoodboards(ctx.client), args.moodboard);
      return {
        id: board.id,
        title: board.title,
        image_count: board.images.length,
        ...(board.created ? { created: board.created } : {}),
        ...(args.references
          ? { references: pickReferences(board, args.references) }
          : { images: board.images.map((image) => image.url) }),
      };
    },
  }),

  defineTool({
    name: "create_moodboard",
    title: "Create a moodboard",
    description:
      "Create a new, empty moodboard on the account.\n\nThe usual loop: create a board for a look, generate images until some are right, then add those with add_to_moodboard. From then on the board can drive new work by name, which is how a style gets reused instead of re-described.\n\nAn empty board cannot be used as a reference until it has at least one image.",
    schema: {
      title: z.string().min(1).describe("What to call it, for example 'Nordic Minimal Interiors'."),
    },
    risk: "write",
    idempotent: false,
    summary: (args) => `create moodboard '${String(args.title)}'`,
    handler: async (args, ctx) => {
      const created = await createMoodboard(ctx.client, args.title);
      return {
        ...created,
        next: "Add images with add_to_moodboard, then use it on a generation with moodboard: '<title>'.",
      };
    },
  }),

  defineTool({
    name: "add_to_moodboard",
    title: "Add images to a moodboard",
    description:
      "Add images to a moodboard, either from a job you generated or by direct URL.\n\nPass job_id to add that job's renders, optionally narrowing with indexes. Pass urls to add anything else the account can reach.\n\nThis is the step that turns a good generation into a reusable style: once the images are on a board, `moodboard: \"<title>\"` on a later generation reproduces the look without describing it again.",
    schema: {
      moodboard: z.string().describe("Name or id of the board to add to. Partial names work."),
      job_id: z.string().optional().describe("Add the renders from this job."),
      indexes: z
        .array(z.number().int().min(0))
        .optional()
        .describe("With job_id, which images to add, zero-based. Omit for all four."),
      urls: z.array(z.string()).optional().describe("Add these image URLs directly."),
    },
    // No confirmation: adding is reversible with remove_from_moodboard, and
    // gating reversible things is how a model learns to pass confirm by
    // reflex, which is exactly what the gate on spending exists to prevent.
    risk: "write",
    idempotent: false,
    summary: (args) =>
      `add ${args.job_id ? `job ${String(args.job_id)}` : `${(args.urls as string[] | undefined)?.length ?? 0} url(s)`} to moodboard '${String(args.moodboard)}'`,
    handler: async (args, ctx) => {
      const board = matchMoodboard(await listMoodboards(ctx.client), args.moodboard);

      const images: { url: string; width?: number; height?: number }[] = [];
      if (args.job_id) {
        const job = await findJob(ctx.client, args.job_id);
        if (!job) {
          throw new NotFoundError(
            `No job ${args.job_id} in this account's recent history.`,
            404,
            "(local)",
          );
        }
        const wanted = args.indexes?.length ? args.indexes : job.images.map((_, index) => index);
        for (const index of wanted) {
          const url = job.images[index];
          if (url) {
            images.push({
              url,
              ...(job.width ? { width: job.width } : {}),
              ...(job.height ? { height: job.height } : {}),
            });
          }
        }
      }
      for (const url of args.urls ?? []) images.push({ url });

      const result = await addToMoodboard(ctx.client, board.id, images);
      return {
        moodboard: { id: board.id, title: board.title },
        added: result.added,
        images: images.map((image) => image.url),
      };
    },
  }),

  defineTool({
    name: "remove_from_moodboard",
    title: "Remove images from a moodboard",
    description:
      "Remove images from a moodboard by URL.\n\nCuration is the point of a moodboard, so this is how a board stays sharp. It cannot be undone from here: the board is edited in place and there is no history, which is why it needs confirmation.",
    schema: {
      moodboard: z.string().describe("Name or id of the board. Partial names work."),
      urls: z.array(z.string()).min(1).describe("Exact image URLs to remove, as get_moodboard reports them."),
      ...confirmArg,
    },
    risk: "destructive",
    idempotent: true,
    summary: (args) =>
      `remove ${(args.urls as string[]).length} image(s) from moodboard '${String(args.moodboard)}'`,
    handler: async (args, ctx) => {
      const board = matchMoodboard(await listMoodboards(ctx.client), args.moodboard);
      const result = await removeFromMoodboard(ctx.client, board.id, args.urls);
      return { moodboard: { id: board.id, title: board.title }, removed: result.removed };
    },
  }),

  defineTool({
    name: "get_storage",
    title: "Show account storage",
    description:
      "Show the storage metadata the web app exposes: how much space the account's generations occupy against what the plan allows.",
    schema: {},
    risk: "read",
    handler: async (_args, ctx) => ctx.client.request(ENDPOINTS.storage),
  }),

  defineTool({
    name: "api_get",
    title: "Call any Midjourney web endpoint",
    description:
      "Issue a GET against an arbitrary path on midjourney.com and return the JSON. The escape hatch for endpoints this server has no named tool for.\n\nMidjourney publishes no API, so the set of endpoints is whatever its web app happens to call this month. Discover them with `midjourney-cli capture`, which records the real traffic while you use the site, then read them here. Paths must start with /api/.",
    schema: {
      path: z.string().describe("Path starting with /api/, for example '/api/folders'."),
      query: z
        .record(z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe("Query parameters to append."),
    },
    risk: "read",
    handler: async (args, ctx) => {
      const path = args.path.trim();
      if (!path.startsWith("/api/")) {
        throw new Error(
          `Path must start with /api/. Got '${path}'. This tool reaches Midjourney's own JSON endpoints, not arbitrary pages.`,
        );
      }
      return ctx.client.request(path, { query: args.query });
    },
  }),
];
