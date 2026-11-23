# Fork roadmap (sergioSHKLR/deadboard)

Current fork version: **0.3.0**. Bump `forkVersion` in `package.json` with each release.

Light fork of [DEADBOARD](https://github.com/tholtman1-del/deadboard) used as a Navy 2M
soldering trainer, played mainly on a Lenovo Duet 11/9 (ChromeOS) with an Xbox controller.
Estimates are developer-days, including tests. Numbers (#) follow the 2M simulator proposal's list
of 10 improvements.

## Done

- **P0: Xbox gamepad support.** Single cursor; holding RT keeps the iron on the joint, and trigger depth sets contact pressure (`160e128`).
- **Settings → Controller.** Button remapping with conflict warnings, stick, iron-trigger and rumble settings, calibration, JSON import/export (`9a2b404`).
- **Controller outline and full-screen controller test.** The button map is drawn as a pad outline with callouts. The test view captures all pad input; hold B for 1 s to exit.
- **Fork version and accent color.** The version is shown in the lower right of the status bar (on phones, under the bench readouts), e.g. `v0.3.0 · <commit>`. It is set at build time from `forkVersion` in `package.json` and the git commit; the upstream `version` is left alone. The accent color is blue-violet (`#8c72ff`) so the fork is easy to tell apart from the original DEADBOARD; heat, solder and warning colors are unchanged.
- **Part of #1:** a default heat mode for controller players exists as a setting in the Controller panel (the default is still "keep the bench setting").

## Next batch

| # | Improvement | Scope | Days |
|---|---|---|---|
| 4 | **Held-iron dwell grading** | Measure how long the held iron (RT) stays on each joint and grade it against a target of about 1.5 s per joint. Show an overdwell warning (and a too-short hint) at the cursor and in the results, with rumble on overdwell. Keep per-joint history. Later: link to the SteadyIron dwell timer's data so bench and sim dwell times can be compared. | 3–5 |

## Backlog (from the proposal, not built yet)

| # | Improvement | Days | Notes |
|---|---|---|---|
| 1 | Realistic mode default for controller players + joint temperature readout at the cursor | 1 | Heat-mode setting done; the default switch and the readout are left |
| 2 | Offline service worker + PWA install | 2–3 | Install from Chrome on the Duet, works without Wi-Fi |
| 3 | Duet layout: controller-first, bigger targets, slim control strip | 3–4 | |
| 5 | Steadiness metric: tremor, drift and path smoothness per joint, with history | 3–5 | Could measure the benefit of the Singer MK1 or SteadyHandTool stabilizers |
| 6 | 2M inspection drill: accept/reject at 10–20×, timed, name the defect | 6–8 | |
| 7 | Solder volume + fillet shape model with Target / Acceptable / Defect grading | 10–15 | The hardest item |
| 8 | Martian Mono / ROV branding + own name | 1–2 | Needs Chief's rename; the DEADBOARD name and logo can't be used |
| 9 | ROV link: practice cards on the 10 soldering lessons + shared progress | 1–2 | Needs Chief's OK |
| 10 | Two simultaneous tools (left-stick tweezers, right-stick iron) | 8–12 | Needs `src/ui/app.ts` split up first |

Total: next batch 3–5 days, backlog 35–52 days.
