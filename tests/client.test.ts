/** The client, against a faked browser. Nothing here reaches the network. */

import { describe, expect, it } from "vitest";

import { MidjourneyClient, findUserId } from "../src/api/client.js";
import { loadConfig } from "../src/config.js";
import type { CdpBrowser, PageResponse } from "../src/transport/cdp.js";

const UUID = "3f9c1a2b-4d5e-6f70-8192-a3b4c5d6e7f8";

type Call = { path: string; method?: string; body?: unknown };

/** Stands in for CdpBrowser. Records calls and answers from a script. */
function fakeBrowser(responses: PageResponse[]): { browser: CdpBrowser; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;

  const browser = {
    apiFetch: async (path: string, init: { method?: string; body?: unknown } = {}) => {
      calls.push({ path, method: init.method, body: init.body });
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return response as PageResponse;
    },
    isRunning: async () => true,
    version: async () => ({ Browser: "Chrome/fake" }),
    close: () => undefined,
  } as unknown as CdpBrowser;

  return { browser, calls };
}

function config() {
  // No pacing in tests: the throttle is covered by its own behaviour, and a
  // 700ms floor per call would make this suite take minutes.
  process.env.MIDJOURNEY_MIN_REQUEST_INTERVAL_MS = "0";
  process.env.MIDJOURNEY_MAX_RETRIES = "2";
  return loadConfig();
}

const okJson = (body: unknown): PageResponse => ({ ok: true, status: 200, body: JSON.stringify(body) });

describe("MidjourneyClient.request", () => {
  it("returns the parsed body", async () => {
    const { browser } = fakeBrowser([okJson({ jobs: [] })]);
    const client = new MidjourneyClient(config(), browser);
    await expect(client.request("/api/imagine")).resolves.toEqual({ jobs: [] });
  });

  it("builds the query string, dropping empties", async () => {
    const { browser, calls } = fakeBrowser([okJson({})]);
    const client = new MidjourneyClient(config(), browser);
    await client.request("/api/imagine", { query: { page_size: 25, cursor: undefined, feed: "" } });
    expect(calls[0]?.path).toBe("/api/imagine?page_size=25");
  });

  it("retries a 500 and succeeds on the second attempt", async () => {
    const { browser, calls } = fakeBrowser([
      { ok: false, status: 500, body: "{}" },
      okJson({ ok: true }),
    ]);
    const client = new MidjourneyClient(config(), browser);
    await expect(client.request("/api/imagine")).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it("does not retry a 400, because a second attempt fails identically", async () => {
    const { browser, calls } = fakeBrowser([{ ok: false, status: 400, body: '{"message":"bad"}' }]);
    const client = new MidjourneyClient(config(), browser);
    await expect(client.request("/api/submit-jobs")).rejects.toThrow(/rejected the request/);
    expect(calls).toHaveLength(1);
  });

  it("treats a 200 carrying a Cloudflare challenge as a failure, not a body", async () => {
    const challenge = "<html><title>Just a moment...</title></html>";
    const { browser } = fakeBrowser([{ ok: true, status: 200, body: challenge }]);
    const client = new MidjourneyClient(config(), browser);
    await expect(client.request("/api/imagine")).rejects.toThrow(/Cloudflare served a challenge/);
  });

  it("says the response was not JSON rather than throwing a parse error", async () => {
    const { browser } = fakeBrowser([{ ok: true, status: 200, body: "<html>hi</html>" }]);
    const client = new MidjourneyClient(config(), browser);
    await expect(client.request("/api/imagine")).rejects.toThrow(/not JSON/);
  });

  it("honours noRetry, so a submission is never sent twice", async () => {
    const { browser, calls } = fakeBrowser([{ ok: false, status: 500, body: "{}" }]);
    const client = new MidjourneyClient(config(), browser);
    await expect(
      client.request("/api/submit-jobs", { method: "POST", body: {}, noRetry: true }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});

describe("findUserId", () => {
  it("finds a user id wherever it is nested", () => {
    expect(findUserId({ queue: { user_id: UUID } })).toBe(UUID);
    expect(findUserId([{ nested: { userId: UUID } }])).toBe(UUID);
  });

  it("strips the singleplayer prefix", () => {
    expect(findUserId({ user_id: `singleplayer_${UUID}` })).toBe(UUID);
  });

  /**
   * The bug this locks out: /api/folders returns folders whose `id` is the
   * folder. Accepting a bare `id` meant the first list call could set a folder
   * id as the account id, and every request after that quietly asked about
   * somebody who does not exist.
   */
  it("refuses a bare id, which is usually the wrong object entirely", () => {
    expect(findUserId({ id: UUID })).toBeUndefined();
    expect(findUserId([{ id: UUID, search_terms: [] }])).toBeUndefined();
  });

  it("ignores ids that are not uuids", () => {
    expect(findUserId({ user_id: "queue-1" })).toBeUndefined();
  });
});
