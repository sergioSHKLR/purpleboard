# PurpleBoard roadmap (sergioSHKLR/purpleboard)

Current fork version: **0.4.0** (shown as `v0.4.0 · <commit>` in the lower right of the status bar). Bump `forkVersion` in `package.json` with each release.

PurpleBoard is a light fork of [DEADBOARD by tholtman1-del](https://github.com/tholtman1-del/deadboard) (Apache-2.0), used as a Navy 2M
soldering trainer, played mainly on a Lenovo Duet 11/9 (ChromeOS) with an Xbox controller.
Estimates are developer-days, including tests. Numbers (#) follow the 2M simulator proposal's list
of 10 improvements.

## Done

- **P0: Xbox gamepad support.** Single cursor; holding RT keeps the iron on the joint, and trigger depth sets contact pressure (`160e128`).
- **Settings → Controller.** Button remapping with conflict warnings, stick, iron-trigger and rumble settings, calibration, JSON import/export (`9a2b404`).
- **Controller outline and full-screen controller test.** The button map is drawn as a pad outline with callouts. The test view captures all pad input; hold B for 1 s to exit.
- **Fork version and accent color.** The version is shown in the lower right of the status bar (on phones, under the bench readouts), e.g. `v0.3.0 · <commit>`. It is set at build time from `forkVersion` in `package.json` and the git commit; the upstream `version` is left alone. The accent color is blue-violet (`#8c72ff`) so the fork is easy to tell apart from the original DEADBOARD; heat, solder and warning colors are unchanged.
- **#8 (renamed part): PurpleBoard name, icon and wordmark (v0.4.0).** The repo is now `sergioSHKLR/purpleboard`, live at https://sergioshklr.github.io/purpleboard/ (the old `/deadboard/` path is not redirected). The app, homepage, manifest and meta tags say PurpleBoard; the wordmark (PURPLEBOARD) uses self-hosted Martian Mono (condensed) and the UI does not use the brand font. New icon in the SHKLR brand kit style: Lucide "square-activity" (a rounded square with a pulse line), violet #7c3aed on white (light) and #a78bfa on #1a1a1a (dark), with a favicon that follows the tab's color scheme (`src/ui/brand-icon.ts`, `docs/brand/purpleboard-*.svg`). Upstream-authored lessons keep their "DEADBOARD" author credit.
- **Meter probes on A / B (v0.4.0).** With the multimeter selected, A places the red probe and a tap on B places the black probe; holding B for 0.6 s (or Esc, the on-screen clear, or the menus) cancels. With every other tool B is plain Cancel, and LT is only Feed solder. Black probe is its own remappable action (`blackProbe`); saved keymaps from before move it onto their Cancel button.
- **Part of #1:** a default heat mode for controller players exists as a setting in the Controller panel (the default is still "keep the bench setting").
- **Upstream gamepad as draft PR (invited in #6); mods deferred.** Draft PR: https://github.com/tholtman1-del/deadboard/pull/7 (branch `gamepad-controls`, gamepad files only, no PurpleBoard branding).
- **Why gamepad.** Main use is a 2M soldering trainer on the Lenovo Duet (ChromeOS). The pad simulates the added difficulty and physicality of a soldering iron (a held tool, pressure, dwell, limited precision) versus a mouse on a flat surface: a steady left-stick cursor, an analog RT iron, and big buttons for probes and tools, with fine mode (hold LB / L3) and remapping for deliberate control. Later this ties into SteadyIron dwell and steadiness metrics.
- **Safety violations: buzzer and a safety score.** Each board starts at 100 safety points. With the supply on, the soldering iron (−10), desolder wick (−10) or isopropyl (−15) touching the board is a violation, and so is a short made by a live iron, wick or jumper edit (−20). In realistic rework, overheat damage (a lifted pad, an overheated part or a cracked MLCC from holding the iron or hot air too long) also costs −10. Each contact counts once (1.5 s debounce). A violation triggers a Web Audio buzzer, a red flash around the bench, a toast and controller rumble. The Mission tab shows a Safety card with the score and a breakdown, and the "Board fixed" banner shows the score. Settings → Safety buzzer mutes the sound; the points are taken either way. One check covers mouse, touch and controller (`src/safety.ts`, `test/safety.test.ts`). It does not change the skill rating.
- **Mandatory safety brief before every board exercise.** Each time a board loads (picked, opened from a link, Reset, or a new generated problem), a safety brief has to be acknowledged ("I understand, start") before the board can be used. It works with mouse, touch, keyboard (Enter) and the controller (A). Its items come from the board's data (`safetyBriefFor` in `src/safety.ts`), not text written per board. Every powered board gets "power off first", and every board gets "heat only as long as needed". Items are added for a supply of 5 V or more or a fuse (short risk), several supply inputs, capacitors of 100 µF or more (stored charge), large ceramic caps (thermal shock), tiny parts (hot air), liquid residue (isopropyl is flammable), ICs (ESD, advice only), and anything above 60 V (high voltage; no current board). Short brief: 2 items or fewer (e.g. First Light); standard: 3–4 (e.g. Ghost Short); full: 5 or more (e.g. MNT Reform, 9). Penalty numbers come from the safety-score constants.
- **Meter safety rule and brief emojis.** On a powered board, placing a probe on copper with the meter in Ω, diode or capacitance mode costs −10, with the same feedback as the other violations. It fires only when the meter is the active tool and the probe just placed lands on copper on the visible side; selecting a mode, switching power on, a probe off copper, and probes left over from earlier never count. Voltage and in-series current stay allowed live, and the ERR display stays. The brief's power-off item now says "and for Ω / diode / C checks (−10)". Each brief item has an emoji (hidden from screen readers): 🚫 power off, ⚡ short or high voltage, 🔌 several supplies, 🔋 stored charge, 🔥 heat, ceramic cracking and hot air, 💧 isopropyl, 🧤 ESD advice.

## Next batch

| # | Improvement | Scope | Days |
|---|---|---|---|
| 4 | **Held-iron dwell grading** | Measure how long the held iron (RT) stays on each joint and grade it against a target of about 1.5 s per joint. Show an overdwell warning (and a too-short hint) at the cursor and in the results, with rumble on overdwell. Keep per-joint history. Later: link to the SteadyIron dwell timer's data so bench and sim dwell times can be compared. | 3–5 |
| 4a | **Held-iron sway / aim instability** | Held-iron sway / aim instability (software only): small low-amplitude drift or breathing-style oscillation on the cursor while the RT iron is held. Scale with trigger pressure or time-on-joint; suppress in fine mode (LB/L3). Optional mild rumble. Hooks in the gamepad cursor update / iron contact handler. ~0.5–1 day. Simulates the physical difficulty of a held soldering iron versus a mouse on a flat surface. No hardware gyro required (Xbox controllers have none; Gamepad API has no pose). | 0.5–1 |
| 4b | **More safety rules (deferred)** | Meter probes shorting pins: the meter is high-impedance in the sim, so probes can't short; needs a "probe slip" model first. ESD / wrist strap: the sim has no ESD concept (only IC pin ESD diodes in the SPICE model), so it would be a new system. Iron left on or unattended: there is no iron-on state or idle timer yet. Overdwell warnings before damage come with #4. Idea: current (A) mode across a supply (the meter already shows "OL, the meter fuse would blow" above 10 A) could cost −20 like a live short. | 1–3 |

## Backlog (from the proposal, not built yet)

| # | Improvement | Days | Notes |
|---|---|---|---|
| 1 | Realistic mode default for controller players + joint temperature readout at the cursor | 1 | Heat-mode setting done; the default switch and the readout are left |
| 2 | Offline service worker + PWA install | 2–3 | Install from Chrome on the Duet, works without Wi-Fi |
| 3 | Duet layout: controller-first, bigger targets, slim control strip | 3–4 | |
| 5 | Steadiness metric: tremor, drift and path smoothness per joint, with history | 3–5 | Could measure the benefit of the Singer MK1 or SteadyHandTool stabilizers |
| 6 | 2M inspection drill: accept/reject at 10–20×, timed, name the defect | 6–8 | |
| 7 | Solder volume + fillet shape model with Target / Acceptable / Defect grading | 10–15 | The hardest item |
| 8 | ROV branding (rest of #8) | 0.5–1 | Name, icon and Martian Mono wordmark done in v0.4.0; ROV-matched colors/links left |
| 9 | ROV link: practice cards on the 10 soldering lessons + shared progress | 1–2 | Needs Chief's OK |
| 10 | Two simultaneous tools (left-stick tweezers, right-stick iron) | 8–12 | Needs `src/ui/app.ts` split up first |

Total: next batch 3–5 days, backlog 34.5–51 days.
