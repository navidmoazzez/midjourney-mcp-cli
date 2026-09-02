/**
 * Midjourney's prompt grammar, as a typed thing rather than string glue.
 *
 * A Midjourney prompt is text followed by double-dash parameters, and the
 * parameters have real rules: ranges, mutual exclusions, values that only exist
 * on some model versions. Building that by concatenation means every mistake
 * costs a round trip and, on a paid plan, a fast-hour. Worse, Midjourney does
 * not reject most bad values; it silently clamps or ignores them, so a wrong
 * `--stylize 5000` looks like it worked and quietly did not.
 *
 * So the rules live here, checked before anything is spent. The reference
 * implementation for this API passes these through as opaque strings; catching
 * a bad `--ar` locally rather than after a minute of GPU time is most of why
 * this file exists.
 */

import { ValidationError } from "../api/errors.js";

export type PromptParams = {
  /** The subject text. Everything before the first parameter. */
  text: string;

  /** Image URLs used as image prompts. Prepended to the text, not a parameter. */
  imagePrompts?: string[];

  aspect?: string;
  version?: string;
  niji?: string;
  stylize?: number;
  chaos?: number;
  weird?: number;
  seed?: number;
  quality?: number;
  stop?: number;
  repeat?: number;
  exp?: number;

  styleRefs?: string[];
  styleWeight?: number;
  omniRefs?: string[];
  omniWeight?: number;
  imageWeight?: number;

  profile?: string;
  style?: string;
  raw?: boolean;
  tile?: boolean;
  draft?: boolean;
  negative?: string;
};

type Range = { min: number; max: number; label: string };

const RANGES: Record<string, Range> = {
  stylize: { min: 0, max: 1000, label: "--stylize" },
  chaos: { min: 0, max: 100, label: "--chaos" },
  weird: { min: 0, max: 3000, label: "--weird" },
  seed: { min: 0, max: 4_294_967_295, label: "--seed" },
  stop: { min: 10, max: 100, label: "--stop" },
  repeat: { min: 1, max: 40, label: "--repeat" },
  exp: { min: 0, max: 100, label: "--exp" },
  styleWeight: { min: 0, max: 1000, label: "--sw" },
  omniWeight: { min: 0, max: 1000, label: "--ow" },
};

const QUALITY = [0.25, 0.5, 1, 2, 4];

function checkRange(value: number | undefined, key: keyof typeof RANGES): void {
  if (value === undefined) return;
  const range = RANGES[key];
  if (!range) return;
  if (!Number.isFinite(value) || value < range.min || value > range.max) {
    throw new ValidationError(
      `${range.label} must be between ${range.min} and ${range.max}. Got ${value}. Midjourney clamps out-of-range values silently, so this is refused here instead.`,
      0,
      "(local)",
    );
  }
}

/** `16:9`, `3:2`, `1:1`. Midjourney rejects ratios beyond roughly 1:4 to 4:1. */
export function validateAspect(aspect: string): void {
  const match = /^(\d{1,3}):(\d{1,3})$/.exec(aspect.trim());
  if (!match) {
    throw new ValidationError(
      `--ar must look like 16:9. Got '${aspect}'.`,
      0,
      "(local)",
    );
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width === 0 || height === 0) {
    throw new ValidationError(`--ar cannot have a zero side. Got '${aspect}'.`, 0, "(local)");
  }
}

/**
 * A style or omni reference: a URL, a numeric sref code, or `random`.
 *
 * Getting this wrong is a common and expensive mistake, because Midjourney
 * treats an unrecognised `--sref` value as part of the prompt text rather than
 * failing, so the reference is silently dropped and the image comes back
 * looking almost right.
 */
export function validateRef(value: string, flag: string): void {
  const trimmed = value.trim();
  if (!trimmed) throw new ValidationError(`${flag} cannot be empty.`, 0, "(local)");
  if (trimmed.toLowerCase() === "random") return;
  if (/^\d+$/.test(trimmed)) return;
  if (/^https?:\/\/\S+$/i.test(trimmed)) return;
  throw new ValidationError(
    `${flag} must be an image URL, a numeric style code, or 'random'. Got '${trimmed}'. Midjourney does not reject a bad reference, it silently treats it as prompt text.`,
    0,
    "(local)",
  );
}

