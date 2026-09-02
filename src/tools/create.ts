/**
 * Making images.
 *
 * Every tool here spends money, so every one is `risk: "spend"` and needs an
 * explicit confirmation. The descriptions carry the Midjourney parameter
 * grammar in full, because a model that cannot see the code has no other way to
 * know that `--sref` takes a URL or a numeric code but silently becomes prompt
 * text when handed anything else.
 */

import { z } from "zod";

import { downloadJob } from "../api/download.js";
import { referencesFromMoodboard } from "../api/moodboards.js";
import { submitImagine, submitRaw, submitRerun, submitVary, waitForJob } from "../api/jobs.js";
import { ValidationError } from "../api/errors.js";
import { buildPrompt, type PromptParams } from "../content/prompt.js";
import { summariseJob } from "../format/jobs.js";
import { confirmArg, defineTool } from "./kit.js";

const speedArg = z
  .enum(["fast", "relax", "turbo"])
  .optional()
  .describe(
    "Generation speed. 'fast' burns fast-hours and takes under a minute. 'relax' is unlimited on Standard and above but queues, often for several minutes. 'turbo' is quickest and costs double. Defaults to MIDJOURNEY_DEFAULT_SPEED, itself 'fast'.",
  );

/** The prompt grammar, as arguments. Validated in content/prompt.ts before anything is spent. */
const promptShape = {
  prompt: z
    .string()
    .min(1)
    .describe(
      "The subject text, in plain words. Do not put --parameters in here; use the fields below, which are validated before anything is spent. Midjourney reads the start of a prompt as the most important part.",
    ),
  image_prompts: z
    .array(z.string())
    .optional()
    .describe(
      "Direct URLs to images used as visual input, each ending in .png, .jpg, .jpeg, .webp or .gif. A link to the page an image sits on will not work. These are prepended to the prompt, which is what Midjourney expects.",
    ),
  aspect: z
    .string()
    .optional()
    .describe("Aspect ratio as width:height, for example '16:9', '3:2', '1:1'. Sent as --ar."),
  version: z
    .string()
    .optional()
    .describe("Model version, for example '7' or '6.1'. Sent as --v. Cannot be combined with niji."),
  niji: z
    .string()
    .optional()
    .describe(
      "Niji model version, for example '6'. The anime-oriented model line. Sent as --niji, and it ignores version.",
    ),
  stylize: z
    .number()
    .optional()
    .describe(
      "0-1000. How strongly Midjourney applies its own aesthetic. Low follows the prompt literally, high makes prettier but less faithful images. Default is 100. Sent as --stylize.",
    ),
  chaos: z
    .number()
    .optional()
    .describe("0-100. How different the four results are from each other. Sent as --chaos."),
  weird: z
    .number()
    .optional()
    .describe("0-3000. Pushes toward the unusual. Sent as --weird."),
  seed: z
    .number()
    .optional()
    .describe(
      "0-4294967295. Reusing a seed with an identical prompt gives a near-identical result, which is how you iterate on one image rather than rolling a new one. Sent as --seed.",
    ),
  quality: z
    .number()
    .optional()
    .describe("0.25, 0.5, 1, 2 or 4. Render time and therefore cost. Sent as --q."),
  style: z
    .string()
    .optional()
    .describe("Style modifier, most usefully 'raw' for less automatic prettification. Sent as --style."),
  raw: z.boolean().optional().describe("Shorthand for style 'raw'."),
  moodboard: z
    .string()
    .optional()
    .describe(
      "Use one of the account's moodboards as the style, by name or id. Partial names work: 'High Fashion' finds 'High Fashion | Woman'. Its images are sent as style references, so this is the shorthand for building a look you have already curated. Call list_moodboards to see them.",
    ),
  moodboard_refs: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe(
      "How many images to take from the moodboard, 1-10. Defaults to 4. They are spread across the board rather than taken from the front, so a large board does not always draw on its oldest images.",
    ),
  style_refs: z
    .array(z.string())
    .optional()
    .describe(
      "Style references, each an image URL, a numeric style code, or 'random'. Sent as --sref. Anything else is silently treated as prompt text by Midjourney, so this is validated here first.",
    ),
  style_weight: z
    .number()
    .optional()
    .describe("0-1000. How strongly the style references apply. Sent as --sw."),
  omni_refs: z
    .array(z.string())
    .optional()
    .describe(
      "Omni references, for carrying a character or object across images. An image URL or 'random'. Sent as --oref. This is the v7 replacement for --cref.",
    ),
  omni_weight: z.number().optional().describe("0-1000. How strongly omni references apply. Sent as --ow."),
  image_weight: z
    .number()
    .optional()
    .describe("0-3. How much the image prompts matter against the text. Sent as --iw."),
  negative: z
    .string()
    .optional()
    .describe("Things to keep out, comma separated, for example 'text, watermark'. Sent as --no."),
  profile: z
    .string()
    .optional()
    .describe("Personalisation profile id, or 'auto' for this account's own. Sent as --profile."),
  tile: z.boolean().optional().describe("Make a seamlessly tiling image. Sent as --tile."),
  draft: z
    .boolean()
    .optional()
    .describe("Draft mode: much faster and cheaper, lower fidelity. Sent as --draft."),
  repeat: z.number().optional().describe("1-40. Run the prompt this many times. Multiplies the cost."),
  stop: z.number().optional().describe("10-100. Stop rendering early for a blurrier, faster result."),
  exp: z.number().optional().describe("0-100. Experimental aesthetics on v7. Sent as --exp."),
  speed: speedArg,
  private: z
    .boolean()
    .optional()
    .describe("Keep the result off the public feed. Requires a plan that allows stealth mode."),
};

