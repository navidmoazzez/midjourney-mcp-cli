<img src="https://cdn.navid.media/connectors/midjourney-icon-solid.png" alt="Midjourney" width="88">

# Midjourney MCP + CLI

[![npm](https://img.shields.io/npm/v/@thenavidm/midjourney-mcp-cli?color=orange&label=npm)](https://www.npmjs.com/package/@thenavidm/midjourney-mcp-cli)
[![Licence](https://img.shields.io/badge/licence-MIT-green)](./LICENSE)
[![YouTube](https://img.shields.io/badge/YouTube-@thenavidm-red?logo=youtube&logoColor=white)](https://youtube.com/@thenavidm?sub_confirmation=1)
[![X](https://img.shields.io/badge/X-@thenavidm-black?logo=x)](https://x.com/thenavidm)

Midjourney MCP server and CLI for Claude Code and AI agents. 27 tools for generating images, following jobs to completion, downloading the real files, and building moodboards that make a style reusable.

Midjourney publishes no API, so this drives a real Chrome that is signed in as you.

There is no key to paste and no cookie to export. You sign in once, in a window, and the session lives in a browser profile rather than in a config file.

27 tools, on both surfaces. It waits for jobs to finish and hands back the actual files, not a screenshot of them.

Built and maintained by [Navid Moazzez](https://navid.me).

<img src="https://cdn.navid.media/repos/midjourney-mcp-cli.gif?v=2" alt="Claude Code using the Midjourney MCP server" width="520">

## Two ways to use it

### Command line

`midjourney-cli` in your terminal, for scripting, cron, pipes, or a quick
question without opening anything:

```bash
midjourney-cli                                        # every command, one line each
midjourney-cli login                                  # sign in once, in a window
midjourney-cli imagine "a red fox in snow" --ar 16:9 --confirm
midjourney-cli list-jobs --limit 5 --select id,prompt --json
midjourney-cli download-job <job-id> --out-dir ./renders
midjourney-cli list-moodboards --json | jq -r '.moodboards[].title'
midjourney-cli which "save my pictures to disk"       # find the right command
midjourney-cli <command> --help                       # what any command takes
```

`--confirm` is the shell spelling of the confirmation that generating requires.
`--json` gives JSON, `--compact` puts it on one line, `--select id,status` keeps
only the fields you name, and errors are JSON on stderr whichever you pick.

Handlers return data rather than pre-rendered text, so `--json` gives real
fields on every command and `jq` works the same way everywhere.

### MCP server, for AI agents

`midjourney-mcp` is what Claude Code, Claude Desktop, Cursor and the rest
launch. You never run it by hand:

```bash
claude mcp add midjourney -- npx -y @thenavidm/midjourney-mcp-cli@latest
```

There is nothing to put in `-e`. Run `midjourney-cli login` first.

Then just ask: _"shoot that campaign in the style of my High Fashion moodboard"._

Every other client is in [section 3](#3-install).

### Which one

| What you are doing | Use |
|---|---|
| Inside a conversation with an agent | MCP |
| On claude.ai or your phone | Neither. The browser is on your machine, so a cloud connector cannot reach it |
| Piping, scripting, cron, CI | CLI |
| A one-off question in a terminal | CLI |

They are the same program reading the same tool definitions, so anything one
can do, the other can.

## Features

Every tool is both a command and an MCP tool, with the same name. The command is
the tool name with dashes.

| Capability | CLI command | MCP tool |
|---|---|---|
| Who am I, is the session live | `midjourney-cli whoami` | `whoami` |
| Generate and wait for the images | `midjourney-cli imagine` | `imagine` |
| Generate without waiting | `midjourney-cli submit-imagine` | `submit_imagine` |
| Re-run a job, or re-render at HD | `midjourney-cli rerun-job` | `rerun_job` |
| Vary one image from a grid | `midjourney-cli vary-image` | `vary_image` |
| Recent generations | `midjourney-cli list-jobs` | `list_jobs` |
| One job by id | `midjourney-cli get-job` | `get_job` |
| Wait for a job to finish | `midjourney-cli wait-for-job` | `wait_for_job` |
| What is rendering now | `midjourney-cli get-queue` | `get_queue` |
| Save the real files to disk | `midjourney-cli download-job` / `download-url` | `download_job` / `download_url` |
| List and read moodboards | `midjourney-cli list-moodboards` / `get-moodboard` | `list_moodboards` / `get_moodboard` |
| Create a moodboard | `midjourney-cli create-moodboard` | `create_moodboard` |
| Add to, remove from a moodboard | `midjourney-cli add-to-moodboard` / `remove-from-moodboard` | `add_to_moodboard` / `remove_from_moodboard` |
| Personalisation profiles | `midjourney-cli list-personalized-profiles` | `list_personalized_profiles` |
| Folders and storage | `midjourney-cli list-folders` / `get-storage` | `list_folders` / `get_storage` |
| The public explore feed | `midjourney-cli explore-feed` | `explore_feed` |
| Any endpoint with no named tool | `midjourney-cli api-get` / `submit-raw-job` | `api_get` / `submit_raw_job` |
| Check your setup | `midjourney-cli doctor` | not a tool |
| Sign in | `midjourney-cli login` | not a tool |
| Record what the web app calls | `midjourney-cli capture` | not a tool |
| Find the right command | `midjourney-cli which "..."` | not a tool |

All 27 with their arguments are in [section 6](#6-tools).

## Contents

| | Section | |
|---|---|---|
| 1 | [What you can ask it](#1-what-you-can-ask-it) | Real prompts, not features |
| 2 | [Sign in once](#2-sign-in-once) | No key, no cookie |
| 3 | [Install](#3-install) | Every client, copy and paste, plus the shell |
| 4 | [Output and exit codes](#4-output-and-exit-codes) | What scripts branch on |
| 5 | [Which surface, and what each costs](#5-which-surface-and-what-each-costs) | ~8,900 tokens a turn, or nothing |
| 6 | [Tools](#6-tools) | All 27, by what they reach |
| 7 | [Spending safely](#7-spending-safely) | Why generating asks twice |
| 8 | [Prompts and parameters](#8-prompts-and-parameters) | The grammar, validated before you pay |
| 9 | [Moodboards](#9-moodboards) | Turning a look into something reusable |
| 10 | [How it works](#10-how-it-works) | Architecture, and why a browser |
| 11 | [Your data](#11-your-data) | What is stored and where |
| 12 | [Risks](#12-risks) | Read this before you install |
| 13 | [Troubleshooting](#13-troubleshooting) | When something breaks |
| 14 | [Environment variables](#14-environment-variables) | Every knob, and its default |
| 15 | [FAQ](#15-faq) | Including what an MCP server is |

## 1. What you can ask it

- Make me a 16:9 hero image of a red fox asleep in snow, muted palette
- Shoot that campaign in the style of my High Fashion moodboard
- Make a moodboard for cold Nordic product shots, fill it, then shoot a jar of face cream in that style
- Generate four logo concepts at low stylize so they stay literal, and save them
- Vary the second one, strong, and save the results
- Take that last image's seed and try it again with chaos 40
- What is in my Midjourney queue right now?
- Download everything I generated today into ./renders
- Show me my last ten jobs with just the prompt and the image URLs
- Re-run job 3f9c1a2b with the prompt changed to say "at dusk"

The thing you cannot do without this: hand an agent a brief and get finished
image files back. Every other route stops at a job id, or at a screenshot of the
image rather than the image. This waits for the render and writes the real bytes
to disk, so the next step in a pipeline has something to open.

## 2. Sign in once

There is no API key. Midjourney does not issue one, and this server never
handles a credential of any kind.

Instead it runs Chrome against a profile of its own, at
`~/.midjourney-mcp/chrome-profile`. You sign in there once and the session
persists, exactly as it would in a browser you use by hand.

    npx -y @thenavidm/midjourney-mcp-cli@latest login

A Chrome window opens on midjourney.com. Sign in. The command waits, notices,
and exits.

The profile is separate from your everyday Chrome on purpose. Nothing here can
see your normal browsing, your other logins, or your history, and your normal
browser does not need to be running.

To revoke it, sign out in that window, or delete the profile:

    rm -rf ~/.midjourney-mcp/chrome-profile

## 3. Install

Node 22 or newer, and Google Chrome. Nothing else.

    npx -y @thenavidm/midjourney-mcp-cli --version


Node 22 is the floor because the browser connection uses the global `WebSocket`
that landed in that release. That is also why it has no dependency doing it.

### Claude Code

```bash
claude mcp add midjourney -- npx -y @thenavidm/midjourney-mcp-cli@latest
```

`--scope user` makes it available in every project rather than the current one.

### Claude Desktop

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "midjourney": {
      "command": "npx",
      "args": ["-y", "@thenavidm/midjourney-mcp-cli@latest"]
    }
  }
}
```

There is also a one-click `.mcpb` bundle on the release page, installed through
**Settings, Extensions, Install Extension**.

> [!TIP]
> Claude Desktop does not inherit your shell PATH, so a bare `npx` can fail silently. Use the absolute path from `which npx`, and fully quit the app rather than closing the window.

### Cursor

`.cursor/mcp.json`, the same JSON shape as Claude Desktop, key `mcpServers`.

### VS Code

`.vscode/mcp.json`. The key is `servers`, not `mcpServers`, and the entry takes
`"type": "stdio"`.

```json
{
  "servers": {
    "midjourney": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@thenavidm/midjourney-mcp-cli@latest"]
    }
  }
}
```

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.midjourney]
command = "npx"
args = ["-y", "@thenavidm/midjourney-mcp-cli@latest"]
```

### The shell

Both binaries come from the same install. `midjourney-cli` with no arguments
lists every command.

### Check it worked

    npx -y @thenavidm/midjourney-mcp-cli@latest doctor

It checks in dependency order and stops at the first real problem, because these
failures all produce the same symptom from a tool call and need completely
different fixes.

The two that actually happen:

**`browser running: FAIL`.** Chrome is not up on the DevTools port. It starts on
demand on the first tool call, so this is only a problem if you have set
`MIDJOURNEY_CHROME_LAUNCH=0`. Run `login` to start it by hand.

**`signed in: FAIL`.** The window is open but the profile is signed out. Run
`login` again.

## 4. Output and exit codes

Results on stdout, errors on stderr as JSON, so one parse handles both.

| Flag | Result |
|---|---|
| none | pretty JSON |
| `--json` | JSON, always |
| `--compact` | the same JSON on one line |
| `--select a,b.c` | keep only these fields. Dotted paths descend, arrays are traversed element-wise |
| `--agent` | compact JSON. Never implies `--confirm` |

`--select` matters more here than it looks. One explore page is tens of
kilobytes, most of it layout metadata, and an agent piping that into its context
pays for every byte.

`--agent` deliberately does **not** imply confirmation, unlike the equivalent in
some other CLIs. A flag an agent passes by habit must never be the thing that
authorises a charge.

| Code | Means |
|---|---|
| `0` | it worked |
| `1` | it failed: signed out, a refused write, an API error |
| `2` | it was typed wrong: a missing flag, a bad value, a bad `--ar` |

## 5. Which surface, and what each costs

An MCP server is expensive and a CLI is free.

The `tools/list` payload for these 27 tools is about **8,900 tokens**, plus the
server instructions. That is charged on every turn of every conversation, used
or not, because the descriptions are long and carry the parameter grammar.

A CLI costs nothing until it is called. The skill mentions it in one line, and
the model pays only when it runs something.

So the two are not competing:

| Where the work happens | Surface |
|---|---|
| Inside a conversation with an agent | MCP |
| Piping, scripting, cron, CI | CLI |
| A one-off question in a terminal | CLI |

## 6. Tools

### Making images

| Tool | What it does |
|---|---|
| `imagine` | Generate, wait for the job, return the images. Optionally save them. Spends |
| `submit_imagine` | Submit and return the job id without waiting. Spends |
| `rerun_job` | Run an existing job again, optionally with new wording or at HD. Spends |
| `vary_image` | Four variations of one image from a grid, subtle or strong. Spends |
| `submit_raw_job` | Send a job type this server does not model yet. Spends |

### Following work

| Tool | What it does |
|---|---|
| `list_jobs` | Recent generations, newest first, with status and image URLs |
| `get_job` | One job by id, with its real status |
| `wait_for_job` | Block until a job finishes, fails or is moderated |
| `get_queue` | What is running now, and how much concurrency the plan allows |
| `job_updates` | The live delta feed the web app itself polls |

### Getting the files

| Tool | What it does |
|---|---|
| `download_job` | Write a job's images to disk. Real files, full resolution |
| `download_url` | Write one asset to disk by URL |

### Moodboards and style

| Tool | What it does |
|---|---|
| `list_moodboards` | Every board, with how many reference images each holds |
| `get_moodboard` | One board by name, and the references a generation would use |
| `create_moodboard` | Start a new board for a look |
| `add_to_moodboard` | Put a job's renders, or any URLs, onto a board |
| `remove_from_moodboard` | Take images off a board. Needs `confirm` |
| `list_personalized_profiles` | Profiles, with how many images each was trained on |

### Your account

| Tool | What it does |
|---|---|
| `whoami` | Which account is signed in, and whether the browser is reachable |
| `list_folders` | Folders in the Organise view |
| `get_storage` | Storage used against what the plan allows |
| `list_following` | Creators this account follows |
| `list_model_ratings` | Pending rating tasks, which earn fast hours |
| `get_contest_ranking_count` | Contest rounds completed |

### Explore, and the escape hatch

| Tool | What it does |
|---|---|
| `explore_feed` | The public feed, with prompts and image URLs |
| `explore_style_likes` | Which styles this account has liked |
| `api_get` | Any `/api/` path, for endpoints with no named tool yet |

`midjourney-cli which "<what you want>"` resolves a capability described in
words to the command that does it, so you do not have to read this table.

## 7. Spending safely

Reads work freely. What is guarded is spending.

Every generation burns GPU time from a paid plan and there are no refunds, so
`imagine`, `submit_imagine`, `rerun_job`, `vary_image` and `submit_raw_job` take
`confirm: true`, or `--confirm` at the terminal.

Nothing reversible asks. Adding to a moodboard does not, because
`remove_from_moodboard` undoes it, and confirming reversible things is how a
model learns to pass `confirm` by reflex, which defeats the gate on spending.

A generation is not annotated destructive, because it destroys nothing. It has
its own risk level, so a client deciding what to auto-approve is told the truth
about what it is approving.

```
MIDJOURNEY_READ_ONLY=1          removes every tool that is not a read, 17 remain
MIDJOURNEY_ALLOW_DESTRUCTIVE=0  keeps reads and downloads, blocks anything that spends
MIDJOURNEY_AUDIT_LOG=<path>     one JSON line per attempted change, allowed and blocked
```

## 8. Prompts and parameters

Write the subject in `prompt` and everything else as named arguments. Do not put
`--ar` inside the prompt string.

The arguments are validated before anything is spent. Midjourney is not: it
silently ignores or clamps most malformed parameters rather than reporting them,
so a typo costs a generation and comes back looking like a bad result rather
than a mistake.

| Argument | What it does |
|---|---|
| `aspect` | `"16:9"`, `"3:2"`, `"1:1"`. Sent as `--ar` |
| `stylize` | 0-1000. Low follows the prompt, high looks prettier and drifts |
| `chaos` | 0-100. How different the four results are from each other |
| `seed` | Reuse with an identical prompt to iterate on one image |
| `style_refs` | An image URL, a numeric code, or `random`. Sent as `--sref` |
| `omni_refs` | Carry a character or object across images. The v7+ replacement for `--cref` |
| `image_prompts` | Direct image URLs, including `s.mj.run` links, used as visual input |
| `negative` | Things to keep out. Sent as `--no` |
| `raw` | Less automatic prettification. Good for photographic work |
| `draft` | Much faster and cheaper, lower fidelity. Good for exploring |
| `speed` | `fast`, `relax` or `turbo` |

At the terminal, Midjourney's own spellings work as aliases: `--ar`, `--sref`,
`--oref`, `--iw`, `--sw`, `--ow`, `--q`, `--no`, `--v`.

## 9. Moodboards

A moodboard is a curated pile of reference images. Naming one is far more
reliable than describing a look in words, because the board *is* the look.

The loop:

```bash
midjourney-cli create-moodboard "Nordic Skincare | Still Life"
midjourney-cli imagine "<a long, specific style description>" --confirm
midjourney-cli add-to-moodboard "Nordic Skincare" --job-id <job>
midjourney-cli imagine "a ceramic jar of face cream, lid beside it" \
  --moodboard "Nordic Skincare" --sw 400 --confirm
```

After the third line the style is a name, and a nine-word prompt reproduces it.

Partial names work: `"High Fashion"` finds `"High Fashion | Woman"`. An ambiguous
name errors with the candidates rather than guessing, because picking the wrong
board costs a generation to discover. References are sampled across the board
rather than taken from the front, so a 242-image board does not always draw on
its oldest images.

`profile` does something different: it biases toward images the account has
rated, rather than toward a set of pictures.

## 10. How it works

Midjourney publishes no API. The endpoints under `/api/` are the ones its own
web app calls, and they sit behind a Cloudflare interstitial that answers a plain
client with a 403 challenge page rather than JSON.

That challenge is not defeated by a header. The `cf_clearance` cookie is bound to
the IP, the User-Agent and the TLS fingerprint together, so a cookie lifted out
of a browser and replayed from Node is a different client and gets stopped.

So rather than impersonate a browser, this drives one. Requests are issued by
`fetch()` running inside a real midjourney.com page, in a real Chrome that is
really signed in. Same origin, same cookies, same fingerprint, same IP,
credentials attached by the browser itself. There is nothing to spoof because
nothing is being faked.

Chrome 136 stopped honouring `--remote-debugging-port` on the default profile, so
this owns a profile instead: a dedicated `user-data-dir` you sign into once.

Both surfaces are generated from one `ALL_TOOLS` array. `register()` turns a spec
into an MCP tool and `cli.ts` turns the same spec into a shell command, through
the same handler and the same write guard, so a tool added tomorrow is a command
tomorrow and the two cannot drift. A test asserts that.

Downloads are read with an in-page `fetch`, which needs no new tab and no visible
activity. The CDN sends `access-control-allow-origin: *`, so the bytes come back
exactly as served.

## 11. Your data

Nothing leaves your machine except the requests to Midjourney that you asked for.
There is no telemetry, no analytics and no backend.

The session lives in a Chrome profile on your own disk. This process never reads
a cookie, stores a token, or sees a password.

Downloads go where you point them, `~/Downloads/midjourney` by default. The audit
log, when enabled, is a local file.

## 12. Risks

**This is unofficial, and Midjourney's terms do not permit automated access.**
Every unofficial client carries a risk to the account, this one included. It
moves at human pace and acts through a real browser session rather than
imitating one, which is the honest limit of what any tool here can do about
that.

**It spends money.** A loop over twenty prompt ideas is twenty charges. Use
`MIDJOURNEY_READ_ONLY=1` when pointing an unattended agent at the account, and
`MIDJOURNEY_AUDIT_LOG` when you want a record.

**The endpoints are undocumented and can change without notice.** Job records are
parsed defensively and partial answers are preferred to failures, but a large
enough upstream change will still break something.

## 13. Troubleshooting

Start with `doctor`. It orders the checks so the first failure is the one to fix.

| Symptom | Cause |
|---|---|
| `Cloudflare served a challenge` | The interstitial has not been cleared in that profile. Open the window and let it finish once |
| `The browser profile is not signed in` | Signed out, or the session expired. Run `login` |
| `No Chrome or Chromium found` | Chrome is not where it is normally looked for. Set `MIDJOURNEY_CHROME_PATH` |
| `DevTools never answered` | Another Chrome is using that profile directory. Quit it, or set `MIDJOURNEY_CHROME_PROFILE` elsewhere |
| `Midjourney refused ... for billing reasons` | Out of fast hours, or the subscription lapsed. Switch to `speed: "relax"` |
| Job accepted, then never appears | The account is at its concurrent-job limit. Check `get_queue` |
| `had not finished after 600s` | Normal on relax mode. The job is still running; raise `MIDJOURNEY_JOB_TIMEOUT_MS` |
| Every command times out at once | A native dialog was left open in the window. Dialogs are auto-dismissed now; if it persists, close the tab |
| Downloads are empty or fail | The asset URL expired. Re-read the job with `get_job` for fresh URLs |

## 14. Environment variables

Every one of these is optional. The defaults are what you want unless you are doing something unusual.

| Variable | Default | What it does |
|---|---|---|
| `MIDJOURNEY_CHROME_PROFILE` | `~/.midjourney-mcp/chrome-profile` | The browser profile holding the session |
| `MIDJOURNEY_CHROME_PATH` | found automatically | The Chrome binary |
| `MIDJOURNEY_CHROME_LAUNCH` | `1` | Start Chrome on demand. `0` only attaches to a running one |
| `MIDJOURNEY_CDP_URL` | `http://127.0.0.1:9222` | Where DevTools listens |
| `MIDJOURNEY_HEADLESS` | `0` | Run without a window. Sign in first, a window is needed for that |
| `MIDJOURNEY_ORIGIN` | `https://www.midjourney.com` | The site being driven |
| `MIDJOURNEY_USER_ID` | discovered | Skip user-id discovery |
| `MIDJOURNEY_DEFAULT_SPEED` | `fast` | `fast`, `relax` or `turbo` |
| `MIDJOURNEY_DEFAULT_VERSION` | `7` | Model version appended as `--v` |
| `MIDJOURNEY_DOWNLOAD_DIR` | `~/Downloads/midjourney` | Where downloads land |
| `MIDJOURNEY_REQUEST_TIMEOUT_MS` | `30000` | Per-request deadline |
| `MIDJOURNEY_MIN_REQUEST_INTERVAL_MS` | `700` | Floor between requests, jittered |
| `MIDJOURNEY_MAX_RETRIES` | `3` | Retries on 429 and 5xx |
| `MIDJOURNEY_JOB_TIMEOUT_MS` | `600000` | How long to wait for a job |
| `MIDJOURNEY_JOB_POLL_INTERVAL_MS` | `3000` | First poll interval, widening from there |
| `MIDJOURNEY_REFRESH_VIEW` | `1` | Reload the open window after a generation so it shows the new work |
| `MIDJOURNEY_READ_ONLY` | `0` | Hide everything that is not a read |
| `MIDJOURNEY_ALLOW_DESTRUCTIVE` | `1` | `0` blocks anything that spends |
| `MIDJOURNEY_AUDIT_LOG` | unset | Append-only log of every attempted change |
| `MIDJOURNEY_HTTP_PORT` | `8787` | Port for `--http` |
| `MIDJOURNEY_HTTP_HOST` | `127.0.0.1` | Interface for `--http` |
| `MIDJOURNEY_HTTP_TOKEN` | unset | Bearer token. Required to listen off loopback |

## 15. FAQ

<details>
<summary><b>What is an MCP server?</b></summary>

An MCP server is a standard way to give an AI assistant real access to a tool, so it can act rather than guess. You install it once, your assistant gains the tools, and it works in Claude, Cursor, ChatGPT and anything else speaking MCP.

</details>

<details>
<summary><b>What is Midjourney?</b></summary>

Midjourney is an image generation service. You write a prompt, it renders four images, and you refine from there. It runs on the web at midjourney.com and in Discord, on a paid subscription.

</details>

<details>
<summary><b>Does Midjourney have an API?</b></summary>

Midjourney has no public API and has never shipped one. Every "Midjourney API" on sale is an unofficial wrapper around the same web endpoints this server uses, usually running on somebody else's account. This one at least runs on yours, in your browser, on your machine.

</details>

<details>
<summary><b>Is this against Midjourney's terms?</b></summary>

Midjourney's terms do not permit automated access, so yes, and there is no way to build this that does not. Any tool of this kind carries a risk to the account. Decide whether that trade is worth it before installing, and know that no unofficial client can promise otherwise.

</details>

<details>
<summary><b>Do I need to be technical?</b></summary>

You need to be comfortable pasting one command into a terminal and signing in to a website. There is no key to generate, no dashboard to navigate, and no config file to edit by hand.

</details>

<details>
<summary><b>Is my data sent anywhere?</b></summary>

Nothing leaves your machine except the requests to Midjourney that you asked for. The server has no telemetry, no analytics and no backend. Your session lives in a Chrome profile on your own disk and this process never reads it.

</details>

<details>
<summary><b>Can it spend money without me noticing?</b></summary>

It refuses to generate anything without an explicit confirmation on every call, and it records what it attempted when you set `MIDJOURNEY_AUDIT_LOG`. Set `MIDJOURNEY_READ_ONLY=1` and the generating tools disappear from the list entirely, which is the setting to use when pointing an unattended agent at the account.

</details>

<details>
<summary><b>What can it do that the website cannot?</b></summary>

It puts generation into a pipeline. An agent can take a brief, build a validated prompt, wait for the render, download the files and hand them to the next step, without a person clicking through four screens. It also refuses malformed parameters before they cost you a generation, which the website does not.

</details>

<details>
<summary><b>Does it work with ChatGPT and Cursor?</b></summary>

It works with Cursor, VS Code, Codex CLI, Windsurf and anything else that runs a local MCP server over stdio. claude.ai on the web runs connectors from Anthropic's cloud, so it cannot reach a browser on your machine and this is not usable there.

</details>

<details>
<summary><b>Can I run it without a visible browser window?</b></summary>

You can set `MIDJOURNEY_HEADLESS=1` once the profile is signed in, though signing in needs a window, so do that first. Expect Cloudflare to be less forgiving of a headless session than a visible one.

</details>

<details>
<summary><b>Why does it need Node 22?</b></summary>

The browser connection uses the global `WebSocket` that became stable in Node 22. Relying on it means the part of this server that matters most has no dependencies at all.

</details>

<details>
<summary><b>How do I disconnect it?</b></summary>

Remove the entry from your client's config, then delete `~/.midjourney-mcp/chrome-profile` to drop the session. Nothing else is left behind.

</details>

## Questions

Run into a problem or have a question? [Open an issue](https://github.com/navidmoazzez/midjourney-mcp-cli/issues) and I will help.

## About the author 👋

Navid Moazzez is a leading AI business strategist, and the host of the AI Creator Summit, watched by 100,000+ creators. He helps creators and founders master AI and build their own AI Operating System (AI OS) to automate their business and life. This Midjourney MCP server is one piece of that system.

**Links**

- Personal website: [navid.me](https://navid.me)
- Link in bio: [navid.bio](https://navid.bio)
- Navid Media: [navid.media](https://navid.media)
- YouTube: [@thenavidm](https://youtube.com/@thenavidm?sub_confirmation=1) and [@thenavidai](https://youtube.com/@thenavidai?sub_confirmation=1)
- X: [@thenavidm](https://x.com/thenavidm)
- Instagram: [@thenavidm](https://instagram.com/thenavidm)
- LinkedIn: [thenavidm](https://linkedin.com/in/thenavidm)

## Dependencies

| Library | Licence | What it does |
|---|---|---|
| [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) | MIT | The MCP protocol, stdio and HTTP transports |
| [zod](https://github.com/colinhacks/zod) | MIT | One schema per tool, driving both surfaces |

The browser connection uses Node's built-in `WebSocket` and needs nothing else.

## License

[MIT](./LICENSE). Free to use, modify, and share.

Not affiliated with, endorsed by, or sponsored by Midjourney, Inc. Midjourney is a trademark of Midjourney, Inc.

---

© 2026 [NM Media](https://navid.media). Made with ❤️ by [Navid Moazzez](https://navid.me).
