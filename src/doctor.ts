/**
 * Say what is wrong, in the order it has to be fixed.
 *
 * Every failure mode here produces the same symptom from a tool call, a refused
 * request, and they need completely different fixes: install Chrome, start it,
 * sign in, wait out a challenge. Guessing between them is where people give up
 * on a tool like this, so the checks run in dependency order and stop at the
 * first one that fails, rather than printing four red lines and leaving the
 * reader to work out which one matters.
 */

import { access, constants, mkdir } from "node:fs/promises";

import { MidjourneyClient } from "./api/client.js";
import { loadConfig, type Config } from "./config.js";
import { CdpBrowser, findChrome } from "./transport/cdp.js";
import { VERSION } from "./server.js";

type Check = { label: string; ok: boolean; detail: string; fix?: string };

function line(check: Check): string {
  const mark = check.ok ? "ok  " : "FAIL";
  const base = `  ${mark}  ${check.label.padEnd(22)}${check.detail}`;
  return check.fix && !check.ok ? `${base}\n        -> ${check.fix}` : base;
}

async function checkChrome(config: Config): Promise<Check> {
  try {
    const path = findChrome(config.chromePath);
    return { label: "chrome", ok: true, detail: path };
  } catch (error) {
    return {
      label: "chrome",
      ok: false,
      detail: (error as Error).message,
      fix: "Install Google Chrome, or set MIDJOURNEY_CHROME_PATH to the binary.",
    };
  }
}

async function checkDownloadDir(config: Config): Promise<Check> {
  try {
    await mkdir(config.downloadDir, { recursive: true });
    await access(config.downloadDir, constants.W_OK);
    return { label: "download dir", ok: true, detail: config.downloadDir };
  } catch (error) {
    return {
      label: "download dir",
      ok: false,
      detail: `${config.downloadDir}: ${(error as Error).message}`,
      fix: "Set MIDJOURNEY_DOWNLOAD_DIR to somewhere writable.",
    };
  }
}

export async function runDoctor(): Promise<number> {
  const config = loadConfig();
  const out = (text: string): void => {
    process.stdout.write(`${text}\n`);
  };

  out(`\nmidjourney-mcp ${VERSION}\n`);
  out(`  profile     ${config.profileDir}`);
  out(`  devtools    ${config.cdpUrl}`);
  out(`  origin      ${config.origin}`);
  out(
    `  mode        ${config.readOnly ? "read-only" : config.allowDestructive ? "writes enabled" : "writes disabled"}`,
  );
  out(``);

  const checks: Check[] = [];
  const chrome = await checkChrome(config);
  checks.push(chrome);

  if (!chrome.ok) {
    for (const check of checks) out(line(check));
    out(``);
    return 1;
  }

  const browser = new CdpBrowser({
    cdpUrl: config.cdpUrl,
    profileDir: config.profileDir,
    chromePath: config.chromePath,
    autoLaunch: false,
    headless: config.headless,
    timeoutMs: config.requestTimeoutMs,
    origin: config.origin,
  });

  const running = await browser.isRunning();
  checks.push({
    label: "browser running",
    ok: running,
    detail: running ? ((await browser.version())?.Browser ?? "yes") : `nothing on ${config.cdpUrl}`,
    fix: `Run \`midjourney-cli login\` to start the controlled window and sign in. It also starts on demand on the first tool call${config.autoLaunch ? "" : ", except MIDJOURNEY_CHROME_LAUNCH=0 is set"}.`,
  });

  if (running) {
    const client = new MidjourneyClient(config, browser);
    try {
      const userId = await client.userId();
      checks.push({ label: "signed in", ok: true, detail: `user ${userId}` });
    } catch (error) {
      checks.push({
        label: "signed in",
        ok: false,
        detail: (error as Error).message,
        fix: "Run `midjourney-cli login`, sign in to Midjourney in the window that opens, then try again.",
      });
    }
    client.close();
  }

  checks.push(await checkDownloadDir(config));

  for (const check of checks) out(line(check));
  out(``);

  const failed = checks.filter((check) => !check.ok);
  if (failed.length === 0) {
    out(`  Everything checks out.\n`);
    return 0;
  }
  out(`  ${failed.length} problem(s). Fix the first one; the rest often follow.\n`);
  return 1;
}

/**
 * Open the controlled window and wait for the user to sign in.
 *
 * There is no password to collect and nothing to store: signing in happens in
 * the browser, and the browser profile keeps the session. This command exists
 * so nobody has to be told to construct a Chrome command line by hand.
 */
export async function runLogin(): Promise<number> {
  const config = loadConfig();
  const browser = new CdpBrowser({
    cdpUrl: config.cdpUrl,
    profileDir: config.profileDir,
    chromePath: config.chromePath,
    autoLaunch: true,
    // Signing in needs a window regardless of what the config says.
    headless: false,
    timeoutMs: config.requestTimeoutMs,
    origin: config.origin,
  });

  process.stderr.write(`\nOpening ${config.origin} in the controlled browser.\n`);
  process.stderr.write(`Profile: ${config.profileDir}\n\n`);

  try {
    await browser.launch();
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }

  const client = new MidjourneyClient(config, browser);
  process.stderr.write("Sign in to Midjourney in that window. Waiting...\n");

  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    try {
      const userId = await client.userId();
      process.stderr.write(`\nSigned in as ${userId}.\n`);
      process.stderr.write("The session persists in this profile, so this is a one-time step.\n\n");
      client.close();
      return 0;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  process.stderr.write("\nStill not signed in after five minutes. Leave the window open and run `midjourney-cli doctor` once you are.\n");
  client.close();
  return 1;
}