function paramsFrom(args: Record<string, unknown>): PromptParams {
  return {
    text: args.prompt as string,
    imagePrompts: args.image_prompts as string[] | undefined,
    aspect: args.aspect as string | undefined,
    version: args.version as string | undefined,
    niji: args.niji as string | undefined,
    stylize: args.stylize as number | undefined,
    chaos: args.chaos as number | undefined,
    weird: args.weird as number | undefined,
    seed: args.seed as number | undefined,
    quality: args.quality as number | undefined,
    stop: args.stop as number | undefined,
    repeat: args.repeat as number | undefined,
    exp: args.exp as number | undefined,
    styleRefs: args.style_refs as string[] | undefined,
    styleWeight: args.style_weight as number | undefined,
    omniRefs: args.omni_refs as string[] | undefined,
    omniWeight: args.omni_weight as number | undefined,
    imageWeight: args.image_weight as number | undefined,
    profile: args.profile as string | undefined,
    style: args.style as string | undefined,
    raw: args.raw as boolean | undefined,
    tile: args.tile as boolean | undefined,
    draft: args.draft as boolean | undefined,
    negative: args.negative as string | undefined,
  };
}

/**
 * Fold a named moodboard into the style references.
 *
 * Appended rather than replacing anything the caller passed explicitly: asking
 * for a moodboard and a specific `--sref` means both, and silently dropping one
 * of them would be the kind of surprise that costs a generation to notice.
 */
async function applyMoodboard(
  params: PromptParams,
  args: Record<string, unknown>,
  ctx: { client: import("../api/client.js").MidjourneyClient },
): Promise<{ title: string; id: string; references: number } | undefined> {
  const query = args.moodboard as string | undefined;
  if (!query) return undefined;

  const count = (args.moodboard_refs as number | undefined) ?? 4;
  const { board, refs } = await referencesFromMoodboard(ctx.client, query, count);
  params.styleRefs = [...(params.styleRefs ?? []), ...refs];
  return { title: board.title, id: board.id, references: refs.length };
}

