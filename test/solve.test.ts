import { macbookFixture } from './fixtures';
import { builtinScenarios } from '../src/scenarios/builtin';
import { addBlob, cutTrace, installPart, removeBlob, toggleCold } from '../src/ops';
import { airwiresFor } from '../src/airwires';
import { buildConnectivity, pinNet } from '../src/connectivity';
import { simulate, measureDiode, measureOhms } from '../src/sim';
import { verifyScenario as verifyFast } from '../src/verify';
import { parseScenario, serializeScenario } from '../src/io/format';
import { packText, unpackText } from '../src/crypto';
import { parseKicadPcb } from '../src/io/kicad';
import { parseBrd } from '../src/io/brd';
import { pickAt } from '../src/pick';
import { TUTORIAL_SCENARIO_IDS, getTutorialSteps, type TutorialCheckState } from '../src/ui/tutorial';

function assert(cond: unknown, msg = 'Assertion failed'): asserts cond {
  if (!cond) throw new Error(msg);
}

/** Verifies with the fast solver and asserts the SPICE engine reaches the same verdict and flag. */
async function verifyScenario(sc: Parameters<typeof verifyFast>[0]) {
  const fast = await verifyFast(sc);
  const spice = await verifyFast(sc, sc.board, 'spice');
  fast.results.forEach((r, i) => {
    if (r.passed !== spice.results[i].passed) {
      throw new Error(`[${sc.id}] SPICE disagrees on "${r.label}": fast=${r.detail}, spice=${spice.results[i].detail}`);
    }
  });
  if (fast.allPassed !== spice.allPassed || fast.flag !== spice.flag) {
    throw new Error(`[${sc.id}] SPICE verdict mismatch: fast=${fast.allPassed}/${fast.flag} spice=${spice.allPassed}/${spice.flag}`);
  }
  return fast;
}

