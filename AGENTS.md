# Working on this repo

Read `SKILL.md` for how to *use* the server. This file is about changing it.

## The one rule that shapes everything

`src/tools/index.ts` exports one `ALL_TOOLS` array. `tools/kit.ts` turns a spec
into an MCP tool, `cli.ts` turns the same spec into a shell command. Add a tool
to that array and it exists on both surfaces, with flags, help, validation and
the write guard already applied.

Never add a command to `cli.ts` by hand. If a tool needs a nicer shell spelling,
that is a `FLAG_ALIASES` entry, not a second code path.

## Where the risk lives

Everything reaches Midjourney through `CdpBrowser.apiFetch`, which runs `fetch()`
inside a real logged-in page. There is no credential in this process and there
must never be one. If a change introduces cookie handling, token storage or TLS
impersonation, it is the wrong change: the browser is the credential.

`src/api/client.ts` is the only place that talks to the transport. Pacing,
retries and error classification live there so an upstream change is one file.

## Shapes are not contracts

Midjourney publishes nothing. `format/jobs.ts` reads what it recognises, keeps
the untouched record alongside, and never throws because a field moved. Keep
that discipline in anything new: prefer returning a partial answer over failing.

When you need an endpoint that does not exist here yet, do not guess it. Run
`midjourney-cli capture --seconds 60 --out capture.json`, use the site, and read
the real request out of the file.

## Before shipping

    npm run typecheck && npm test && npm run build

Tests use a faked transport and never touch the network. `tests/cli.test.ts`
holds the seam between the two surfaces; if it fails, they have drifted.

Every environment variable the code reads goes in `ENV_VARS` in `config.ts`, in
`--help`, and in the README. A test checks all three agree.
