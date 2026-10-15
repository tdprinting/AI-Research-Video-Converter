# Video Shrinker

A browser-based converter that turns long iPhone videos into small MP4 files you can upload to Claude for video research, while keeping as much picture quality as the size limit allows.

Everything runs locally in the browser with [WebCodecs](https://developer.mozilla.org/docs/Web/API/WebCodecs_API) through [Mediabunny](https://mediabunny.dev). Videos are never uploaded, and hardware encoders are used where the device has them, so it is fast even for long clips.

## Using it

1. Open the page (see **Hosting**) in Safari on iPhone (iOS 17+) or a recent Chrome, Edge or Safari on a computer.
2. Choose a video. iPhone `.MOV` files (HEVC or H.264, including portrait) work.
3. Pick a max size per file (30 MB by default), how many files to split into, and a priority.
4. Check the plan, press **Convert**, then **Save** each file. Keep the tab open and the screen on while it runs.

## How it keeps quality high

- **Exact budgeting.** It computes the bitrate the size cap allows (after audio and MP4 overhead), then searches resolution × frame rate combinations for the one that gives each frame the most detail.
- **Frames over motion.** "Sharpest frames" drops the frame rate before the resolution. AI models sample individual frames, so clear frames matter more than smooth motion. Use "Smooth motion" if you need it.
- **No wasted pixels.** Output is capped at 1080p and ranked by useful pixels (about 1.4 MP), because models resize bigger frames anyway.
- **Lean audio.** Speech is encoded as 32 kbps mono AAC so more of the file goes to the picture. A WASM AAC encoder is loaded only on browsers without a native one.
- **Guaranteed fit.** If the encoder overshoots the limit, that file is re-encoded at a corrected constant bitrate.
- **Splitting.** "Auto" picks the fewest files that each stay at good quality and at least 720p.

## Install on iPhone

Open the page in Safari, tap **Share**, then **Add to Home Screen**. It opens full screen like an app and keeps working offline once loaded. After converting, **Share** sends the file straight to Photos, Files or the Claude app.

## Hosting

It is a static site with no build step. To publish with GitHub Pages: **Settings → Pages → Deploy from a branch → `main` / root**. To run locally, serve the folder with any static server, e.g. `python3 -m http.server`, and open http://localhost:8000.

## Development

- `js/planner.js` – pure planning logic (bitrate, resolution, fps, splitting).
- `js/app.js` – UI and conversion.
- `vendor/` – Mediabunny 1.60.0 and its AAC encoder extension (MPL-2.0, licenses alongside).

Run the planner tests with `node --test tests/*.test.mjs`.
