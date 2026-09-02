/**
 * Everything the server reads from the environment, in one place.
 *
 * Environment variables rather than flags, because a user configuring an MCP
 * client is already editing a JSON `env` block, and flags would mean editing
 * `args` separately for the same setting.
 *
 * There are no credentials here, and that is the point. The browser profile
 * holds the session; this process never sees a cookie, a token or a password.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { defaultProfileDir } from "./transport/cdp.js";

export type Speed = "fast" | "relax" | "turbo";

export type Config = {
  origin: string;
  cdpUrl: string;
  profileDir: string;
  chromePath?: string;
  autoLaunch: boolean;
  headless: boolean;

  /** Midjourney's own id for the signed-in user. Discovered when not set. */
  userId?: string;

  requestTimeoutMs: number;
  minRequestIntervalMs: number;
  maxRetries: number;
  jobTimeoutMs: number;
  jobPollIntervalMs: number;

  downloadDir: string;
  defaultSpeed: Speed;
  defaultVersion: string;

  /** Reload the open window after a generation, so it shows the new work. */
  refreshView: boolean;

  readOnly: boolean;
  allowDestructive: boolean;
  auditPath?: string;
};

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

function int(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function str(name: string): string | undefined {
  const raw = process.env[name];
  return raw && raw.trim() ? raw.trim() : undefined;
}

function speed(name: string, fallback: Speed): Speed {
  const raw = str(name)?.toLowerCase();
  return raw === "fast" || raw === "relax" || raw === "turbo" ? raw : fallback;
}

export function loadConfig(): Config {
  return {
    origin: str("MIDJOURNEY_ORIGIN") ?? "https://www.midjourney.com",
    cdpUrl: str("MIDJOURNEY_CDP_URL") ?? "http://127.0.0.1:9222",
    profileDir: str("MIDJOURNEY_CHROME_PROFILE") ?? defaultProfileDir(),
    chromePath: str("MIDJOURNEY_CHROME_PATH"),
    autoLaunch: bool("MIDJOURNEY_CHROME_LAUNCH", true),
    // Signing in needs a window the user can see, and Cloudflare treats new
    // headless sessions harshly, so a visible window is the working default.
    headless: bool("MIDJOURNEY_HEADLESS", false),

    userId: str("MIDJOURNEY_USER_ID"),

    requestTimeoutMs: int("MIDJOURNEY_REQUEST_TIMEOUT_MS", 30_000, 1_000, 300_000),
    // Paced rather than hammered. The web app does not fire requests back to
    // back and neither should we; this is the difference between a session that
    // lasts and one that trips a bot heuristic.
    minRequestIntervalMs: int("MIDJOURNEY_MIN_REQUEST_INTERVAL_MS", 700, 0, 60_000),
    maxRetries: int("MIDJOURNEY_MAX_RETRIES", 3, 0, 10),
    jobTimeoutMs: int("MIDJOURNEY_JOB_TIMEOUT_MS", 600_000, 10_000, 3_600_000),
    jobPollIntervalMs: int("MIDJOURNEY_JOB_POLL_INTERVAL_MS", 3_000, 1_000, 60_000),

    downloadDir: str("MIDJOURNEY_DOWNLOAD_DIR") ?? join(homedir(), "Downloads", "midjourney"),
    defaultSpeed: speed("MIDJOURNEY_DEFAULT_SPEED", "fast"),
    defaultVersion: str("MIDJOURNEY_DEFAULT_VERSION") ?? "8.1",

    refreshView: bool("MIDJOURNEY_REFRESH_VIEW", true),

    readOnly: bool("MIDJOURNEY_READ_ONLY", false),
    allowDestructive: bool("MIDJOURNEY_ALLOW_DESTRUCTIVE", true),
    auditPath: str("MIDJOURNEY_AUDIT_LOG"),
  };
}

/** Every variable the code reads, so `--help`, the README and the tests agree. */
export const ENV_VARS = [
  "MIDJOURNEY_ORIGIN",
  "MIDJOURNEY_CDP_URL",
  "MIDJOURNEY_CHROME_PROFILE",
  "MIDJOURNEY_CHROME_PATH",
  "MIDJOURNEY_CHROME_LAUNCH",
  "MIDJOURNEY_HEADLESS",
  "MIDJOURNEY_USER_ID",
  "MIDJOURNEY_REQUEST_TIMEOUT_MS",
  "MIDJOURNEY_MIN_REQUEST_INTERVAL_MS",
  "MIDJOURNEY_MAX_RETRIES",
  "MIDJOURNEY_JOB_TIMEOUT_MS",
  "MIDJOURNEY_JOB_POLL_INTERVAL_MS",
  "MIDJOURNEY_DOWNLOAD_DIR",
  "MIDJOURNEY_DEFAULT_SPEED",
  "MIDJOURNEY_DEFAULT_VERSION",
  "MIDJOURNEY_REFRESH_VIEW",
  "MIDJOURNEY_READ_ONLY",
  "MIDJOURNEY_ALLOW_DESTRUCTIVE",
  "MIDJOURNEY_AUDIT_LOG",
  "MIDJOURNEY_HTTP_PORT",
  "MIDJOURNEY_HTTP_HOST",
  "MIDJOURNEY_HTTP_TOKEN",
] as const;
