# Simulation work — handoff (updated 2026-11-16, realism batch)

Goal: make PCB//FIX a realistic board-repair trainer, as close to a real bench as possible,
**universal** (any board, not just the MacBook), with honest provenance for every value.
No reference hardware is available, so realism is validated against *design intent*
(schematic/BOM values, rail names, datasheets) and physics checks — not measurements.

## How to run

```bash
npm test                 # 15 suites, all passing
npm run videos           # re-render walkthrough videos (needs the dev server; docs/VIDEOS.md)
npm run demos -- --fetch # rebuild the open-hardware demo boards (docs/DEMOS.md)
npm run calibrate -- <board.brd> <measurements.csv>   # model vs bench readings (template: docs/measurements.template.csv)
npm run build            # typecheck + production build
npx vite --port 5199     # dev server → http://localhost:5199 (WebGPU: use Chrome)
npm run spice -- "board_schemas/J113  820-00165.brd" --quiet --behavioral --states --supply PPVBAT_G3H_CONN=8.4:0.05
npm run schematic -- <schematic.pdf | bom.csv> <board.brd> --list | --product 639-00623
```

Browser automation used for UI checks: Playwright (`playwright-core` devDependency) driving the local Chrome
driving `/Applications/Google Chrome.app` headless with `--enable-unsafe-webgpu --use-angle=metal`
(scripts were in the session scratchpad; recreate if needed).

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
| KiCad import (real boards) | `src/io/{kicad,benchSupply}.ts`, `src/connectivity.ts`, `src/geom.ts` | rotation sign fixed (KiCad CCW kept); inner-layer copper → `Board.hiddenCopperNets` (vias / TH pads joined by design); arcs; multi-layer + multi-island pours; thermal-relief contact; `dnp` → not fitted; bidirectional ESD/TVS + multi-pin diodes → no DC path; L/FB/NT → low-ohm paths; `C_100n_0402` values; coin cells 3 V; bench supply (`J_BENCH`) on the power tree's input rail (12 V assumed if unnamed); earcut triangulation cached per pour; part bodies sized from the F.Fab/B.Fab outline (SMD parts as chips/boxes, offset outlines kept in `body.off`); bodies that cover ≥2 other parts on their side (module sockets, shields) render as open frames with a light tint so parts beneath stay visible and clickable (`occluders()` in `src/render/webgpu.ts`) |
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

1. Visual polish: frost reads grey; Thermal view colours only copper/parts (bare board
   stays 25 °C → needs a per-pixel temperature texture).
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
