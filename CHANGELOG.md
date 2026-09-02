# Changelog

## 1.0.0

First release.

- MCP server and CLI generated from one tool array, so the two surfaces cannot drift. 27 tools on each.
- Drives a dedicated logged-in Chrome over the DevTools Protocol. No credential is handled, and no TLS impersonation is involved: `cf_clearance` is bound to IP, User-Agent and fingerprint together, so replaying a cookie could never have worked.
- `imagine` submits, waits for the job and returns the images, optionally saving them to disk.
- Job status comes from Midjourney's own status endpoint rather than being inferred, so a running job reports as running.
- Downloads are the real files from the CDN, read with an in-page fetch. No new tab, no visible activity, and not a screenshot of the rendered element.
- Moodboards are first class: create one, add a job's renders to it, then name it on a later generation to reproduce the look from a short prompt.
- Midjourney's parameter grammar is typed and validated before anything is spent, because Midjourney clamps or ignores bad values instead of reporting them.
- `capture` records what the web app calls, so new tools come from observed traffic rather than guesswork. Every write endpoint here was found that way.
- Spending is its own risk level, gated behind `confirm` and separate from destructive, so a client deciding what to auto-approve is told the truth.
- Native browser dialogs are auto-dismissed. One left open freezes the renderer and every command times out, including the ones that would clear it.
