/**
 * Chrome DevTools Protocol transport.
 *
 * This is the whole reason the server works, so it is worth saying plainly why
 * it exists rather than a normal HTTP client.
 *
 * Midjourney publishes no API. The endpoints under `/api/` are the ones its own
 * web app calls, and they sit behind a Cloudflare interstitial that answers a
 * plain client with a 403 challenge page rather than JSON. The challenge is not
 * defeated by a header: the `cf_clearance` cookie is bound to the IP, the
 * User-Agent and the TLS fingerprint together, so a cookie lifted out of a
 * browser and replayed from Node is a different client and gets stopped.
 *
 * Rather than impersonate a browser, we drive one. Requests are issued by
 * `fetch()` running inside a real midjourney.com page in a real Chrome that is
 * really logged in. Same origin, same cookies, same fingerprint, same IP,
 * credentials attached by the browser itself. There is nothing to spoof
 * because nothing is being faked, and the session stays valid for as long as
 * the user stays logged in.
 *
 * Chrome 136 stopped honouring --remote-debugging-port on the default profile,
 * so attaching to whatever Chrome the user already has open is not reliable.
 * Instead we own a profile: a dedicated user-data-dir under ~/.midjourney-mcp
 * that the user logs into once. That also keeps this well away from their real
 * browsing session, which is the right default for something holding a login.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

import { BrowserError } from "../api/errors.js";

/** One in-flight CDP command. */
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type CdpTarget = {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl?: string;
};

/** What a page-side fetch came back with. */
export type PageResponse = {
  ok: boolean;
  status: number;
  /** The response body as text. JSON parsing happens a layer up. */
  body: string;
  /** Present when the browser refused to make the request at all. */
  networkError?: string;
};

const CHROME_PATHS: Record<string, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
};

export function findChrome(explicit?: string): string {
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new BrowserError(
        `MIDJOURNEY_CHROME_PATH points at ${explicit}, which does not exist.`,
      );
    }
    return explicit;
  }
  for (const candidate of CHROME_PATHS[platform()] ?? []) {
    if (existsSync(candidate)) return candidate;
  }
  throw new BrowserError(
    "No Chrome or Chromium found. Install Google Chrome, or set MIDJOURNEY_CHROME_PATH to the binary.",
  );
}

export function defaultProfileDir(): string {
  return join(homedir(), ".midjourney-mcp", "chrome-profile");
}

/**
 * A single WebSocket to one CDP target, multiplexing commands by id.
 *
 * One socket per command would be simpler and is what a lot of CDP glue does,
 * but it costs a connection handshake on every API call and loses the events
 * we need for navigation. Node 22 ships a global WebSocket, so this needs no
 * dependency at all.
 */
export class CdpSession {
  private socket?: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<(params: unknown) => void>>();
  private readonly url: string;
  private readonly timeoutMs: number;
  private closed = false;

  constructor(webSocketDebuggerUrl: string, timeoutMs: number) {
    this.url = webSocketDebuggerUrl;
    this.timeoutMs = timeoutMs;
  }

  async connect(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return;

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url);
      const onError = () =>
        reject(new BrowserError(`Could not open a DevTools connection to ${this.url}.`));

      socket.addEventListener("open", () => {
        socket.removeEventListener("error", onError);
        this.socket = socket;
        resolve();
      });
      socket.addEventListener("error", onError, { once: true });
      socket.addEventListener("message", (event) => this.receive(String(event.data)));
      socket.addEventListener("close", () => {
        this.socket = undefined;
        for (const [, entry] of this.pending) {
          entry.reject(new BrowserError("The DevTools connection closed mid-command."));
        }
        this.pending.clear();
      });
    });
  }

  private receive(raw: string): void {
    let message: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (typeof message.id === "number") {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) {
        entry.reject(new BrowserError(`DevTools refused the command: ${message.error.message ?? "unknown error"}`));
      } else {
        entry.resolve(message.result);
      }
      return;
    }

    if (message.method) {
      for (const listener of this.listeners.get(message.method) ?? []) {
        listener(message.params);
      }
    }
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new BrowserError("The DevTools connection is not open."));
    }
    const id = this.nextId++;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrowserError(`DevTools command ${method} did not answer within ${this.timeoutMs}ms.`));
      }, this.timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      this.socket?.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Answer a native `window.alert`, `confirm` or `prompt`.
   *
   * These are not DOM elements, they are browser modals, and while one is open
   * the renderer stops servicing the DevTools protocol entirely. Every command
   * then hangs until its timeout, including the ones trying to clear the modal,
   * so the reply to this one only arrives after it has already worked. That is
   * why it is sent without awaiting.
   *
   * Midjourney uses one for "Add from Link", so this is a normal path, not only
   * an error path.
   */
  answerDialog(accept: boolean, promptText?: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const id = this.nextId++;
    this.socket.send(
      JSON.stringify({
        id,
        method: "Page.handleJavaScriptDialog",
        params: { accept, ...(promptText === undefined ? {} : { promptText }) },
      }),
    );
  }

  /** Send a command without waiting for a reply, for use while the page is blocked. */
  fire(method: string, params: Record<string, unknown> = {}): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ id: this.nextId++, method, params }));
  }

  /** Subscribe to a CDP event for as long as this session lives. */
  on(method: string, handler: (params: unknown) => void): () => void {
    const set = this.listeners.get(method) ?? new Set();
    set.add(handler);
    this.listeners.set(method, set);
    return () => set.delete(handler);
  }

  /** Resolve on the next occurrence of a CDP event, or reject on timeout. */
  once(method: string, timeoutMs = this.timeoutMs): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const set = this.listeners.get(method) ?? new Set();
      const timer = setTimeout(() => {
        set.delete(handler);
        reject(new BrowserError(`Timed out waiting for ${method}.`));
      }, timeoutMs);
      const handler = (params: unknown) => {
        clearTimeout(timer);
        set.delete(handler);
        resolve(params);
      };
      set.add(handler);
      this.listeners.set(method, set);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket?.close();
    } catch {
      // Closing a socket that is already gone is not a failure worth surfacing.
    }
  }
}

