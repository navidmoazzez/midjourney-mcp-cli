# Changelog

## 1.2.0

- `moodboard` now applies a board the way the web app does, as a personalization code, rather than sampling its images into `--sref`. The code is the board id with an `m` prefix, which is neither documented nor guessable; the sref approximation only registered at a high `--sw`, and that weight was what made output look over-processed.
- Default model is v8.2, the current one. It was a version behind.
- `stylize`, `chaos`, `weird` and `style_weight` are no longer encouraged by their own descriptions. Midjourney's defaults sit near the minimum and raising them costs fidelity.
- SKILL.md carries the craft: what to specify in a prompt so the model is not left inventing it, which of the four styling tools fits which job, and the explore-to-finish pipeline through vary, remix, zoom, upscale and animate.

## 1.1.0

Five job types, read out of the web app's compiled bundle rather than guessed or clicked.

- `upscale_image`, `animate_image` (image to video), `pan_image`, `zoom_out` and `remix_image`.
- The upscaler name is version-specific and not what the menu says: a v8.1 image wants `v8r1_2x_subtle`, not `subtle`. It is derived from the job's own model version now.
- Video nests its source under `parentJob` as `image_num`, not the flat `index` every other type uses, and `newPrompt` carries the image's prompt rather than the motion. A motion note is appended to the original instead of replacing it.
- Video files live under `/video/<job>/<n>.mp4`, so deriving image names for a video job produced four URLs that all 404. `download_job` handles both.
- Filenames no longer repeat the index: `<job>-0.mp4`, not `<job>-0-0.mp4`.

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
