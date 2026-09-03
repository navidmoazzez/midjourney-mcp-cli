/**
 * Moodboards and personalisation, as things a prompt can actually use.
 *
 * A moodboard in the web app is a named pile of reference images. The API hands
 * back each image as an `s.mj.run` URL, which is the same form `--sref` takes,
 * so a moodboard is already a style reference, it just has to be looked up by
 * the name a person calls it rather than a nineteen-digit id.
 *
 * That lookup is the point of this file. "Use my High Fashion moodboard" is how
 * someone thinks about it; `--sref https://s.mj.run/gJFLgT-zAvg --sref ...` is
 * what Midjourney needs, and nobody should be pasting those by hand.
 */

import type { MidjourneyClient } from "./client.js";
import { NotFoundError } from "./errors.js";
import { ENDPOINTS } from "./jobs.js";

export type MoodboardImage = { url: string; width?: number; height?: number };

export type Moodboard = {
  id: string;
  title: string;
  personalize: boolean;
  created?: string;
  images: MoodboardImage[];
};

export type PersonalizationProfile = {
  id: string;
  title: string;
  rankingCount?: number;
  majorVersion?: string;
};

function asArray(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
  if (payload && typeof payload === "object") {
    for (const key of ["moodboards", "profiles", "data", "results", "items"]) {
      const nested = (payload as Record<string, unknown>)[key];
      if (Array.isArray(nested)) return asArray(nested);
    }
  }
  return [];
}

function normaliseMoodboard(record: Record<string, unknown>): Moodboard | undefined {
  const id = record.moodboard_id ?? record.id;
  if (typeof id !== "string" && typeof id !== "number") return undefined;

  const rawImages = Array.isArray(record.images) ? record.images : [];
  const images: MoodboardImage[] = [];
  for (const item of rawImages) {
    if (!item || typeof item !== "object") continue;
    const url = (item as Record<string, unknown>).url;
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) continue;
    const width = (item as Record<string, unknown>).width;
    const height = (item as Record<string, unknown>).height;
    images.push({
      url,
      ...(typeof width === "number" ? { width } : {}),
      ...(typeof height === "number" ? { height } : {}),
    });
  }

  return {
    id: String(id),
    title: typeof record.title === "string" ? record.title : "(untitled)",
    personalize: record.personalize === true,
    ...(typeof record.created === "string" ? { created: record.created } : {}),
    images,
  };
}

export async function listMoodboards(client: MidjourneyClient): Promise<Moodboard[]> {
  const raw = await client.request<unknown>(ENDPOINTS.moodboards);
  return asArray(raw)
    .map(normaliseMoodboard)
    .filter((board): board is Moodboard => board !== undefined);
}

export async function listProfiles(client: MidjourneyClient): Promise<PersonalizationProfile[]> {
  const raw = await client.request<unknown>(ENDPOINTS.personalizedProfiles);
  return asArray(raw)
    .map((record) => {
      const id = record.id;
      if (typeof id !== "string" && typeof id !== "number") return undefined;
      return {
        id: String(id),
        title: typeof record.title === "string" ? record.title : "(untitled)",
        ...(typeof record.rankingCount === "number" ? { rankingCount: record.rankingCount } : {}),
        ...(typeof record.majorVersion === "string" ? { majorVersion: record.majorVersion } : {}),
      };
    })
    .filter((profile): profile is PersonalizationProfile => profile !== undefined);
}

/**
 * Find a moodboard by the name someone would say, or by id.
 *
 * Exact title first, then case-insensitive, then a unique substring. An
 * ambiguous substring is an error naming the candidates rather than a silent
 * pick: choosing "Porsche Campaign" when someone meant "Mercedes Campaign"
 * would be wrong in a way that costs a generation to discover.
 */
export function matchMoodboard(boards: Moodboard[], query: string): Moodboard {
  const wanted = query.trim();
  if (!wanted) throw new NotFoundError("A moodboard name or id is required.", 404, "(local)");

  const byId = boards.find((board) => board.id === wanted);
  if (byId) return byId;

  const exact = boards.find((board) => board.title === wanted);
  if (exact) return exact;

  const lower = wanted.toLowerCase();
  const insensitive = boards.filter((board) => board.title.toLowerCase() === lower);
  if (insensitive.length === 1 && insensitive[0]) return insensitive[0];

  const partial = boards.filter((board) => board.title.toLowerCase().includes(lower));
  if (partial.length === 1 && partial[0]) return partial[0];
  if (partial.length > 1) {
    throw new NotFoundError(
      `'${query}' matches ${partial.length} moodboards: ${partial.map((board) => board.title).join(", ")}. Name one exactly.`,
      404,
      "(local)",
    );
  }

  throw new NotFoundError(
    `No moodboard called '${query}'. Available: ${boards.map((board) => board.title).join(", ") || "none"}.`,
    404,
    "(local)",
  );
}

/**
 * Pick references out of a moodboard.
 *
 * Every image would make an unusable prompt: a 242-image board becomes 242
 * `--sref` flags. A handful is what the web app effectively does too, and
 * spreading the pick across the board rather than taking the first few avoids
 * always drawing on whatever was added first.
 */