export type BrowserOptions = {
  /** Where DevTools is listening. */
  cdpUrl: string;
  /** Dedicated Chrome profile, so this never touches the user's own. */
  profileDir: string;
  /** Path to the Chrome binary, or undefined to search the usual places. */
  chromePath?: string;
  /** Start Chrome when nothing is listening. */
  autoLaunch: boolean;
  /** Run without a visible window. Logging in needs a window, so this defaults off. */
  headless: boolean;
  /** Per-command deadline. */
  timeoutMs: number;
  /** The origin every API call is made from. */
  origin: string;
};

/**
 * The browser this server drives.
 *
 * Everything above the transport talks to `apiFetch` and `fetchBinary` and does
 * not know a browser is involved. That seam is deliberate: a second transport
 * that impersonates Chrome's TLS fingerprint can implement the same two methods
 * for people who need this on a headless box, without any tool changing.
 */
export class CdpBrowser {
  private readonly options: BrowserOptions;
  private session?: CdpSession;
  private sessionTargetId?: string;
  private launched = false;
  /** Text to type into the next native prompt, when one is expected. */
  private pendingDialogText?: string;

  constructor(options: BrowserOptions) {
    this.options = options;
  }

  /** True when something is already answering on the DevTools port. */
  async isRunning(): Promise<boolean> {
    try {
      const response = await fetch(`${this.options.cdpUrl}/json/version`, {
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async version(): Promise<Record<string, string> | undefined> {
    try {
      const response = await fetch(`${this.options.cdpUrl}/json/version`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) return undefined;
      return (await response.json()) as Record<string, string>;
    } catch {
      return undefined;
    }
  }

  /**
   * Start Chrome on the dedicated profile and wait for DevTools to answer.
   *
   * Detached and with stdio ignored, so the browser outlives this process. A
   * server that killed the browser on exit would log the user out every time an
   * MCP client restarted, which is most of the value gone.
   */
  async launch(): Promise<void> {
    if (await this.isRunning()) return;
    if (!this.options.autoLaunch) {
      throw new BrowserError(
        `Nothing is listening on ${this.options.cdpUrl} and MIDJOURNEY_CHROME_LAUNCH=0. Start Chrome yourself, or allow auto-launch.`,
      );
    }

    const binary = findChrome(this.options.chromePath);
    await mkdir(this.options.profileDir, { recursive: true });

    const port = new URL(this.options.cdpUrl).port || "9222";
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${this.options.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate",
      this.options.origin,
    ];
    if (this.options.headless) args.unshift("--headless=new");

    spawn(binary, args, { detached: true, stdio: "ignore" }).unref();

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (await this.isRunning()) {
        this.launched = true;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new BrowserError(
      `Chrome was started but DevTools never answered on ${this.options.cdpUrl}. Check that no other Chrome is already using that profile directory.`,
    );
  }

  private async targets(): Promise<CdpTarget[]> {
    const response = await fetch(`${this.options.cdpUrl}/json/list`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new BrowserError(`DevTools listing failed with HTTP ${response.status}.`);
    return (await response.json()) as CdpTarget[];
  }

  private originHost(): string {
    return new URL(this.options.origin).host;
  }

  /** A page already on the target origin, or undefined. */
  private async findOriginTab(): Promise<CdpTarget | undefined> {
    const host = this.originHost();
    return (await this.targets()).find(
      (target) =>
        target.type === "page" &&
        target.webSocketDebuggerUrl !== undefined &&
        (() => {
          try {
            return new URL(target.url).host === host;
          } catch {
            return false;
          }
        })(),
    );
  }

  /**
   * Open a new tab. Chrome switched `/json/new` to PUT-only, and older builds
   * only accept GET, so try the current spelling and fall back.
   */
  private async openTab(url: string): Promise<CdpTarget> {
    const endpoint = `${this.options.cdpUrl}/json/new?${encodeURIComponent(url)}`;
    for (const method of ["PUT", "GET"] as const) {
      try {
        const response = await fetch(endpoint, { method, signal: AbortSignal.timeout(10_000) });
        if (response.ok) return (await response.json()) as CdpTarget;
      } catch {
        // Try the other verb before giving up.
      }
    }
    throw new BrowserError("Could not open a new browser tab through DevTools.");
  }

  async closeTab(targetId: string): Promise<void> {
    try {
      await fetch(`${this.options.cdpUrl}/json/close/${targetId}`, {
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // A tab that failed to close is untidy, not broken.
    }
  }

  /** A connected session against a page on the target origin, reused across calls. */
  private async originSession(): Promise<CdpSession> {
    if (this.session && this.sessionTargetId) {
      const still = (await this.targets()).some((target) => target.id === this.sessionTargetId);
      if (still) return this.session;
      this.session.close();
      this.session = undefined;
      this.sessionTargetId = undefined;
    }

    await this.launch();

    let tab = await this.findOriginTab();
    if (!tab) {
      tab = await this.openTab(this.options.origin);
      // A fresh tab has not run its scripts yet. The page does not need to be
      // interactive for fetch() to work, only same-origin, but navigating takes
      // a moment and evaluating against about:blank would be the wrong origin.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const settled = await this.findOriginTab();
      if (settled) tab = settled;
    }

    if (!tab.webSocketDebuggerUrl) {
      throw new BrowserError(
        "Found a Midjourney tab but DevTools gave no debugger URL for it. Another debugger may already be attached.",
      );
    }

    const session = new CdpSession(tab.webSocketDebuggerUrl, this.options.timeoutMs);
    await session.connect();

    // Arm dialog handling before anything else runs.
    //
    // A native modal freezes the renderer, and every later command times out,
    // including the ones that would clear it. Without this the server does not
    // recover on its own: it stays broken until someone clicks the dialog by
    // hand, which is not a thing a background process can rely on.
    //
    // Dismissed rather than accepted, because an unexpected dialog is a
    // question nobody asked and "no" is the safe answer. A tool that means to
    // answer one arms `pendingDialogText` first.
    session.fire("Page.enable");
    session.on("Page.javascriptDialogOpening", () => {
      const answer = this.pendingDialogText;
      this.pendingDialogText = undefined;
      session.answerDialog(answer !== undefined, answer);
    });

    this.session = session;
    this.sessionTargetId = tab.id;
    return session;
  }

  /**
   * Answer the next native prompt with this text instead of dismissing it.
   *
   * Consumed once. Midjourney's "Add from Link" is a `window.prompt`, so
   * driving it means having the answer ready before the click that opens it.
   */
  expectDialog(text: string): void {
    this.pendingDialogText = text;
  }

  /** Evaluate an expression in the page and return its value. */
  private async evaluate<T>(session: CdpSession, expression: string): Promise<T> {
    const result = await session.send<{
      result?: { value?: T };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });

    if (result.exceptionDetails) {
      const detail =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "unknown error";
      throw new BrowserError(`The page threw while running the request: ${detail}`);
    }
    return result.result?.value as T;
  }

  /**
   * Issue an API request from inside the page.
   *
   * `credentials: 'include'` is what makes this work: the browser attaches the
   * session and Cloudflare clearance cookies itself, so nothing here ever
   * handles a credential. The whole response is returned as text and parsed
   * upstream, because an error page is HTML and swallowing that would lose the
   * only clue about what went wrong.
   */
  async apiFetch(
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<PageResponse> {
    const session = await this.originSession();

    const request = {
      path,
      method: init.method ?? "GET",
      body: init.body === undefined ? null : JSON.stringify(init.body),
      headers: {
        accept: "application/json",
        "x-csrf-protection": "1",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.headers ?? {}),
      },
    };

    const expression = `(async (req) => {
      try {
        const response = await fetch(req.path, {
          method: req.method,
          headers: req.headers,
          credentials: 'include',
          body: req.body,
        });
        return { ok: response.ok, status: response.status, body: await response.text() };
      } catch (error) {
        return { ok: false, status: 0, body: '', networkError: String(error && error.message ? error.message : error) };
      }
    })(${JSON.stringify(request)})`;

    return this.evaluate<PageResponse>(session, expression);
  }

  /**
   * Evaluate an expression in the Midjourney page and return its value.
   *
   * Used for the things the API does not answer. The signed-in user's own id is
   * the case that matters: the endpoints want it as a parameter but none of
   * them returns it, while the app has had it in memory since it booted.
   */
  async evaluateInPage<T>(expression: string): Promise<T> {
    const session = await this.originSession();
    return this.evaluate<T>(session, expression);
  }

  /**
   * Make the open window show what just happened.
   *
   * Requests go out through `fetch()` behind the page, so the app never learns
   * a job was submitted: its own grid only updates for work it started itself.
   * The window then sits there looking stale until someone reloads it by hand,
   * which makes a tool that is working look like a tool that is broken.
   *
   * A reload is blunt, and it is what the app does anyway on navigation. It is
   * fire-and-forget: never awaited into a tool result, and a failure here is
   * cosmetic, so it must not fail a generation that already succeeded.
   */
  async refreshView(): Promise<void> {
    if (!(await this.isRunning())) return;
    const session = await this.originSession();
    await this.evaluate(session, "(() => { location.reload(); return 1; })()").catch(
      () => undefined,
    );
  }

  /**
   * Fetch a binary asset and return it base64 encoded.
   *
   * Done from inside the existing page, which means no window activity at all:
   * no new tab, no navigation, no flash.
   *
   * The reference implementation for this API states that the CDN "disallows
   * browser fetch() from www.midjourney.com via CORS" and falls back to
   * screenshotting the rendered element. That is not true, at least not any
   * more: cdn.midjourney.com answers with `access-control-allow-origin: *`, and
   * a same-page fetch returns the exact bytes. Verified against a real asset,
   * byte count matching the file on disk.
   *
   * So this reads the real image rather than a re-encoded picture of one, and
   * it does it without touching the user's window. `openTab` remains for the
   * navigation fallback below, for an asset on some host that does refuse.
   */
  async fetchBinary(url: string): Promise<{ base64: string; mimeType: string }> {
    const inPage = await this.fetchBinaryInPage(url).catch(() => undefined);
    if (inPage) return inPage;
    return this.fetchBinaryByNavigation(url);
  }

  private async fetchBinaryInPage(
    url: string,
  ): Promise<{ base64: string; mimeType: string } | undefined> {
    const session = await this.originSession();

    // FileReader rather than a manual loop over the bytes: a 2 MB image is two
    // million iterations of string concatenation otherwise, which is slow
    // enough to trip the command timeout.
    const expression = `(async () => {
      try {
        const response = await fetch(${JSON.stringify(url)}, { credentials: 'omit' });
        if (!response.ok) return { error: 'HTTP ' + response.status };
        const blob = await response.blob();
        const base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error('read failed'));
          reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
          reader.readAsDataURL(blob);
        });
        return { base64, mimeType: blob.type || '', bytes: blob.size };
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) };
      }
    })()`;

    const result = await this.evaluate<{
      base64?: string;
      mimeType?: string;
      bytes?: number;
      error?: string;
    }>(session, expression);

    if (!result || result.error || !result.base64) return undefined;
    return { base64: result.base64, mimeType: result.mimeType || mimeFromUrl(url) };
  }

  /**
   * The fallback: navigate a throwaway tab and read the bytes back.
   *
   * Only reached when a host refuses a cross-origin read. It does open and
   * close a tab, which is visible, so it is deliberately second.
   */
  private async fetchBinaryByNavigation(url: string): Promise<{ base64: string; mimeType: string }> {
    await this.launch();
    const tab = await this.openTab(url);

    if (!tab.webSocketDebuggerUrl) {
      await this.closeTab(tab.id);
      throw new BrowserError("Could not attach to the tab opened for the download.");
    }

    const session = new CdpSession(tab.webSocketDebuggerUrl, this.options.timeoutMs);
    try {
      await session.connect();
      await session.send("Page.enable");

      const loaded = session.once("Page.loadEventFired", this.options.timeoutMs).catch(() => undefined);
      await session.send("Page.navigate", { url });
      await loaded;

      const tree = await session.send<{ frameTree: { frame: { id: string } } }>("Page.getResourceTree");
      const frameId = tree.frameTree.frame.id;

      const content = await session.send<{ content: string; base64Encoded: boolean }>(
        "Page.getResourceContent",
        { frameId, url },
      );

      if (!content.base64Encoded) {
        return {
          base64: Buffer.from(content.content, "utf8").toString("base64"),
          mimeType: "application/octet-stream",
        };
      }
      return { base64: content.content, mimeType: mimeFromUrl(url) };
    } finally {
      session.close();
      await this.closeTab(tab.id);
    }
  }

  close(): void {
    this.session?.close();
    this.session = undefined;
    this.sessionTargetId = undefined;
  }

  get didLaunch(): boolean {
    return this.launched;
  }
}

export function mimeFromUrl(url: string): string {
  const path = url.split("?")[0] ?? "";
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (extension) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    default:
      return "application/octet-stream";
  }
}
