import { describe, expect, it } from "vitest";

import { extractJobIds } from "../src/api/jobs.js";
import { channelIdFor } from "../src/api/jobs.js";
import {
  extractImages,
  extractJobs,
  imageUrlsFor,
  isTerminal,
  normaliseJob,
  normaliseStatus,
} from "../src/format/jobs.js";

const UUID = "3f9c1a2b-4d5e-6f70-8192-a3b4c5d6e7f8";

describe("normaliseStatus", () => {
  it("maps the spellings the app has used onto one vocabulary", () => {
    expect(normaliseStatus("completed").status).toBe("completed");
    expect(normaliseStatus("DONE").status).toBe("completed");
    expect(normaliseStatus("in_progress").status).toBe("running");
    expect(normaliseStatus("pending").status).toBe("queued");
    expect(normaliseStatus("banned_prompt").status).toBe("moderated");
  });

  it("keeps the original, because the mapping is lossy", () => {
    expect(normaliseStatus("DONE").raw).toBe("DONE");
  });

  it("does not guess at something it has never seen", () => {
    expect(normaliseStatus("hyperdrive").status).toBe("unknown");
    expect(normaliseStatus(undefined).status).toBe("unknown");
  });
});

describe("isTerminal", () => {
  it("treats only finished states as terminal", () => {
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("moderated")).toBe(true);
    expect(isTerminal("running")).toBe(false);
    expect(isTerminal("unknown")).toBe(false);
  });
});

describe("extractImages", () => {
  it("reads both the snake and camel spellings", () => {
    expect(extractImages({ image_paths: ["https://a/1.png"] })).toEqual(["https://a/1.png"]);
    expect(extractImages({ imagePaths: ["https://a/2.png"] })).toEqual(["https://a/2.png"]);
  });

  it("deduplicates and ignores non-URLs", () => {
    expect(extractImages({ image_paths: ["https://a/1.png", "https://a/1.png", "not-a-url"] })).toEqual([
      "https://a/1.png",
    ]);
  });
});

describe("normaliseJob", () => {
  it("needs an id and nothing else", () => {
    expect(normaliseJob({ id: UUID })?.id).toBe(UUID);
    expect(normaliseJob({ prompt: "no id" })).toBeUndefined();
  });

  it("infers completion from the presence of images", () => {
    const job = normaliseJob({ id: UUID, image_paths: ["https://a/1.png"] });
    expect(job?.status).toBe("completed");
  });

  it("keeps the untouched record, so a moved field is still reachable", () => {
    const job = normaliseJob({ id: UUID, some_new_field: 42 });
    expect(job?.raw.some_new_field).toBe(42);
  });
});

describe("extractJobs", () => {
  it("finds the jobs whichever envelope they arrive in", () => {
    for (const payload of [
      [{ id: UUID }],
      { jobs: [{ id: UUID }] },
      { data: [{ id: UUID }] },
      { results: [{ id: UUID }] },
      { page: { items: [{ id: UUID }] } },
    ]) {
      expect(extractJobs(payload).map((job) => job.id), JSON.stringify(payload)).toEqual([UUID]);
    }
  });

  it("handles a single job returned bare", () => {
    expect(extractJobs({ id: UUID }).map((job) => job.id)).toEqual([UUID]);
  });

  it("returns nothing rather than throwing on a shape it does not know", () => {
    expect(extractJobs({ unrelated: true })).toEqual([]);
    expect(extractJobs(null)).toEqual([]);
  });
});

describe("extractJobIds", () => {
  it("digs the ids out of a submission response", () => {
    expect(extractJobIds({ success: true, job_ids: [UUID] })).toEqual([UUID]);
    expect(extractJobIds({ jobs: [{ job_id: UUID }] })).toEqual([UUID]);
    expect(extractJobIds([UUID])).toEqual([UUID]);
  });

  it("ignores ids that are not job ids", () => {
    expect(extractJobIds({ id: "not-a-uuid" })).toEqual([]);
  });
});

describe("channelIdFor", () => {
  it("adds the prefix once and only once", () => {
    expect(channelIdFor(UUID)).toBe(`singleplayer_${UUID}`);
    expect(channelIdFor(`singleplayer_${UUID}`)).toBe(`singleplayer_${UUID}`);
  });
});

describe("imageUrlsFor", () => {
  it("derives one URL per rendered image", () => {
    expect(imageUrlsFor(UUID, 4)).toEqual([
      `https://cdn.midjourney.com/${UUID}/0_0.png`,
      `https://cdn.midjourney.com/${UUID}/0_1.png`,
      `https://cdn.midjourney.com/${UUID}/0_2.png`,
      `https://cdn.midjourney.com/${UUID}/0_3.png`,
    ]);
  });

  it("copes with a missing or silly batch size", () => {
    expect(imageUrlsFor(UUID, 0)).toHaveLength(1);
    expect(imageUrlsFor(UUID, 999)).toHaveLength(16);
  });
});

describe("a real history record", () => {
  // The shape /api/imagine actually returned on 2026-09-02. It carries no
  // status and no image URLs, which is what the derivation above exists for.
  const record = {
    id: UUID,
    enqueue_time: "2026-07-04T11:44:07.469539+00:00",
    parent_id: null,
    published: true,
    height: 816,
    width: 1456,
    batch_size: 4,
    event_type: "diffusion",
    full_command: "a red fox --ar 16:9 --v 8.1",
    job_type: "v8-1_diffusion",
  };

  it("reads as a finished job with four images", () => {
    const job = normaliseJob(record);
    expect(job?.status).toBe("completed");
    expect(job?.images).toHaveLength(4);
    expect(job?.width).toBe(1456);
    expect(job?.height).toBe(816);
    expect(job?.jobType).toBe("v8-1_diffusion");
  });
});
