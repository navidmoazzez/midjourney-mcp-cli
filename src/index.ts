#!/usr/bin/env node
/**
 * Entry point.
 *
 * `midjourney-mcp`             stdio, which is what MCP clients launch
 * `midjourney-mcp --http`      HTTP, for running it somewhere always on
 * `midjourney-mcp <tool>`      run one tool from the shell, see cli.ts
 * `midjourney-mcp doctor`      check the setup and say what is wrong
 *
 * The shell surface is generated from the same `ALL_TOOLS` array the server
 * registers, so every tool is a command and neither surface can drift.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./config.js";
import { buildServer, VERSION } from "./server.js";
import { httpOptionsFromEnv, startHttpServer } from "./transport/http.js";
import { isCliCommand, runCli } from "./cli.js";

const HELP = `midjourney-mcp ${VERSION}

  midjourney-mcp                     Run over stdio. This is what an MCP client launches.
  midjourney-mcp --http [--port=N]   Run over HTTP, for a machine that is always on.
  midjourney-cli tools               List every tool as a shell command.
  midjourney-cli <tool> [--flags]    Run one tool. Same names as the MCP surface.
  midjourney-cli <tool> --help       What that tool takes.
  midjourney-cli schema <tool>       The JSON schema an MCP client sees.
  midjourney-cli login               Open the controlled browser and sign in. Do this first.
  midjourney-cli doctor              Check the setup and report what is wrong.
  midjourney-cli capture [--seconds] Record what the web app calls, to build new tools.
  midjourney-mcp --version           Print the version.

  Every command prints JSON on --json, trims it with --select, and reports
  errors as JSON on stderr.

There are no credentials to configure. Midjourney publishes no API, so this
drives a real Chrome signed in to midjourney.com. Run \`midjourney-cli login\`
once; the session lives in a dedicated browser profile, not in this process.

Browser:
  MIDJOURNEY_CHROME_PROFILE       profile directory, default ~/.midjourney-mcp/chrome-profile
  MIDJOURNEY_CHROME_PATH          Chrome binary, found automatically otherwise
  MIDJOURNEY_CDP_URL              DevTools endpoint, default http://127.0.0.1:9222
  MIDJOURNEY_CHROME_LAUNCH=0      never start Chrome, only attach to a running one
  MIDJOURNEY_HEADLESS=1           run without a window. Signing in needs one, so do that first.
  MIDJOURNEY_ORIGIN               default https://www.midjourney.com

Behaviour:
  MIDJOURNEY_USER_ID                 skip user-id discovery
  MIDJOURNEY_DEFAULT_SPEED           fast, relax or turbo. Default fast.
  MIDJOURNEY_DEFAULT_VERSION         model version appended as --v. Default 7.
  MIDJOURNEY_DOWNLOAD_DIR            where downloads land, default ~/Downloads/midjourney
  MIDJOURNEY_REQUEST_TIMEOUT_MS      per-request deadline, default 30000
  MIDJOURNEY_MIN_REQUEST_INTERVAL_MS spacing between requests, default 700
  MIDJOURNEY_MAX_RETRIES             retries on 429 and 5xx, default 3
  MIDJOURNEY_JOB_TIMEOUT_MS          how long to wait for a job, default 600000
  MIDJOURNEY_JOB_POLL_INTERVAL_MS    first poll interval, widening, default 3000
  MIDJOURNEY_REFRESH_VIEW=0          leave the open window alone after a generation

Safety:
  MIDJOURNEY_READ_ONLY=1          hide everything that is not a read
  MIDJOURNEY_ALLOW_DESTRUCTIVE=0  keep reads and local writes, block anything that spends
  MIDJOURNEY_AUDIT_LOG            append-only log of every attempted change

HTTP:
  MIDJOURNEY_HTTP_PORT            port for --http, default 8787
  MIDJOURNEY_HTTP_HOST            interface for --http, default 127.0.0.1
  MIDJOURNEY_HTTP_TOKEN           bearer token, required to listen off loopback

https://github.com/navidmoazzez/midjourney-mcp-cli
`;

/**
 * Which name launched us.
 *
 * One file serves both binaries. `midjourney-mcp` with no arguments is an MCP
 * client starting a stdio server and must stay silent on stdout.
 * `midjourney-cli` with no arguments is a person who wants to know what they
 * can type, so it lists the commands instead of hanging on a transport that
 * will never speak.
 */
function invokedAsCli(): boolean {
  const name = (process.argv[1] ?? "").split("/").pop() ?? "";
  return name.startsWith("midjourney-cli");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (invokedAsCli() && argv.length === 0) {
    process.exitCode = await runCli(["tools"]);
    return;
  }

  if (command === "doctor") {
    const { runDoctor } = await import("./doctor.js");
    process.exitCode = await runDoctor();
    return;
  }

  if (command === "login") {
    const { runLogin } = await import("./doctor.js");
    process.exitCode = await runLogin();
    return;
  }

  if (command === "capture") {
    const { runCapture } = await import("./capture.js");

    // Accept `--flag value` as well as `--flag=value`. Only the `=` form worked
    // here, while every tool command accepts both, so `--seconds 150 --out x`
    // silently ran for the default 60s and wrote nothing. A flag that is
    // ignored rather than refused is the worst kind.
    const flag = (name: string): string | undefined => {
      const withEquals = argv.find((token) => token.startsWith(`--${name}=`));
      if (withEquals) return withEquals.slice(name.length + 3);
      const index = argv.indexOf(`--${name}`);
      const next = index === -1 ? undefined : argv[index + 1];
      return next && !next.startsWith("--") ? next : undefined;
    };

    const seconds = Number(flag("seconds") ?? 60);
    const outPath = flag("out");
    process.exitCode = await runCapture(loadConfig(), {
      seconds: Number.isFinite(seconds) ? Math.min(Math.max(seconds, 5), 1800) : 60,
      outPath,
      all: argv.includes("--all"),
    });
    return;
  }

  // Checked before --help and --version so `<tool> --help` reaches the tool. A
  // bare `--help` starts with a dash, so it falls through to the block below.
  if (isCliCommand(argv)) {
    process.exitCode = await runCli(argv);
    return;
  }

  // A word that is not a tool used to fall through and start the server, which
  // then sat waiting on stdin. A typo looked like a hang rather than a mistake,
  // and scripts saw a success exit code. Neither binary takes a positional
  // argument that is not a command, so this is checked for both names rather
  // than only for the CLI one: `midjourney-mcp get-porfile` is a typo too.
  if (command !== undefined && !command.startsWith("-") && command !== "help") {
    process.stderr.write(
      `${JSON.stringify({ error: `Unknown command '${command}'. Run \`midjourney-cli\` to list them.` }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (argv.includes("--help") || argv.includes("-h") || command === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const config = loadConfig();
  const built = buildServer(config);

  const shutdown = async (close?: () => Promise<void>): Promise<void> => {
    if (close) await close().catch(() => undefined);
    // The browser is deliberately left running. Killing it on exit would sign
    // the user out every time an MCP client restarted, which is most of the
    // value gone.
    built.client.close();
    process.exit(0);
  };

  if (argv.includes("--http")) {
    const { close } = await startHttpServer(built, httpOptionsFromEnv(argv));
    process.on("SIGTERM", () => void shutdown(close));
    process.on("SIGINT", () => void shutdown(close));
    return;
  }

  const transport = new StdioServerTransport();
  await built.server.connect(transport);

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((error: unknown) => {
  process.stderr.write(`[midjourney-mcp] ${(error as Error).message}\n`);
  process.exit(1);
});