/**
 * Midjourney's own asset hosts serve images from extensionless URLs.
 *
 * `https://s.mj.run/xE_f2o6GRl0` is what the web app produces when you drag an
 * image in, and it is the form that appears in real prompts. An extension check
 * alone rejects it, which would refuse the most common image prompt there is.
 */
const MIDJOURNEY_ASSET_HOSTS = /^https?:\/\/(s\.mj\.run|cdn\.midjourney\.com|storage\.googleapis\.com)\//i;

function validateImagePrompt(value: string): void {
  const trimmed = value.trim();
  if (MIDJOURNEY_ASSET_HOSTS.test(trimmed)) return;
  if (/^https?:\/\/\S+\.(png|jpe?g|webp|gif)(\?\S*)?$/i.test(trimmed)) return;
  throw new ValidationError(
    `An image prompt must be a direct URL to an image file, ending in .png, .jpg, .jpeg, .webp or .gif, or a Midjourney asset URL such as https://s.mj.run/... . Got '${value}'. A link to the page an image sits on will not work.`,
    0,
    "(local)",
  );
}

/**
 * Assemble the prompt Midjourney receives.
 *
 * Order matters to Midjourney: image prompts first, then the text, then
 * parameters. Everything is validated before a single character is joined, so a
 * refusal costs nothing.
 */
export function buildPrompt(params: PromptParams, defaults: { version: string }): string {
  const text = params.text.trim();
  if (!text && (params.imagePrompts?.length ?? 0) === 0) {
    throw new ValidationError("A prompt needs text, an image prompt, or both.", 0, "(local)");
  }

  if (params.aspect) validateAspect(params.aspect);
  for (const ref of params.styleRefs ?? []) validateRef(ref, "--sref");
  for (const ref of params.omniRefs ?? []) validateRef(ref, "--oref");
  for (const image of params.imagePrompts ?? []) validateImagePrompt(image);

  for (const key of Object.keys(RANGES) as (keyof typeof RANGES)[]) {
    checkRange(params[key as keyof PromptParams] as number | undefined, key);
  }

  if (params.quality !== undefined && !QUALITY.includes(params.quality)) {
    throw new ValidationError(
      `--q must be one of ${QUALITY.join(", ")}. Got ${params.quality}.`,
      0,
      "(local)",
    );
  }

  if (params.imageWeight !== undefined && (params.imageWeight < 0 || params.imageWeight > 3)) {
    throw new ValidationError(`--iw must be between 0 and 3. Got ${params.imageWeight}.`, 0, "(local)");
  }

  if (params.niji && params.version) {
    throw new ValidationError(
      "Pass either version or niji, not both. Niji is its own model line and ignores --v.",
      0,
      "(local)",
    );
  }

  if (params.raw && params.style && params.style !== "raw") {
    throw new ValidationError(
      `raw and style are the same parameter. Set style to '${params.style}' or set raw, not both.`,
      0,
      "(local)",
    );
  }

  const parts: string[] = [];
  for (const image of params.imagePrompts ?? []) parts.push(image.trim());
  if (text) parts.push(text);

  const flag = (name: string, value: string | number | undefined): void => {
    if (value === undefined || value === "") return;
    parts.push(`--${name}`, String(value));
  };

  flag("ar", params.aspect);
  for (const ref of params.styleRefs ?? []) flag("sref", ref);
  flag("sw", params.styleWeight);
  for (const ref of params.omniRefs ?? []) flag("oref", ref);
  flag("ow", params.omniWeight);
  flag("iw", params.imageWeight);
  flag("profile", params.profile);
  flag("no", params.negative);

  if (params.niji) {
    flag("niji", params.niji);
  } else {
    flag("v", params.version ?? defaults.version);
  }

  flag("stylize", params.stylize);
  flag("chaos", params.chaos);
  flag("weird", params.weird);
  flag("seed", params.seed);
  flag("q", params.quality);
  flag("stop", params.stop);
  flag("repeat", params.repeat);
  flag("exp", params.exp);

  if (params.style) flag("style", params.style);
  else if (params.raw) flag("style", "raw");

  if (params.tile) parts.push("--tile");
  if (params.draft) parts.push("--draft");

  return parts.join(" ");
}

/** Split a raw prompt back into text and parameters, for echoing what was sent. */
export function splitPrompt(prompt: string): { text: string; params: string } {
  const index = prompt.search(/\s--\w/);
  if (index === -1) return { text: prompt.trim(), params: "" };
  return { text: prompt.slice(0, index).trim(), params: prompt.slice(index).trim() };
}
