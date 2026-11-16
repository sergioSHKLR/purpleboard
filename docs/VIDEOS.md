# Walkthrough videos

Every premade scene has two short, captioned videos, played from its Overview tab:

- **How to approach**: symptoms, the measurements to take, where to look. No fix shown.
- **Solution**: the full repair ending with the test bench passing. It plays only after a
  deliberate second click ("Spoilers ahead"), and the flag text is blurred in the recording.

They are real recordings of the app, not mock-ups: `scripts/videos/record.ts` drives the actual
UI in headless Chrome (visible cursor, click rings, caption callouts), captures ~30 fps
screenshots, and encodes H.264 MP4 + WebVTT captions + a poster into `public/videos/`, listed in
`public/videos/index.json`. A solution take fails unless the app really shows the flag, so a
video can never claim a repair that does not work.

Each video teaches, not just demonstrates: an opening card (the circuit, what you will learn,
the tools), numbered steps where every caption has a **Why:** line, highlights on the part, pad
or reading being discussed, and a closing "What you learned" card. Every number a caption quotes
(meter readings, supply current) is read live from the app with `take.expect(selector, regex)`;
if the app shows something else, the take fails instead of recording a wrong caption.

```bash
npx vite --port 5199                                  # the app, in another terminal
npm run videos                                        # all scenes (~10 min)
npm run videos -- --only builtin-ghost-short          # one scene
npm run videos -- --dry                               # run every script and check every reading, no recording (~2 min)
```

Needs Google Chrome (`CHROME_PATH` to override) and ffmpeg with libx264. Re-render after UI
changes; scripts live in `scripts/videos/scenes.ts` (captions in the DEADBOARD voice, see
docs/BRAND.md). The app exposes a small automation API only when opened with `?automation=1`.
