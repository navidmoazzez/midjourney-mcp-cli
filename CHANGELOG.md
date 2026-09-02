# Changelog

## 0.1.0

First release.

- MCP server and CLI over one tool array, so the two surfaces cannot drift.
- Drives a dedicated logged-in Chrome profile over the DevTools Protocol, with no credential handling and no TLS impersonation.
- `imagine` submits, waits for the job and returns the images, optionally saving them to disk.
- Downloads are the real files from the CDN, read back through a browser navigation, rather than screenshots of the rendered element.
- Midjourney's parameter grammar is typed and validated before anything is spent, because Midjourney clamps or ignores bad values instead of reporting them.
- `capture` records what the web app calls, so new tools can be built from observed traffic rather than guesswork.
- Spending is its own risk level, gated behind `confirm`, separate from destructive.
