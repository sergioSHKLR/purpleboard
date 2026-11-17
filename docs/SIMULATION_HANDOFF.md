# DEADBOARD — handoff (updated 2026-11-17, after the mobile / touch release)

Goal: make DEADBOARD (formerly PCB//FIX) a realistic board-repair trainer, as close to a real bench as possible,
**universal** (any board, not just the MacBook), with honest provenance for every value.
No reference hardware is available, so realism is validated against *design intent*
(schematic/BOM values, rail names, datasheets) and physics checks — not measurements.

## Status (start here)

- **Mobile / touch (2026-11-17, live; commits `01257be` + `a11a4b3`).** Goal: playable on phones in
  the browser first (this stage), App Store release later. The user said **leave the desktop
  version unchanged**: every mobile change is gated, and the desktop DOM was checked identical
  to the previous build (whitespace aside) with the meter, probes and board list in use.
  - **Switch** (`wantsMobileLayout`, `src/ui/touch.ts`): mobile layout on touch-only devices
    (`(pointer: coarse)` and no `(any-pointer: fine)`); `?mobile=1` / `?mobile=0` force it.
    `PcbApp.mobile`; `body.is-mobile` + `.layout.mobile` scope all mobile CSS (end of
    `src/ui/styles.css`); mobile-only markup comes from conditionals in `buildDom` /
    `mobileDockHtml` / `mobileMoreHtml` / `rotateHintHtml` (desktop markup untouched).
  - **Touch input (any layout)**: `TouchGestures` — tap = active tool (`touchTap`), 1 finger
    pans (orbits in 3D), 2-finger pinch zooms + pans, a leftover finger after a pinch does
    nothing, `pointercancel` ends without a tap. Mouse code path unchanged. Page zoom is blocked
    on mobile (`touch-action: pan-x pan-y`, iOS `gesturestart`), the board has its own pinch.
  - **Phone layout**: top bar = logo · board picker · power · Run tests (▶) · panel (flag) ·
    More (⋯). More sheet holds view / display / bench / board / app controls (the desktop
    top-bar elements are *moved* into it, listeners intact; icon buttons are proxied via
    `data-proxy`). Tool strip with labels (bottom in portrait, left in landscape; undo/redo
    pinned, reset in More). Panel = bottom sheet (portrait) / right drawer (landscape); opens on
    Select-tap of a part, Run tests, and on loading a non-tutorial board. Floating Fit · 2D/3D ·
    side buttons. Instruments stacked in `.m-hud` (scope, supply folded to one line — tap for
    chart — and meter). Board refits when the canvas shape changes (`refitOnShapeChange`).
    Phones in portrait (≤ 600 px) get a "Turn your phone sideways" overlay (CSS only; "Keep
    portrait" → localStorage `pcbfix_portrait_ok`). Modals full screen.
  - **Meter on touch**: probe tags on the meter pick which probe the next tap places
    (`activeProbe`); in two-probe modes red auto-advances to black and back.
  - **Text: shorter, not smaller** (user asked explicitly not to just shrink the font):
    tutorial steps have a hand-written `phone` task in `src/ui/tutorial.ts` (≤ 70 chars, no
    coordinates, no mouse words — tested), explanation behind "Why?"; `touchCopy` rewrites other
    copy (click → tap, right-click → black probe, shortcut keys removed); `TOOL_TIP_PHONE`;
    toasts > ~90 chars show the first sentence + More (`splitLead`); meter / scope / supply
    explanations on one line (tap for all); Inspector notes (`.callout`) fold to their heading.
    **New tutorial steps need a `phone` text** or `test/touch.test.ts` fails.
  - **Board list on phones** (`phoneCatalogSection`): one row per board (lesson / difficulty
    badge, title, 2-line description without the "Beginner Tutorial N:" prefix, status),
    filters on one scrolling line, Blank / Import / Mods in a bottom bar (header + 2 columns in
    landscape).
  - **Install**: `public/app.webmanifest` + `public/icons/icon-{180,192,512}.png` (from
    `desktop/icon.png`); manifest link injected only on mobile (no desktop install prompt);
    apple-touch-icon / web-app metas and `viewport-fit=cover` in `app.html`, safe-area insets in CSS.
  - **Testing**: only headless Chrome with phone emulation so far (`isMobile`, `hasTouch`,
    CDP `Input.dispatchTouchEvent` for pinch; 390×844, 844×390, 360×740, 820×1180 tablet).
    **No real phone yet.** WebGPU needs a secure context, so a phone on `http://<LAN-IP>` gets no
    `navigator.gpu`: test on the Pages site (or an HTTPS tunnel). Needs iOS 26+ (any iOS browser)
    or Chrome 121+ on Android 12+; the WebGPU error card has phone-specific advice. Desktop
    check recipe: build HEAD in a `git worktree` (symlink `node_modules`), serve both builds with
    `vite preview`, compare `#app.innerHTML` with whitespace collapsed after the same actions.
  - **Open (mobile)**: (1) real-device test on iPhone + Android, collect the user's screenshots;
    (2) landscape phones are still tight (tutorial card + instruments cover part of the board);
    (3) Overview / Inspector / Author panel content itself is not yet condensed for phones;
    (4) performance on phones unmeasured (DPR capped at 2; big demo boards may be slow);
    (5) App Store: wrap the web build (e.g. Capacitor / WKWebView on iOS 26+, which has WebGPU),
    decide offline bundling, icons / splash, store listing — not started.

- **Mods (2026-11-17):** `deadboard-mod/1`, data-only packages (folder or .zip with `mod.json`)
  of boards (.kicad_pcb / .brd / .pcbfix.json) + optional BOM CSV (R/C values, DNP via
  `applyBom` in `src/io/bom.ts`) + optional schematic (PDF / image, floating viewer). Loader in
  `src/mods/` (own zip reader/writer with size caps, manifest validation listing every error).
  In the app: Boards → **Mods** window (install .zip into IndexedDB, remove, warnings), "Community
  Mods" section, **Export as mod** (Author tab; a built-in board gets its own id). A
  `.pcbfix.json` keeps its id (flag lock); imported boards get `mod-<mod>-<board>`. Example mod
  `examples/mods/starter-kit/` (`npm run example-mod` rebuilds its challenge +
  `public/examples/starter-kit.zip`); `test/mods.test.ts` (17th suite). Guide: `docs/MODDING.md`,
  rendered into the site page `modding.html` at build time (vite plugin, `marked`).

- **Session 2026-11-17 in one line:** all work is pushed and live (last code commit `257debd`:
  mods + the modding guide page `modding.html`, linked from the homepage). Earlier that day: Both-view
  X-ray (`826a8c0`), inverted left/right when looking up at the underside (`b031184`), issue #1
  closed, feedback form verified. No open issues.
- **Possible bug to check first:** on a net nothing drives (night-light challenge from the starter
  kit, SW1 open, probe R1.1), the multimeter reads exactly `+1.000 V`; a real meter shows about 0 V.
  Probably how the fast solver reports a floating node. Reproduce, fix, add a test.

- **Released 2026-11-16 as v0.1.0**: public repo https://github.com/tholtman1-del/deadboard
  (Apache-2.0), live site https://tholtman1-del.github.io/deadboard/ (homepage `index.html` +
  bench `app.html`). `.github/workflows/pages.yml` runs `npm test` + `npm run build` and deploys
  on every push to `main`. The release carries the showcase MP4 (`docs/media/*.mp4` is
  git-ignored; upload with `gh release upload v0.1.0 <file> --clobber`).
- **Content:** 11 built-in scenarios (5 beginner lessons added 2026-11-16: Cold Joint 101,
  Solder Bridge 101, One-Way LED, Resistor & Ohm's Law, Voltage Divider 101) + 2 open-hardware
  demos (MNT Reform 2 mainboard, Antmicro Jetson baseboard; `docs/DEMOS.md`).
- **Videos:** walkthroughs for 8 scenes (approach + spoiler-gated solution), captions explain
  each step and every quoted reading is checked live (`docs/VIDEOS.md`). The 5 beginner lessons
  have **no videos yet**.
- **Showcase video** (`scripts/promo/{stage,showcase}.ts`, `npm run showcase`): motion-graphics
  stage around the live app, recorded slow (`--slow 2.5`) and retimed to 30 fps; writes
  `docs/media/deadboard-showcase.{mp4,gif}` + poster. Starts at the 3D fly-in; `--hook` keeps
  the 3 s thermal cold open. Outro shows the site and repo URLs.
- **Recording tip:** a dev server reloads on every source save, which kills long recordings.
  Record against a frozen build instead:
  `npx vite build --outDir <tmp>/dist && npx vite preview --outDir <tmp>/dist --port 5299`,
  then `--base http://localhost:5299`.
- **Bug fixes after release (2026-11-16, live on the site):**
  - `71e63ff` 3D orbit is grab-and-turn by default (board follows the drag, `Camera.orbit`).
    The old camera-style movement is a toggle next to 2D/3D (`#btn-invert-orbit`, rotate icon,
    `Camera.invertOrbit`, saved as localStorage `pcbfix_invert_orbit`). The showcase recorder's
    orbit call was sign-flipped so the recorded move is unchanged.
  - `71e63ff` "WebGPU is not available" card gives Firefox-specific steps (`App.webGpuHelp()`:
    update Firefox, `about:config` → `dom.webgpu.enabled`, driver / `about:support`).
    Firefox reports "Intel Mac OS X" even on Apple silicon, so the text can't tell those apart.
  - `3b68f5f` "Both" view: through-hole pads (`layers === 'FB'`) are now drawn on both panels
    (mirrored on the back, with drill). Before, pins and mounting holes of top-side parts were
    missing from the back panel, which read as "vias invisible". Vias themselves were fine; at
    the Both fit zoom they are just half the size of the Bottom view.
- **Second round (2026-11-17, live):**
  - `1e90dbe` Bottom-side domes (solder blobs, joint fillets, bottom LED lenses) were invisible:
    a negative Z scale mirrors the mesh, flips winding, and back-face culling dropped the outside.
    `InstanceBucket.pushTRS` now also mirrors Y when `sz < 0` (a rotation; all unit meshes are
    Y-symmetric). Closed GitHub issue #1.
  - `f389b74` Inner-layer copper of imported KiCad boards is kept as display-only `Board.inner`
    (tracks + filled pours, pours simplified to 0.05 mm): X-ray draws every inner layer (one tint
    each, pours under tracks, above the outer pours), and a selected net with hidden copper is
    overlaid on the viewed face. Connectivity / flags unchanged; demos rebuilt (+~1 MB each).
  - `d8fe40c` Frost / IPA film drawn per thermal cell on the board (`ThermalModel.forEachFilm`),
    so the wet patch visibly dries from hot spots outward (physics was already per cell).
  - `3e1ac56` No-WebGPU card: Chrome/Edge-on-Linux advice (flags + Vulkan driver).
  - `03b8f9a` In-app **Feedback** (speech bubble in the top bar, help modal, homepage footer
    `app.html?feedback`, no-WebGPU card): bug / idea + optional contact + optional diagnostics,
    sent by FormSubmit to the build setting `VITE_FEEDBACK_TO`, fed on Pages from the
    **repository** variable `FEEDBACK_TO` (not an environment variable: the build job has no
    environment). It holds FormSubmit's random alias, not the address, so the public bundle has
    no email; activated and tested 2026-11-17. Never put the address in source (a session privacy
    guard also refuses it). Local builds: `.env.local` (git-ignored); `src/ui/feedback.ts`. Unset → prefilled GitHub
    issue (`.github/ISSUE_TEMPLATE/{bug_report,suggestion}.yml`), also offered as secondary route.
  - `635c2c5` IR view: the board surface is drawn from the thermal grid (one vertex per cell, colours
    interpolated, near-ambient cells fade out) instead of per-part halo discs; copper pours take
    their net colour in IR / voltage views. Palette is fixed 24–119 °C (no auto-range yet).
  - Both + X-ray: each panel also shows the opposite face's copper (tracks, pours, single-side
    pads, blobs) faintly and mirrored, as single-side X-ray shows the far side through the board
    (`ghost` / `GHOST_Z` in `src/render/webgpu.ts`, just above the panel's own pours).
  - 3D orbit, left/right while looking up at the underside: after orbiting over the edge the
    camera sits at negative pitch in the back frame (= the positive-pitch view turned 180° on
    screen), so yaw read mirrored. `Camera.orbit` flips the yaw sign at negative pitch (±5°
    dead zone); same for tilting past face-on. `test/camera.test.ts` (16th suite) checks the
    board's near edge follows the drag in every pose, and with the invert toggle.
- **Linux check (2026-11-17):** production build in the Playwright Linux image (Ubuntu 24.04,
  arm64) under Colima: Chromium on SwiftShader and Firefox 146 on Mesa llvmpipe Vulkan
  (`mesa-vulkan-drivers`, `dom.webgpu.enabled`) render everything with no page errors. Colima only
  mounts `$HOME`, so pipe scripts in via stdin and `docker cp` results out. Real GPU drivers untested.
  Recipe: `colima start`; `docker run -i --ipc=host -v $PWD/dist:/site:ro
  -v $PWD/node_modules/playwright-core:/pw:ro mcr.microsoft.com/playwright:v1.58.2-noble
  node --input-type=module < script.mjs` (script serves /site on :8080 and imports `/pw/index.mjs`;
  Chromium flags `--enable-unsafe-webgpu --enable-features=Vulkan --use-vulkan=swiftshader
  --use-webgpu-adapter=swiftshader --enable-unsafe-swiftshader`; for Firefox
  `apt-get install mesa-vulkan-drivers xvfb`, run under `xvfb-run`, prefs `dom.webgpu.enabled`,
  `gfx.webgpu.ignore-blocklist`). Software GPUs run the Reform at 1–4 fps. `colima stop` after;
  the image (3.7 GB) stays cached in the VM.
- **Ad-hoc screenshot scripts** (macOS Chrome, `?automation=1` → `window.deadboard` API in
  `App.exposeAutomation`): write them as `.mts` in the scratchpad and import playwright-core by
  absolute path (`<repo>/node_modules/playwright-core/index.mjs`); tsx injects `__name` into
  named inner functions, so pass `page.evaluate` a string when it defines functions. Reading a
  WebGPU canvas back via `createImageBitmap` returns black; judge renders from screenshots.
- **Testing in stock Firefox** (Playwright's `moz-firefox` channel can't start inside the Claude
  Code sandbox): launch through Launch Services so Firefox runs outside the sandbox, then drive it
  over WebDriver BiDi with a raw WebSocket client (`session.new` → `browsingContext.create` →
  `navigate` / `input.performActions` / `captureScreenshot`; always `session.end`, Firefox allows
  one session):
  `open -n -a Firefox --args --no-remote --profile <tmp-profile> --remote-debugging-port 9333 --new-instance`
  then connect to `ws://127.0.0.1:9333/session`. Put `user_pref("dom.webgpu.enabled", false);` in
  the profile's `user.js` to see the no-WebGPU card.
- **Private fixtures:** see Data / licensing. Before every push, check images and copy (not only
  code) for anything derived from them: a MacBook render once reached the public homepage.

### Next steps (proposed)

- **Mobile first** (the user's current focus): test on a real phone via the live site, fix what
  the screenshots show, then the open mobile items above (landscape, panel content, performance),
  then the App Store wrapper.
- **Sim expansion idea: ESP32 board** (user, 2026-11-17; not started, nothing ESP32-related in
  the project yet). ESP32 boards are what many hobbyists actually repair, so one would be a
  strong "real hardware" scenario next to the Reform / Jetson demos. Plan:
  - Source: an open-hardware ESP32 dev board with KiCad files and a licence that allows
    redistribution (candidates to check: Olimex ESP32 boards, other KiCad-native open designs);
    import through `npm run demos` like the existing demos (`scripts/build-demos.ts`, pinned
    commit, credits + licence in `public/demos/`).
  - Model: the ESP32 module is a **black box** (no firmware): a 3.3 V load with a plausible idle
    / active current (estimate, labelled), its pins as nets. What gets simulated is the support
    circuitry: USB 5 V input, 3.3 V LDO (e.g. AMS1117-class), USB-UART bridge, EN / IO0
    auto-reset transistors, decoupling, LEDs. Check `src/spice/devicelib.ts` for the LDO and
    USB-UART parts; add datasheet specs with `verified: false` like the others.
  - Faults that fit (all existing fault classes): dead or shorted LDO (`ic-rail-short`), shorted
    3.3 V decoupling cap (thermal camera / injection finds it), cracked joint on the USB connector
    (intermittent), broken auto-reset path (board powers but won't enter flash mode: needs a new
    objective type, e.g. "IO0 low while EN rises"), reversed / missing protection diode.
  - Open question: a "flash mode" / "boots" objective would need a small behavioural model of
    the ESP32 strapping pins (IO0, EN, IO2, IO12 at reset), still without running firmware.
- **Sim expansion idea: car ECU, EDC15 / EDC16-style** (user, 2026-11-17; not started). Engine
  control units are a large share of real paid board repair, and their typical faults are
  electrical, which is what the simulator does well.
  - **Legal / data:** EDC15 / EDC16 are proprietary Bosch designs: no public board files or
    schematics, so (like the MacBook fixtures, see Data / licensing) nothing of theirs can ship.
    Build an **invented board with a typical diesel-ECU architecture** (Builder or KiCad), named
    generically (e.g. "Diesel ECU, EDC-style"); check that using the EDC name in a description is
    acceptable before release.
  - **Typical architecture to model:** 12 V vehicle supply with terminal 30 (battery) and 15
    (ignition), reverse-polarity / transient protection, main-relay driver, 5 V regulator for the
    microcontroller and a separate 5 V sensor supply, analog sensor inputs (pull-ups / dividers /
    RC filters), injector and solenoid power stages (MOSFET / transistor drivers into inductive
    loads with flyback / clamp diodes), CAN + K-line transceivers. The microcontroller is a
    black box (no firmware, no immobiliser / EEPROM data), like the ESP32 idea above.
  - **Faults that match real ECU repairs** (all from existing fault classes): cracked joints from
    heat cycling and vibration (`thermal-open`, `flex-open`: Press tool, freeze spray / hot air),
    dead 5 V sensor-supply regulator or shorted sensor line, failed injector / solenoid driver,
    shorted CAN transceiver (no communication), corrosion from water ingress (residue, IPA),
    blown protection diode after a reverse jump-start. Verify the list against ECU-repair
    sources before writing scenario text; keep severity values labelled as estimates.
  - **New pieces needed:** a bench-harness setup (supply 12–14 V on terminals 30 / 15 / ground,
    like real bench ECU testing), inductive loads in the board → SPICE path (L is supported by
    the engine), objectives such as "sensor supply 5 V present", "CAN transceiver powered and not
    shorted", "injector driver switches" (scope, synthesized PWM like the converter switch node),
    and optionally conformal coating that must be removed before rework.
- **More expansion ideas** (proposed by Claude 2026-11-17 when the user asked for more; the user
  has not picked any yet, so ask). Claude's suggested order: Arduino Uno-style board first, then
  known-good comparison, then repair-shop mode.
  - Boards:
    - **Arduino Uno-style board:** open hardware (Eagle files; KiCad ports exist; check the
      licence and credit). Classic first repairs: dead 5 V regulator, blown USB polyfuse, dead
      USB-serial chip, reverse-polarity diode. Bridges the tutorials and the big demos; needs
      nothing new in the engine.
    - **3D-printer mainboard:** open designs exist (e.g. Prusa Einsy, licence to check). Faults:
      burnt heated-bed MOSFET (the thermal camera finds it), melted power connector, dead stepper
      driver, broken thermistor input.
    - **Mains switching PSU** (TV / charger / LED driver): the most common real repair (bulging
      caps, shorted switching transistor, blown fuse, open start-up resistor) and the place to
      teach safety (discharge the bulk cap, isolation transformer). Needs a mains flyback /
      switching model: more work than the two above.
    - **Guitar pedal / small audio amp:** simple analog, many open designs; signal tracing with
      the scope instead of power-fault hunting.
  - Features:
    - **Known-good comparison:** reference readings (diode mode / resistance to ground per net)
      from the healthy board, as real repairers compare against a good board or boardview values;
      works on every board and builds on `src/spice/dmm.ts`.
    - **Repair-shop mode:** customer tickets with a symptom ("dead after a coffee spill", "works
      only when cold"), time budget, parts cost; turns the scenarios into a campaign (good for
      Steam, see `desktop/STEAM.md`).
    - **Microscope tool:** magnified inspection where cracked joints, corrosion and bridges are
      only visible up close.
0. Thermal view polish (user said "not for now" on 2026-11-17, so ask first): auto-range IR
   palette (real cameras rescale to the scene; a 45 °C spot is faint on the fixed 24–119 °C
   scale), and show sub-ambient cold spots from IPA / freeze spray (palette floor is 24 °C).
1. Walkthrough videos for the 5 beginner lessons (`scripts/videos/scenes.ts`, `npm run videos -- --dry` first).
2. Full-board regression tests on the open demo boards, replacing the private MacBook coverage.
3. Real bench data: `npm run calibrate` with measurements from one known-good board.
4. Two-layer thermal model still open (below).
5. Browser support: Firefox 160 on macOS verified 2026-11-16 (render, 3D orbit, wheel zoom).
   Firefox without WebGPU (older versions, Linux, Intel Macs, blocklisted GPUs) gets a tailored
   how-to on the error card; a WebGL2 fallback renderer would make it work there out of the box.
   Linux checked 2026-11-17 (see above). Safari still untested. Open: a customer reported Firefox not working; it works here, so it is
   likely their setup. Ask for Firefox version, OS and `about:support` → WebGPU before building
   the WebGL2 fallback (renderer GPU code is isolated: init, `ensureAttachments`, `render()` in
   `src/render/webgpu.ts`; scene building is API-agnostic; 3 small WGSL shaders to port).
6. Player feedback now arrives by email (Feedback form) and as GitHub issues: check both at the
   start of a session (`gh issue list`).
7. Launch: Reddit posts drafted (kept outside the repo); trademark/domain clearance for the name not done.

## How to run

```bash
npm test                 # 18 suites, all passing (private-fixture parts skip when absent)
npm run showcase         # re-record the showcase video (needs a running site; see Status)
npm run videos           # re-render walkthrough videos (needs the dev server; docs/VIDEOS.md)
npm run demos -- --fetch # rebuild the open-hardware demo boards (docs/DEMOS.md)
npm run calibrate -- <board.brd> <measurements.csv>   # model vs bench readings (template: docs/measurements.template.csv)
npm run build            # typecheck + production build
npx vite --port 5199     # dev server → http://localhost:5199 (WebGPU: use Chrome)
npm run spice -- "board_schemas/J113  820-00165.brd" --quiet --behavioral --states --supply PPVBAT_G3H_CONN=8.4:0.05
npm run schematic -- <schematic.pdf | bom.csv> <board.brd> --list | --product 639-00623
```

Browser automation for UI checks, videos and the showcase: Playwright (`playwright-core`
devDependency) driving the local `/Applications/Google Chrome.app` headless with
`--enable-unsafe-webgpu --use-angle=metal` (`CHROME_PATH` to override). Ad-hoc screenshot
scripts lived in the session scratchpad; recreate as needed.

## What exists (all test-covered)

| Area | Files | Notes |
|---|---|---|
| SPICE engine | `src/spice/{engine,devices,sparse,netlist,expr,units,types}.ts` | MNA + sparse Markowitz LU; .op/.dc/.tran; R C L V I D M Q S E G X B; ngspice-compatible decks; gmin/source stepping + pseudo-transient continuation; warm start |
| Board → SPICE | `src/spice/board.ts`, `adapter.ts` | game faults honoured (burnt, cold, reversed, leak, drift, resistive cold joints), ESD pin model, injection supply, meter loading |
| Schematic / BOM import | `src/io/{pdf,schematic,schematicLibrary,bom,schematic-cli}.ts` | Concept-HDL PDFs (Apple style) incl. BOM configurations / NO STUFF; universal CSV BOM path |
| Device library | `src/spice/{devicelib,resolveParts}.ts` | datasheet specs → fitted models; pins = datasheet numbers; 2-pin diode convention inferred per board; net-checked pinouts. **Specs are typical values from memory: `verified: false`** |
| Power tree | `src/spice/{powertree,powermodels,sequencer}.ts` | converters/switches/LDOs from topology + net names; behavioral regulators (B sources); FB-divider check; ACPI state sequencing (MacBook: 83.6 % agreement with rail names) |
| Faults & meter | `src/faults.ts`, `src/spice/dmm.ts` | severity ranges (estimates, as data); generic 6000-count DMM (ranges, test current, contact resistance, diode test) |
| Thermal | `src/thermal.ts` | 2D plate + part nodes; injection, freeze spray, IPA; plane heat-sinking; rework heat sources |
| Intermittents | `src/intermittent.ts` | thermal-open, thermal-leak, flex-open, flex-close |
| Rework | `src/rework.ts` | reflow (flux), molten/removable, lifted pads, overheat, MLCC shock (preheat), blow-off |
| Author Studio faults | `src/faults.ts` (`applicableFaults`, `listFaults`, `clearFault`), `src/ui/app.ts` | inspector card (author mode): every class that fits the part, pad + severity (blank = sampled from the documented range), per-part fault list with remove; Studio tab lists all faults board-wide; Fast-DC warning for SPICE-only faults |
| Rendering / camera | `src/render/{camera,webgpu}.ts` | one realistic palette for every board (no blue boardview); free 3D orbit that hands over to the other side past edge-on (3D = one board, "Both" is 2D only); dense-board labels only when ≥ 9 px on screen and non-overlapping (`placeLabels`); 2-pad chip parts drawn with end caps over their pads; selected part shows airwires (`src/airwires.ts`, per-net MST, nets > 250 pins skipped). `.brd` import draws **no** copper (the format has no routing; the old MacBook `tracedNets` straight-line traces were removed — all nets connect by name) |
| Power-up / bench PSU | `src/boot.ts`, `src/spice/{loads,sequencer,powermodels}.ts`, `src/spice/solveWorker.ts` | SPICE+PWR: emulated controller steps G3H→S5→S3→S0→S0SW, waits for its main regulators (bucks/boosts/LDOs, ≥ medium confidence), else gives up → standby → retry (boot loop). Rail loads = decoupling-cap count × 20 mW × state activity (**estimate**). Regulator current limits (estimates). diode-OR / FET-switch models; enables with no netlist node follow the controller; guessed-value R links between rails ≈ 0 Ω. PSU panel with V/A + 10 s chart; state solves run in a Web Worker. MacBook (repaired): 17 mA G3H → 51 mA S5 → 91 mA S3 → 313 mA S0 |
| Chip & copper faults | `src/faults.ts`, `src/connectivity.ts` | `ic-rail-short` (power pin → GND inside a chip, from net names); damaged converter stops regulating; `net-break` (broken copper on a name-connected net: spanning tree minus the link toward the larger rest; jumper repairs, reflow / new part do not) |
| Visual evidence | `src/residue.ts`, `src/render/webgpu.ts` | liquid / corrosion crust at pins (amount 0..1); IPA scrub halves it, leak rises, gone < 0.1; scorch under burnt parts |
| Oscilloscope | `src/scope.ts` (tool O) | Roll = real simulated data per frame (ramps, sequencing, boot loops); Auto = **synthesized** switch node (duty Vout/Vin, fsw 600 kHz est.), ripple (0.8 % est.), clocks from net-name frequency when a chip on the net is powered |
| Thermal camera | `src/thermal.ts` | apparent temperature ⁴√(εT⁴+(1−ε)Ta⁴): bare metal ε 0.1, mask/packages 0.9; rosin method (tool R): film melts clear above 60 °C (estimate) |
| Meter F / A | `src/spice/dmm.ts` | capacitance by charge time: parallel R inflates / OL in circuit (lift to measure); 10 A shunt in series |
| Calibration | `src/calibrate.ts`, `src/calibrate-cli.ts` | measurements CSV → per-reading comparison with tolerances, fitted `loadScale` → scenario `calibration` block applied by the simulator. **No real measurements yet** |
| Airwires | `src/airwires.ts` | follow design nets (pad net names), not live connectivity, so they do not reveal damage |
| KiCad import (real boards) | `src/io/{kicad,benchSupply}.ts`, `src/connectivity.ts`, `src/geom.ts` | rotation sign fixed (KiCad CCW kept); inner-layer copper → `Board.hiddenCopperNets` (vias / TH pads joined by design) plus display-only `Board.inner` (tracks + fills, pours simplified to 0.05 mm; drawn in X-ray and as the selected net's overlay); arcs; multi-layer + multi-island pours; thermal-relief contact; `dnp` → not fitted; bidirectional ESD/TVS + multi-pin diodes → no DC path; L/FB/NT → low-ohm paths; `C_100n_0402` values; coin cells 3 V; bench supply (`J_BENCH`) on the power tree's input rail (12 V assumed if unnamed); earcut triangulation cached per pour; part bodies sized from the F.Fab/B.Fab outline (SMD parts as chips/boxes, offset outlines kept in `body.off`); bodies that cover ≥2 other parts on their side (module sockets, shields) render as open frames with a light tint so parts beneath stay visible and clickable (`occluders()` in `src/render/webgpu.ts`) |
| Open-hardware demos | `scripts/build-demos.ts`, `public/demos/`, `docs/DEMOS.md` | MNT Reform 2 motherboard (CERN-OHL-S-2.0) and Antmicro Jetson Nano baseboard (Apache-2.0) at pinned commits; build verifies healthy-pass / faulted-fail / repair-unlocks; lazy-loaded; `Scenario.solver`, `meta.credits/license/source` |
| Walkthrough videos | `scripts/videos/{director,scenes,record}.ts`, `public/videos/`, `docs/VIDEOS.md` | approach + spoiler-gated solution per premade scene (8 scenes, 16 videos, 9 MB); recorded from the real app via `?automation=1` hook; a solution take fails unless the flag really unlocks; flags blurred; Inspector "Fit new part" for any empty / damaged footprint |
| Game integration | `src/ui/app.ts`, `src/render/webgpu.ts`, `src/verify.ts` | solver choice (Fast DC / SPICE / SPICE+PWR) in **Bench** dropdown; tools 9 freeze, 0 IPA, H hot air, B press; realistic rework mode; live thermal at 60 fps on the 2,030-part board |

Tests: `test/{solve,spice,schematic,powertree,realism,thermal,intermittent,rework,authoring,boot,scope,calibrate}.test.ts`.

Flag lock: `topology()` (`src/crypto.ts`) adds per-part tokens for leak (`!L`, incl. thermal-leak), drift (`!D`) and
intermittents (`!I`, even dormant), like `!X` for burnt — a fault the objectives miss must still be repaired.

## Data / licensing

- `board_schemas/schematic-macbook-j113-82000165-05100385.pdf` and the generated
  `board_schemas/J113  820-00165.spice.json` are Apple-proprietary **test fixtures only**;
  the final product will not ship them. Nothing derived from them is in the build.
- `board_schemas/820-00165.backlight.spice.json` is a small hand-written test fixture.
- These fixtures are **not in the public repository**: `board_schemas/` and `test/private/`
  (the MacBook scenario, `MACBOOK_820_00165_QUIRKS`, `loadMacbookAirScenario`) are git-ignored.
  Tests load them through `test/fixtures.ts` only when present and skip otherwise.
  `parseBrd` itself is generic and ships.

## Open items (proposed order)

0. **Two-layer thermal model — attempted 2026-11-16, reverted.** Skins + core with implicit
   vertical coupling works numerically (4 ms/frame on the MacBook board) but shifts tuned
   rework behaviour: the crux is the iron contact model (heat into pad vs part body via the
   solder bead). With pad-only contact a single tip cannot melt a 0402; with a body share both
   pads reflow equally fast and flux melts in 0.05 s. Needs a redesigned contact model, then
   recalibration of the rework tests. The attempt is not in the tree.
0. **Open source (released 2026-11-16, Apache-2.0):** Apple fixtures moved out of the shipped
   app (see Data / licensing); the build contains no boardview or schematic data. Remaining:
   give the open demo boards the full-board regression coverage the private MacBook tests have.
0. Real bench data: run `npm run calibrate` with measurements of one known-good board.
0. MacBook S4 load switch U3210 (PP3V3RHV_S4_TBTAPWR) never powers (input rail unmodelled);
   PP3V3_S0SW_LCD_UF buck is low-confidence (unmodelled). Scenario load (first solve) still blocks ~0.5 s.

1. Visual polish: frost reads grey; cold spots (IPA / frost cooling) are clamped by the IR palette
   floor (24 °C) and barely show.
2. Missing chip models: IC-internal LDOs (PCH/SMC), setpoints for VID rails (CPU VR),
   charger and backlight boost targets.
3. Two-layer thermal model (surface vs planes) to drop the hot-air coefficient compensation.
4. Verify device-library datasheet values (`verified: false` everywhere).
5. Voltage injection not yet exercised in the browser (covered by Node tests).
6. Pre-existing: favicon 404 (harmless).

## Known modelling assumptions (documented in code)

Fault severity ranges, intermittent trigger ranges, thermal constants (k_in-plane 35 W/mK,
h 12 W/m²K, joint 11 000 W/m²K ≈ 150 K/W for 0402), rework limits (SAC305 217 °C, pad lift
300 °C/6 s, part 300 °C/10 s, MLCC shock 150 K/s unless ≥100 °C baseline), hot-air
coefficients at the upper end of the jet range (compensates the 1-layer plate), PCB-copper
"SHORT footprint" rule for OMIT parts (R5490 — to confirm on a real board).