export function pickReferences(board: Moodboard, count: number): string[] {
  const wanted = Math.max(1, Math.min(Math.trunc(count), 10));
  const urls = board.images.map((image) => image.url);
  if (urls.length === 0) {
    throw new NotFoundError(
      `Moodboard '${board.title}' has no images, so there is nothing to reference. Add some in the web app first.`,
      404,
      "(local)",
    );
  }
  if (urls.length <= wanted) return urls;

  const step = urls.length / wanted;
  return Array.from({ length: wanted }, (_, index) => urls[Math.floor(index * step)] as string);
}

/**
 * The personalization code for a moodboard.
 *
 * It is the board's id with an `m` in front, which is not documented anywhere
 * and not guessable: `--p 7371990647814750211` is refused as an invalid code,
 * `--p m7371990647814750211` is accepted. Read out of what the web app's "Use
 * in Prompt" button writes into the prompt box.
 *
 * This is how the app actually applies a moodboard. Sampling its images into
 * `--sref` instead is an approximation that needs a high `--sw` to show up at
 * all, and that weight is what makes output look over-processed.
 */
export function personalizationCodeFor(board: Pick<Moodboard, "id">): string {
  return board.id.startsWith("m") ? board.id : `m${board.id}`;
}

/** Resolve "use my High Fashion moodboard" to the style references it means. */
export async function referencesFromMoodboard(
  client: MidjourneyClient,
  query: string,
  count: number,
): Promise<{ board: Moodboard; refs: string[] }> {
  const board = matchMoodboard(await listMoodboards(client), query);
  return { board, refs: pickReferences(board, count) };
}

/* ------------------------------------------------------------------ writes */

/**
 * The write API, captured from the web app rather than guessed at.
 *
 * Worth writing down how it actually works, because none of it is guessable.
 * Creating is a POST to the collection. Adding is a PATCH to the *collection*
 * with the board in a query parameter, not a POST to the board, and the body
 * carries an `add` array of image records rather than bare URLs. Every shape I
 * tried before capturing the real call returned a 500 that said nothing.
 *
 * The web app also uploads the image into the account's own storage first, via
 * `/api/storage-upload-moodboard-file`, and adds the re-hosted copy. That step
 * turns out to be skippable: a `cdn.midjourney.com` job URL patches in directly
 * and the board renders it. Verified against a real board.
 */

export type AddImage = { url: string; width?: number; height?: number };

function imageRecord(image: AddImage): Record<string, unknown> {
  return {
    url: image.url,
    width: image.width ?? null,
    height: image.height ?? null,
    created: Date.now(),
    // The app uses these to render a tile before the server confirms it. We are
    // not rendering anything, so the record is sent already settled.
    optimistic: false,
    optimisticId: null,
    state: null,
  };
}

export async function createMoodboard(
  client: MidjourneyClient,
  title: string,
): Promise<{ id?: string; title: string; raw: unknown }> {
  const name = title.trim();
  if (!name) throw new NotFoundError("A moodboard needs a title.", 400, "(local)");

  const userId = await client.userId();
  const raw = await client.request<unknown>(ENDPOINTS.moodboards, {
    method: "POST",
    body: { session_id: userId, title: name },
    noRetry: true,
  });

  // The response shape is not documented, so the id is looked for rather than
  // assumed, and its absence is not treated as a failure: the board exists.
  let id: string | undefined;
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const candidate = record.moodboard_id ?? record.id;
    if (typeof candidate === "string" || typeof candidate === "number") id = String(candidate);
  }
  return { ...(id ? { id } : {}), title: name, raw };
}

export async function addToMoodboard(
  client: MidjourneyClient,
  moodboardId: string,
  images: AddImage[],
): Promise<{ added: number; raw: unknown }> {
  if (images.length === 0) {
    throw new NotFoundError("Nothing to add: no image URLs were given.", 400, "(local)");
  }
  const userId = await client.userId();
  const raw = await client.request<unknown>(
    `${ENDPOINTS.moodboards}?moodboard_id=${encodeURIComponent(moodboardId)}`,
    {
      method: "PATCH",
      body: { session_id: userId, add: images.map(imageRecord) },
      noRetry: true,
    },
  );
  return { added: images.length, raw };
}

export async function removeFromMoodboard(
  client: MidjourneyClient,
  moodboardId: string,
  urls: string[],
): Promise<{ removed: number; raw: unknown }> {
  if (urls.length === 0) {
    throw new NotFoundError("Nothing to remove: no image URLs were given.", 400, "(local)");
  }
  const userId = await client.userId();
  const raw = await client.request<unknown>(
    `${ENDPOINTS.moodboards}?moodboard_id=${encodeURIComponent(moodboardId)}`,
    {
      method: "PATCH",
      body: { session_id: userId, remove: urls.map((url) => ({ url })) },
      noRetry: true,
    },
  );
  return { removed: urls.length, raw };
}