function assertEq<T>(actual: T, expected: T, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg ? msg + ': ' : ''}expected ${String(expected)}, got ${String(actual)}`);
  }
}

function tutCheckState(
  scenarioId: string,
  board: Parameters<typeof buildConnectivity>[0],
  revealedFlag: string | null,
): TutorialCheckState {
  return {
    scenarioId,
    board,
    conn: buildConnectivity(board),
    cameraMode: '2d',
    cameraSide: 'F',
    vizMode: 'realistic',
    powerOn: true,
    activeTool: 'inspect',
    selectedCompId: null,
    dmmMode: 'V',
    probeRed: null,
    probeBlack: null,
    revealedFlag,
  };
}

async function run() {
  const scenarios = await builtinScenarios();
  assertEq(scenarios.length, 11, 'Expected 11 built-in scenarios');

  for (const id of TUTORIAL_SCENARIO_IDS) {
    const steps = getTutorialSteps(id);
    assert(steps && steps.length >= 4, `Expected interactive tutorial steps for ${id}`);
  }

  // 1. First Light (Tutorial 1)
  {
    const sc = structuredClone(scenarios.find((s) => s.id === 'builtin-first-light')!);
    const before = await verifyScenario(sc);
    assertEq(before.allPassed, false);
    assertEq(before.flag, null);

    // Bridge cut gap at [62, 19] on Front
    addBlob(sc.board, [62, 19], 'F', 0.8);
    const after = await verifyScenario(sc);
    assertEq(after.allPassed, true);
    assertEq(after.flag, 'PCB{f1rst_l1ght_s0ld3r_br1dg3d}');
    const steps = getTutorialSteps(sc.id)!;
    assert(steps[steps.length - 1].isDone(tutCheckState(sc.id, sc.board, after.flag)), 'Tutorial 1 final step should complete');
  }

  // 1b. Cold Joint 101 (Tutorial 2)
  {
    const sc = structuredClone(scenarios.find((s) => s.id === 'builtin-tut-cold-joint')!);
    const before = await verifyScenario(sc);
    assertEq(before.allPassed, false);
    assertEq(before.flag, null);

    const r1 = sc.board.components.find((c) => c.ref === 'R1')!;
    toggleCold(r1, 0);

    const after = await verifyScenario(sc);
    assertEq(after.allPassed, true);
    assertEq(after.flag, 'PCB{c0ld_j01nt_r3fl0w3d_ok}');
    const steps = getTutorialSteps(sc.id)!;
    assert(steps[steps.length - 1].isDone(tutCheckState(sc.id, sc.board, after.flag)), 'Tutorial 2 final step should complete');
  }

  // 1c. Solder Bridge 101 (Tutorial 3)
  {
    const sc = structuredClone(scenarios.find((s) => s.id === 'builtin-tut-solder-bridge')!);
    const before = await verifyScenario(sc);
    assertEq(before.allPassed, false);
    assertEq(before.flag, null);

    const hit = pickAt(sc.board, [48, 14], 'B');
    assert(hit && hit.kind === 'blob', 'Expected solder blob hit at [48, 14] on Bottom');
    removeBlob(sc.board, hit.blob);

    const after = await verifyScenario(sc);
    assertEq(after.allPassed, true);
    assertEq(after.flag, 'PCB{s0ld3r_br1dg3_w1ck3d_cl34n}');
    const steps = getTutorialSteps(sc.id)!;
    assert(steps[steps.length - 1].isDone(tutCheckState(sc.id, sc.board, after.flag)), 'Tutorial 3 final step should complete');
  }

  // 1d. One-Way LED (Tutorial 4)
  {
    const sc = structuredClone(scenarios.find((s) => s.id === 'builtin-tut-polarity')!);
    const before = await verifyScenario(sc);
    assertEq(before.allPassed, false);
    assertEq(before.flag, null);

    const d1 = sc.board.components.find((c) => c.ref === 'D1')!;
    d1.state.reversed = false;

    const after = await verifyScenario(sc);
    assertEq(after.allPassed, true);
    assertEq(after.flag, 'PCB{4n0d3_t0_c4th0d3_fl1pp3d}');
    const steps = getTutorialSteps(sc.id)!;
    assert(steps[steps.length - 1].isDone(tutCheckState(sc.id, sc.board, after.flag)), 'Tutorial 4 final step should complete');
  }

  // 1e. Resistor & Ohm's Law (Tutorial 5)
  {
    const sc = structuredClone(scenarios.find((s) => s.id === 'builtin-tut-resistor')!);
    const before = await verifyScenario(sc);
    assertEq(before.allPassed, false);
    assertEq(before.flag, null);

    const r1 = sc.board.components.find((c) => c.ref === 'R1')!;
    installPart(r1, { value: 150 });

    const after = await verifyScenario(sc);
    assertEq(after.allPassed, true);
    assertEq(after.flag, 'PCB{0hms_l4w_curr3nt_l1m1t3r}');
    const steps = getTutorialSteps(sc.id)!;
    assert(steps[steps.length - 1].isDone(tutCheckState(sc.id, sc.board, after.flag)), 'Tutorial 5 final step should complete');
  }

  // 1f. Voltage Divider 101 (Tutorial 6)
  {
    const sc = structuredClone(scenarios.find((s) => s.id === 'builtin-tut-divider')!);
    const before = await verifyScenario(sc);
    assertEq(before.allPassed, false);
    assertEq(before.flag, null);

    const r2 = sc.board.components.find((c) => c.ref === 'R2')!;
    installPart(r2, { value: 10000 });

    const after = await verifyScenario(sc);
    assertEq(after.allPassed, true);
    assertEq(after.flag, 'PCB{v0lt4g3_d1v1d3r_h4lf_r41l}');
    const steps = getTutorialSteps(sc.id)!;
    assert(steps[steps.length - 1].isDone(tutCheckState(sc.id, sc.board, after.flag)), 'Tutorial 6 final step should complete');
  }

  // 2. Bridge Troll
  {
    const sc = structuredClone(scenarios.find((s) => s.id === 'builtin-bridge-troll')!);
    const before = await verifyScenario(sc);
    assertEq(before.allPassed, false);

    // Pick and remove solder blob at [40, 14] on Back
    const hit = pickAt(sc.board, [40, 14], 'B');
    assert(hit && hit.kind === 'blob', 'Expected blob hit at [40, 14]');
    removeBlob(sc.board, hit.blob);

    // Reflow cold joint on R1 pad 0
    const r1 = sc.board.components.find((c) => c.ref === 'R1')!;
    toggleCold(r1, 0);

    const after = await verifyScenario(sc);
    assertEq(after.allPassed, true);
    assertEq(after.flag, 'PCB{tr0ll_br1dg3_w1ck3d_4w4y}');
  }

  // 3. Backwards Day
  {
    const sc = structuredClone(scenarios.find((s) => s.id === 'builtin-backwards-day')!);
    const before = await verifyScenario(sc);
    assertEq(before.allPassed, false);

    const r1 = sc.board.components.find((c) => c.ref === 'R1')!;
    installPart(r1, { value: 330 });

    const d1 = sc.board.components.find((c) => c.ref === 'D1')!;
    d1.state.reversed = false;

    addBlob(sc.board, [34, 24], 'B', 0.75);

    const after = await verifyScenario(sc);
    assertEq(after.allPassed, true);
    assertEq(after.flag, 'PCB{p0l4r1ty_m4tt3rs_bl1nk}');
  }

  // 4. Ghost Short
  {
    const sc = structuredClone(scenarios.find((s) => s.id === 'builtin-ghost-short')!);
    const before = await verifyScenario(sc);
    assertEq(before.allPassed, false);

    // Trap check: installing F1 without cutting sliver still leaves J1 dead-shorted (25 A into copper)
    const f1 = sc.board.components.find((c) => c.ref === 'F1')!;
    const j1 = sc.board.components.find((c) => c.ref === 'J1')!;
    installPart(f1, { value: 0.5 });
    const simTrap = simulate(sc.board, buildConnectivity(sc.board));
    assert((simTrap.comps.get(j1.id)?.i ?? 0) > 10, 'J1 should be dead-shorted when sliver remains');

    // Now cut the sliver at [8.5, 22] and install R2 = 10k
    const sliver = sc.board.traces.find((t) => t.id === 'sliver')!;
    assert(cutTrace(sc.board, sliver, [8.5, 22], 0.7));
    installPart(f1, { value: 0.5 });
    const r2 = sc.board.components.find((c) => c.ref === 'R2')!;
    installPart(r2, { value: 10000 });

    const after = await verifyScenario(sc);
    assertEq(after.allPassed, true);
    assertEq(after.flag, 'PCB{gh0st_sl1v3r_exorc1s3d}');
  }

  // 4b. Smoke Test (Diode test, OCP limit, back-side blob, reversed diode, blown fuse)
  {
    const sc = structuredClone(scenarios.find((s) => s.id === 'builtin-smoke-test')!);
    const before = await verifyScenario(sc);
    assertEq(before.allPassed, false);

    // Fix back-side short blob, flip D1 back, replace F1
    const hit = pickAt(sc.board, [45, 19.1], 'B');
    assert(hit && hit.kind === 'blob', 'Expected short blob on back of Smoke Test');
    removeBlob(sc.board, hit.blob);

    // Check diode mode on D1 before flipping (reversed -> should read OL when probing + on FUSED, - on VRAIL)
    const connPre = buildConnectivity(sc.board);
    const f1 = sc.board.components.find((c) => c.ref === 'F1')!;
    const d1 = sc.board.components.find((c) => c.ref === 'D1')!;
    const netA = connPre.net[connPre.padItem.get(d1)![1]]; // pad 2 (silkscreen A side)
    const netK = connPre.net[connPre.padItem.get(d1)![0]]; // pad 1 (silkscreen K side)
    const revDiode = measureDiode(sc.board, connPre, netA, netK);
    assertEq(revDiode.volts, Infinity, 'Reversed diode should read OL forward');

    d1.state.reversed = false;
    const fwdDiode = measureDiode(sc.board, buildConnectivity(sc.board), netA, netK);
    assert(fwdDiode.volts > 0.65 && fwdDiode.volts < 0.78, `Expected ~0.7 V silicon diode drop, got ${fwdDiode.volts}`);

    installPart(f1, { value: 0.5 });
    const after = await verifyScenario(sc);
    assertEq(after.allPassed, true);
    assertEq(after.flag, 'PCB{c0nst4nt_curr3nt_sm0k3_t3st}');
  }

  // 4c. The Sagging Rail (Voltage divider + back-side via trace break)
  {
    const sc = structuredClone(scenarios.find((s) => s.id === 'builtin-sagging-rail')!);
    const before = await verifyScenario(sc);
    assertEq(before.allPassed, false);

    const r2 = sc.board.components.find((c) => c.ref === 'R2')!;
    installPart(r2, { value: 10000 });
    addBlob(sc.board, [49, 8], 'B', 0.8);

    const after = await verifyScenario(sc);
    assertEq(after.allPassed, true);
    assertEq(after.flag, 'PCB{0hms_l4w_du4l_l4y3r_pr0}');
  }

  // 4d. Bench PSU OCP Current Limiter check
  {
    const sc = structuredClone(scenarios.find((s) => s.id === 'builtin-ghost-short')!);
    const simOcp = simulate(sc.board, buildConnectivity(sc.board), { currentLimit: 0.1 });
    assertEq(simOcp.ccLimited, true, 'OCP 100 mA should enter CC limit on shorted board');
    const j1 = sc.board.components.find((c) => c.ref === 'J1')!;
    const iBat = simOcp.comps.get(j1.id)?.i ?? 0;
    assert(iBat <= 0.11, `OCP should clamp supply current near 0.1 A, got ${iBat}`);
  }

  // 5. Serialization + URL Pack/Unpack round-trip
  {
    const sc = scenarios[0];
    const json = serializeScenario(sc);
    const parsed = parseScenario(json);
    assertEq(parsed.id, sc.id);
    assertEq(parsed.board.components.length, sc.board.components.length);

    const packed = await packText(json);
    const unpacked = await unpackText(packed);
    assertEq(unpacked, json);
  }

  // 6. KiCad .kicad_pcb import + live simulation
  {
    const kicadSrc = `
      (kicad_pcb (version 20221018) (generator pcbnew)
        (title_block (title "Blink Test"))
        (net 0 "")
        (net 1 "+3V")
        (net 2 "LED_A")
        (net 3 "GND")
        (gr_rect (start 0 0) (end 40 30) (layer "Edge.Cuts") (width 0.1))
        (gr_text "KICAD TEST" (at 20 26) (layer "F.SilkS"))
        (footprint "Battery:CR2032" (layer "F.Cu") (at 10 15)
          (fp_text reference "BT1" (at 0 -3))
          (fp_text value "3V" (at 0 3))
          (pad "1" thru_hole rect (at 0 -5) (size 2 2) (drill 1) (layers *.Cu) (net 1 "+3V"))
          (pad "2" thru_hole circle (at 0 5) (size 2 2) (drill 1) (layers *.Cu) (net 3 "GND"))
        )
        (footprint "Resistor_THT:R_Axial" (layer "F.Cu") (at 22 10)
          (fp_text reference "R1" (at 0 -2))
          (fp_text value "220R" (at 0 2))
          (pad "1" thru_hole circle (at -5 0) (size 1.8 1.8) (drill 0.9) (layers *.Cu) (net 1 "+3V"))
          (pad "2" thru_hole circle (at 5 0) (size 1.8 1.8) (drill 0.9) (layers *.Cu) (net 2 "LED_A"))
        )
        (footprint "LED_THT:LED_D5.0mm" (layer "F.Cu") (at 32 15)
          (fp_text reference "D1" (at 0 -3))
          (fp_text value "red" (at 0 3))
          (pad "1" thru_hole rect (at -1.27 0) (size 1.8 1.8) (drill 0.9) (layers *.Cu) (net 3 "GND"))
          (pad "2" thru_hole circle (at 1.27 0) (size 1.8 1.8) (drill 0.9) (layers *.Cu) (net 2 "LED_A"))
        )
        (segment (start 10 10) (end 17 10) (width 0.8) (layer "F.Cu") (net 1))
        (segment (start 27 10) (end 33.27 10) (width 0.8) (layer "F.Cu") (net 2))
        (segment (start 33.27 10) (end 33.27 15) (width 0.8) (layer "F.Cu") (net 2))
        (segment (start 30.73 15) (end 30.73 20) (width 0.8) (layer "F.Cu") (net 3))
        (segment (start 30.73 20) (end 10 20) (width 0.8) (layer "F.Cu") (net 3))
      )
    `;
    const { board, title } = parseKicadPcb(kicadSrc);
    assertEq(title, 'Blink Test');
    assertEq(board.w, 40);
    assertEq(board.h, 30);
    assertEq(board.components.length, 3);
    const conn = buildConnectivity(board);
    const sim = simulate(board, conn);
    const d1 = board.components.find((c) => c.ref === 'D1')!;
    assertEq(sim.comps.get(d1.id)?.on, true, 'Imported KiCad LED should light up');
  }

  // 7. Complex Boardview (.brd) MacBook Air 820-00165 Benchmark + Fault/Repair Flow
  //    (private fixture: runs only where board_schemas/ is present, see test/fixtures.ts)
  const mac = await macbookFixture();
  if (!mac) console.log('  820-00165 benchmark skipped (private fixtures not present)');
  else {
    const modName = 'node:fs/promises';
    const fs = (await import(/* @vite-ignore */ modName)) as { readFile(path: URL): Promise<Uint8Array> };
    const brdBytes = new Uint8Array(await fs.readFile(new URL('../board_schemas/J113  820-00165.brd', import.meta.url)));

    const t0Parse = performance.now();
    const parsed = parseBrd(brdBytes, 'J113  820-00165.brd');
    const parseMs = performance.now() - t0Parse;
    // Generic import: no board-specific knowledge (no stand-ins, no hand-picked traces).
    assertEq(parsed.board.components.filter((c) => !/^J_/.test(c.ref)).length, 2029, '820-00165 boardview part count');
    assertEq(parsed.board.traces.length, 0, 'generic import draws no hand-picked traces');
    assert(parsed.board.vias.length > 1500, `Expected >1500 vias/nails, got ${parsed.board.vias.length}`);
    assertEq(parsed.board.components.find((c) => c.ref === 'Q7706')!.kind, 'ic', 'generic import keeps Q7706 a transistor footprint');

    const sc = await mac.loadMacbookAirScenario();
    assertEq(sc.board.components.length, 2030, 'scenario: 2029 parts + J_G3H bench supply');
    assertEq(sc.board.traces.length, 0, 'boardview has no routing: the scenario draws no invented copper');

    const t0Conn = performance.now();
    const conn = buildConnectivity(sc.board);
    const connMs = performance.now() - t0Conn;
    assert(connMs < 150, `buildConnectivity budget exceeded: ${connMs.toFixed(1)} ms >= 150 ms`);

    const t0Sim = performance.now();
    const sim0 = simulate(sc.board, conn);
    const simMs = performance.now() - t0Sim;
    assert(simMs < 20, `simulate budget exceeded: ${simMs.toFixed(1)} ms >= 20 ms`);
    assertEq(sim0.source, true, '820-00165 J_G3H supply should be active');

    const f7700 = sc.board.components.find((c) => c.ref === 'F7700')!;
    const r7788 = sc.board.components.find((c) => c.ref === 'R7788')!;
    const xw7720 = sc.board.components.find((c) => c.ref === 'XW7720')!;
    assert(!!f7700 && !!r7788 && !!xw7720, 'Expected F7700, R7788, XW7720 on 820-00165');

    const ohmsBlown = measureOhms(sc.board, conn, pinNet(conn, f7700, '1'), pinNet(conn, f7700, '2'));
    assertEq(ohmsBlown, Infinity, 'Blown F7700 must read open (Infinity ohms)');
    const d7701 = sc.board.components.find((c) => c.ref === 'D7701')!;
    const diodeFwd = measureDiode(sc.board, conn, pinNet(conn, d7701, 'A'), pinNet(conn, d7701, 'K'));
    assert(diodeFwd.volts > 0.4 && diodeFwd.volts < 1.0, `Expected D7701 Vf ~0.7 V, got ${diodeFwd.volts}`);

    for (let i = 0; i < 30; i++) {
      pickAt(sc.board, [(i * 19.1) % sc.board.w, (i * 13.7) % sc.board.h], i % 2 === 0 ? 'F' : 'B');
    }
    const t0Pick = performance.now();
    for (let i = 0; i < 100; i++) {
      const px = (i * 23.7) % sc.board.w;
      const py = (i * 11.3) % sc.board.h;
      pickAt(sc.board, [px, py], i % 2 === 0 ? 'F' : 'B');
    }
    const pick100Ms = performance.now() - t0Pick;
    assert(pick100Ms < 25, `100x pickAt budget exceeded: ${pick100Ms.toFixed(1)} ms >= 25 ms`);

    const f7700Hit = pickAt(sc.board, f7700.at, f7700.side);
    assert(f7700Hit !== null, 'pickAt should hit F7700 on its mounted side');

    const before = await verifyScenario(sc);
    assertEq(before.allPassed, false, 'Faulted 820-00165 should fail initially');
    assertEq(before.flag, null);

    // Airwires: a selected part's nets as minimum spanning trees over their pins
    {
      const r7789 = sc.board.components.find((c) => c.ref === 'R7789')!;
      const wires = airwiresFor(sc.board, conn, r7789);
      assert(wires.length > 0, 'R7789 has airwires');
      const pinsOn = (net: string) => sc.board.components.reduce((k, c) => k + c.pads.filter((p) => p.net === net).length, 0);
      const designNets = [...new Set(r7789.pads.map((p) => p.net!))].filter((n) => pinsOn(n) > 1 && pinsOn(n) <= 250);
      assertEq(wires.length, designNets.reduce((k, n) => k + pinsOn(n) - 1, 0), 'one spanning tree (pins − 1 lines) per design net');
      assert(!r7789.pads.some((p) => p.net === 'GND') || wires.length < 250, 'ground (huge net) is not drawn as a starburst');
    }

    // Repair all 3 faults on the MacBook Air board
    installPart(f7700, { value: 3.0 });
    installPart(r7788, { value: 330000 });
    toggleCold(xw7720, 0);

    const connFixed = buildConnectivity(sc.board);
    const ohmsFixed = measureOhms(sc.board, connFixed, pinNet(connFixed, f7700, '1'), pinNet(connFixed, f7700, '2'));
    assert(ohmsFixed < 1, `Replaced F7700 should read low ohms, got ${ohmsFixed}`);

    const after = await verifyScenario(sc);
    assertEq(after.allPassed, true, `820-00165 should pass after repairs: ${JSON.stringify(after.results)}`);
    assertEq(after.flag, 'PCB{m4cb00k_820_00165_b4ckl1ght_f1x}');

    console.log(
      `820-00165 benchmarks (${sc.board.components.length} parts, ${sc.board.traces.length} traces, ${sc.board.vias.length} vias): ` +
      `parse=${parseMs.toFixed(1)}ms, conn=${connMs.toFixed(1)}ms, sim=${simMs.toFixed(2)}ms, 100x pick=${pick100Ms.toFixed(2)}ms`,
    );
  }

  console.log('ALL TESTS PASSED (built-in scenarios + sandbox, MacBook when present, serialization, URL pack, KiCad & .brd import)');
}

run();
