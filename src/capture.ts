/**
 * Record what the Midjourney web app actually calls.
 *
 * Midjourney has no API documentation, so every endpoint this server knows
 * about was learned by watching the site. The reference implementation for this
 * API did that once, by hand, and froze the result: twelve read endpoints from
 * a single browsing session, and no way for anyone to extend it without
 * repeating the whole exercise.
 *
 * Making it a command changes that. Run capture, use the site normally, click
 * the thing that has no tool yet, and the request appears in the output with
 * its method, path, query and body. That is the input to a new tool, and it
 * takes a minute rather than an afternoon.
 *
 * It records the account's own traffic in its own browser. It never touches the
 * request headers, which is deliberate: the interesting part is the shape of
 * the call, and writing session cookies into a file people will paste into
 * issues is a good way to leak an account.
 */

import { writeFile } from "node:fs/promises";

import { CdpBrowser, CdpSession } from "./transport/cdp.js";
import type { Config } from "./config.js";

type Observed = {
  method: string;
  path: string;
  query: Record<string, string>;
  requestBody?: unknown;
  status?: number;
  responseSample?: unknown;
  count: number;
};

const REDACTED = new Set(["cookie", "authorization", "x-csrf-token", "set-cookie"]);

/** Never write a credential to disk, whatever shape it arrives in. */
function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[deep]";
  if (Array.isArray(value)) return value.slice(0, 5).map((item) => scrub(item, depth + 1));
  if (value === null || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (REDACTED.has(key.toLowerCase())) {
      out[key] = "[redacted]";
      continue;
    }
    out[key] = scrub(nested, depth + 1);
  }
  return out;
}

function parseBody(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return scrub(JSON.parse(raw));
  } catch {
    return raw.slice(0, 300);
  }
}

/** Trim a response to something readable without pasting a whole feed into a file. */
function sample(text: string): unknown {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      return { _array_of: parsed.length, first: scrub(parsed[0]) };
    }
    return scrub(parsed);
  } catch {
    return text.slice(0, 200);
  }
}

export type CaptureOptions = {
  seconds: number;
  outPath?: string;
  /** Record every request, not only the ones under /api/. */
  all?: boolean;
};

export async function runCapture(config: Config, options: CaptureOptions): Promise<number> {
  const browser = new CdpBrowser({
    cdpUrl: config.cdpUrl,
    profileDir: config.profileDir,
    chromePath: config.chromePath,
    autoLaunch: config.autoLaunch,
    headless: false,
    timeoutMs: config.requestTimeoutMs,
    origin: config.origin,
  });

  await browser.launch();

  const targets = (await fetch(`${config.cdpUrl}/json/list`).then((response) => response.json())) as {
    id: string;
    type: string;
    url: string;
    webSocketDebuggerUrl?: string;
  }[];

  const host = new URL(config.origin).host;
  const page = targets.find(
    (target) => target.type === "page" && target.webSocketDebuggerUrl && target.url.includes(host),
  );

  if (!page?.webSocketDebuggerUrl) {
    process.stderr.write(
      `No ${host} tab is open in the controlled browser. Open one, then run capture again.\n`,
    );
    return 1;
  }

  const session = new CdpSession(page.webSocketDebuggerUrl, config.requestTimeoutMs);
  await session.connect();
  await session.send("Network.enable");

  const observed = new Map<string, Observed>();
  const inFlight = new Map<string, { key: string }>();

  session.on("Network.requestWillBeSent", (params: unknown) => {
    const event = params as {
      requestId: string;
      request: { url: string; method: string; postData?: string };
    };
    let url: URL;
    try {
      url = new URL(event.request.url);
    } catch {
      return;
    }
    if (url.host !== host) return;
    if (!options.all && !url.pathname.startsWith("/api/")) return;

    const key = `${event.request.method} ${url.pathname}`;
    const existing = observed.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      observed.set(key, {
        method: event.request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        requestBody: parseBody(event.request.postData),
        count: 1,
      });
    }
    inFlight.set(event.requestId, { key });
    process.stderr.write(`  ${event.request.method} ${url.pathname}\n`);
  });

  session.on("Network.responseReceived", (params: unknown) => {
    const event = params as { requestId: string; response: { status: number } };
    const pending = inFlight.get(event.requestId);
    if (!pending) return;
    const entry = observed.get(pending.key);
    if (entry) entry.status = event.response.status;
  });

  process.stderr.write(
    `\nRecording ${host} API traffic for ${options.seconds}s.\nUse the site in the controlled window: click the thing you want a tool for.\n\n`,
  );

  await new Promise((resolve) => setTimeout(resolve, options.seconds * 1000));

  // Bodies are fetched at the end rather than as they arrive, because asking
  // for one mid-flight can stall the page the user is still driving.
  for (const [requestId, pending] of inFlight) {
    const entry = observed.get(pending.key);
    if (!entry || entry.responseSample !== undefined) continue;
    try {
      const body = await session.send<{ body: string; base64Encoded: boolean }>(
        "Network.getResponseBody",
        { requestId },
      );
      if (!body.base64Encoded) entry.responseSample = sample(body.body);
    } catch {
      // The body is gone from the cache. The shape of the request is still the
      // useful half.
    }
  }

  session.close();

  const result = {
    captured_at: new Date().toISOString(),
    origin: config.origin,
    seconds: options.seconds,
    endpoint_count: observed.size,
    endpoints: [...observed.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };

  const json = JSON.stringify(result, null, 2);
  if (options.outPath) {
    await writeFile(options.outPath, `${json}\n`);
    process.stderr.write(`\n${observed.size} endpoint(s) written to ${options.outPath}\n`);
  } else {
    process.stdout.write(`${json}\n`);
  }
  return 0;
}