export const createTools = [
  defineTool({
    name: "imagine",
    title: "Generate images and wait for them",
    description:
      "Generate images from a prompt, wait for the job to finish, and return the results with direct image URLs. This is the tool to reach for by default: it does the whole job rather than handing back an id to poll.\n\nA fast-mode job usually finishes in 30-60 seconds and this call blocks for that long. Relax mode queues and can take many minutes, so raise MIDJOURNEY_JOB_TIMEOUT_MS or use submit_imagine instead if you do not want to wait.\n\nSet save to true to also write the files to disk and get back local paths, which is what you want when the images are going to be used rather than looked at.\n\nCosts GPU time from the Midjourney plan and cannot be refunded, so it needs confirm: true.",
    schema: {
      ...promptShape,
      save: z
        .boolean()
        .optional()
        .describe("Also download the finished images to disk and return their local paths."),
      out_dir: z
        .string()
        .optional()
        .describe("Where to save, when save is true. Defaults to MIDJOURNEY_DOWNLOAD_DIR."),
      timeout_ms: z
        .number()
        .optional()
        .describe("How long to wait before giving up on the job. Defaults to MIDJOURNEY_JOB_TIMEOUT_MS."),
      ...confirmArg,
    },
    risk: "spend",
    idempotent: false,
    summary: (args) => `generate images for "${String(args.prompt).slice(0, 80)}"`,
    handler: async (args, ctx) => {
      const params = paramsFrom(args as Record<string, unknown>);
      const used = await applyMoodboard(params, args as Record<string, unknown>, ctx);
      const prompt = buildPrompt(params, { version: ctx.config.defaultVersion });

      const submitted = await submitImagine(ctx.client, prompt, {
        speed: args.speed,
        private: args.private,
        // This call waits, so the window is refreshed once at the end rather
        // than now, when there would be nothing to see anyway.
        refresh: false,
        imagePromptCount: args.image_prompts?.length ?? 0,
        styleRefCount: args.style_refs?.length ?? 0,
        omniRefCount: args.omni_refs?.length ?? 0,
      });

      const jobId = submitted.jobIds[0];
      if (!jobId) {
        return {
          submitted: true,
          prompt_sent: prompt,
          warning:
            "Midjourney accepted the submission but returned no job id, so the result cannot be followed automatically. Check list_jobs, and please report the response below so the parser can be widened.",
          response: submitted.raw,
        };
      }

      const job = await waitForJob(ctx.client, jobId, { timeoutMs: args.timeout_ms });
      const result: Record<string, unknown> = {
        prompt_sent: prompt,
        ...(used ? { moodboard_used: used } : {}),
        ...summariseJob(job),
      };

      if (args.save && job.images.length > 0) {
        const saved = await downloadJob(ctx.client, job.id, { outDir: args.out_dir });
        result.saved = saved.saved;
        if (saved.skipped.length > 0) result.save_problems = saved.skipped;
      }

      return result;
    },
  }),

  defineTool({
    name: "submit_imagine",
    title: "Submit a generation without waiting",
    description:
      "Submit a generation and return immediately with the job id, without waiting for the images. Use this when queueing several prompts at once, or on relax mode where a job can take many minutes.\n\nFollow it with wait_for_job, or check back later with get_job. Prefer the imagine tool when you just want the pictures.\n\nCosts GPU time and cannot be refunded, so it needs confirm: true.",
    schema: { ...promptShape, ...confirmArg },
    risk: "spend",
    idempotent: false,
    summary: (args) => `submit "${String(args.prompt).slice(0, 80)}"`,
    handler: async (args, ctx) => {
      const params = paramsFrom(args as Record<string, unknown>);
      const used = await applyMoodboard(params, args as Record<string, unknown>, ctx);
      const prompt = buildPrompt(params, { version: ctx.config.defaultVersion });
      const submitted = await submitImagine(ctx.client, prompt, {
        speed: args.speed,
        private: args.private,
        imagePromptCount: args.image_prompts?.length ?? 0,
        styleRefCount: params.styleRefs?.length ?? 0,
        omniRefCount: args.omni_refs?.length ?? 0,
      });
      return {
        prompt_sent: prompt,
        ...(used ? { moodboard_used: used } : {}),
        job_ids: submitted.jobIds,
        next: "Call wait_for_job with a job id to block until it finishes, or get_job to check once.",
      };
    },
  }),

  defineTool({
    name: "rerun_job",
    title: "Run an existing job again",
    description:
      "Run an existing job again, which is what the reroll button in the web app does. Same prompt and settings, a new roll of the dice. Pass new_prompt to change the wording while keeping everything else.\n\nThe job must still be in the account's recent history. Costs GPU time, so it needs confirm: true.",
    schema: {
      job_id: z.string().describe("The id of the job to run again."),
      new_prompt: z
        .string()
        .optional()
        .describe("Replace the prompt text. Leave unset to re-run it unchanged."),
      hd: z
        .boolean()
        .optional()
        .describe(
          "Re-render at HD. This is what the web app's 'Run batch as HD' does: a re-run with --hd appended, so it is a fresh render rather than an upscale of the existing pixels. Pair it with the original seed to stay close to the image you liked.",
        ),
      speed: speedArg,
      private: z.boolean().optional().describe("Keep the result off the public feed."),
      wait: z
        .boolean()
        .optional()
        .describe("Block until the new job finishes and return its images. Defaults to true."),
      ...confirmArg,
    },
    risk: "spend",
    idempotent: false,
    summary: (args) => `re-run job ${String(args.job_id)}`,
    handler: async (args, ctx) => {
      // HD is not its own job type. The web app re-runs the job with `--hd`
      // appended, which is why this rides on rerun rather than standing alone.
      const newPrompt =
        args.hd && args.new_prompt
          ? `${args.new_prompt}${/\s--hd\b/.test(args.new_prompt) ? "" : " --hd"}`
          : args.new_prompt;

      if (args.hd && !newPrompt) {
        throw new ValidationError(
          "hd needs new_prompt: Midjourney runs HD as a re-run with --hd appended to the prompt, so the prompt has to be supplied. Read it from get_job and pass it back, keeping the --seed so the result stays close to the image you liked.",
          0,
          "(local)",
        );
      }

      const submitted = await submitRerun(ctx.client, args.job_id, {
        speed: args.speed,
        private: args.private,
        refresh: args.wait === false,
        newPrompt,
      });

      const jobId = submitted.jobIds[0];
      if (!jobId || args.wait === false) {
        return { source_job_id: args.job_id, job_ids: submitted.jobIds, response: submitted.raw };
      }
      return { source_job_id: args.job_id, ...summariseJob(await waitForJob(ctx.client, jobId)) };
    },
  }),

  defineTool({
    name: "vary_image",
    title: "Make variations of one image",
    description:
      "Take one image from a finished grid and generate four variations of it. This is the Vary button in the web app, and it is how you iterate: pick the result closest to what you wanted and push it further rather than rolling a fresh set.\n\nSubtle keeps the composition and changes the details. Strong keeps the subject and rethinks everything else.\n\nIndex is zero-based, matching the order from list_jobs and download_job: 0 is top-left, 1 top-right, 2 bottom-left, 3 bottom-right.\n\nCosts GPU time, so it needs confirm: true.",
    schema: {
      job_id: z.string().describe("The finished job holding the image to vary."),
      index: z
        .number()
        .int()
        .min(0)
        .max(3)
        .describe("Which image, zero-based. 0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right."),
      strong: z
        .boolean()
        .optional()
        .describe("Strong variation. Defaults to subtle, which stays closer to the original."),
      speed: speedArg,
      private: z.boolean().optional().describe("Keep the result off the public feed."),
      wait: z
        .boolean()
        .optional()
        .describe("Block until the variations finish and return them. Defaults to true."),
      ...confirmArg,
    },
    risk: "spend",
    idempotent: false,
    summary: (args) =>
      `${args.strong ? "strong" : "subtle"} variation of image ${String(args.index)} from job ${String(args.job_id)}`,
    handler: async (args, ctx) => {
      const submitted = await submitVary(ctx.client, args.job_id, args.index, {
        strong: args.strong,
        speed: args.speed,
        private: args.private,
        refresh: args.wait === false,
      });

      const jobId = submitted.jobIds[0];
      if (!jobId || args.wait === false) {
        return {
          source_job_id: args.job_id,
          index: args.index,
          strong: args.strong ?? false,
          job_ids: submitted.jobIds,
        };
      }
      return {
        source_job_id: args.job_id,
        index: args.index,
        strong: args.strong ?? false,
        ...summariseJob(await waitForJob(ctx.client, jobId)),
      };
    },
  }),

  defineTool({
    name: "submit_raw_job",
    title: "Submit a job type this server does not model yet",
    description:
      "Send an arbitrary job type to Midjourney's submit endpoint. The escape hatch, for upscales, variations and anything else the web app can do that this server has no named tool for yet.\n\nOnly 'imagine' and 'reroll' are confirmed against observed traffic. Other job types exist but their payloads are not documented anywhere, so a wrong guess here spends GPU time on a request that quietly does nothing. Capture what the web app actually sends first, with `midjourney-cli capture`, then pass the same shape.\n\nCosts GPU time, so it needs confirm: true.",
    schema: {
      job_type: z
        .string()
        .describe("The value of the `t` field, for example 'imagine' or 'reroll'."),
      payload: z
        .record(z.unknown())
        .optional()
        .describe(
          "Extra top-level fields merged into the request body, for example { id: '<job-id>', index: 0 }. The mode, channel and metadata fields are filled in for you.",
        ),
      speed: speedArg,
      private: z.boolean().optional().describe("Keep the result off the public feed."),
      ...confirmArg,
    },
    risk: "spend",
    idempotent: false,
    summary: (args) => `submit a raw '${String(args.job_type)}' job`,
    handler: async (args, ctx) =>
      submitRaw(ctx.client, args.job_type, (args.payload as Record<string, unknown>) ?? {}, {
        speed: args.speed,
        private: args.private,
      }),
  }),
];
