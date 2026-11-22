// Solver agreement: the fast piecewise-linear solver (src/sim.ts) and the SPICE engine
// (src/spice/adapter.ts, src/spice/dmm.ts) must give the player the same meter readings.
//
// Every built-in scenario, the starter-kit challenge and a synthetic bench board (capacitors,
// high-impedance divider, junction in parallel with a cap) run through every meter mode, in
// every switch state their objectives use, with both solvers. Tolerances (both solvers share the
// device models, so what is left is method error):
//   V        |Δ| ≤ 5 mV + 0.2 %   10 MΩ meter on the probed net in both; PWL diode chords < 4 mV
//   LED / A  |Δ| ≤ 20 µA + 1 %    part currents and the meter in series (0.25 Ω shunt + leads)
//   Ω ideal  same OL, |Δ| ≤ 0.1 % fast `measureOhms` vs SPICE `measureOhmsSpice` (1 mA, junctions open, OL ≥ 60 MΩ)
//   Ω shown  |Δ| ≤ 1.5 Ω + 1 %    fast vs the realistic DMM shown in SPICE mode (leads, contact,
//                                 counts) — or lower: the DMM's 1 V test source lets junctions
//                                 conduct, the ideal fast ohmmeter treats them as open (by design)
//   diode    same OL, |Δ| ≤ 8 mV  fast vs SPICE and vs the DMM (same 3.0 V / 1 mA source; contact
//                                 resistance and the last digit); within 10 mV of OL either may show OL
//   F        one implementation for both solvers (SPICE-solved parallel R); checked against the
//            fast solver's in-circuit resistance: no parallel path → C ± 3.5 %, < 1 kΩ → OL, else ≥ C
import { buildConnectivity, type Conn } from '../src/connectivity';
import { parseScenario } from '../src/io/format';
import { builtinScenarios } from '../src/scenarios/builtin';
import { Builder } from '../src/scenarios/builder';
import { DIODE_TEST, measureDiode, measureOhms, simulate, type Sim, type SimOpts } from '../src/sim';
import { measureDiodeSpice, measureOhmsSpice, simulateSpice } from '../src/spice/adapter';
import { capacitanceBetween, measureCapDmm, measureDiodeDmm, measureOhmsDmm } from '../src/spice/dmm';
import type { Board, Scenario, SwitchMap } from '../src/types';

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
interface Fs { readFileSync(p: string, enc: 'utf8'): string }

const netOf = (b: Board, conn: Conn, ref: string, pad: string) => {
  const c = b.components.find((x) => x.ref === ref)!;
  return conn.net[conn.padItem.get(c)![c.pads.findIndex((p) => p.name === pad)]];
};
const volts = (s: Pick<Sim, 'nodeOfNet' | 'V'>, net: number) => {
  const k = s.nodeOfNet.get(net);
  return k === undefined ? 0 : s.V[k];
};
const fmt = (x: number) => (Number.isFinite(x) ? +x.toPrecision(5) + '' : 'OL');

/** Bench board: high-impedance divider, RC, a cap across a diode, an LED and a lone cap. */
function benchBoard(): Board {
  const k = new Builder(120, 80);
  const nets: string[] = [];
  const wire = (c: ReturnType<Builder['resistor']>, ...n: string[]) => {
    c.pads.forEach((p, i) => { p.net = n[i]; });
    for (const x of n) if (!nets.includes(x)) nets.push(x);
    return c;
  };
  const cap = (ref: string, farads: number, at: [number, number], a: string, b: string) => {
    const c = wire(k.resistor(ref, farads, at), a, b);
    c.kind = 'capacitor';
    return c;
  };
  wire(k.header('J1', 5, [10, 40]), '+5V', 'GND');
  wire(k.resistor('R1', 1e6, [40, 10]), '+5V', 'MID'); // 1 MΩ / 1 MΩ: the 10 MΩ meter reads 2.38 V
  wire(k.resistor('R2', 1e6, [40, 22]), 'MID', 'GND');
  cap('C1', 100e-9, [40, 34], 'MID', 'GND'); // in circuit with 500 kΩ across it
  wire(k.resistor('R3', 1e3, [70, 10]), '+5V', 'DA');
  wire(k.diode('D1', [70, 22]), 'GND', 'DA'); // pads: 1 = K, 2 = A
  cap('C2', 10e-6, [70, 34], 'DA', 'GND');
  wire(k.resistor('R4', 330, [100, 10]), '+5V', 'LA');
  wire(k.led('D2', 'red', [100, 22]), 'GND', 'LA');
  cap('C3', 22e-9, [100, 50], 'ISO1', 'ISO2'); // no parallel path at all
  k.b.hiddenCopperNets = nets; // through-hole pads joined by net name, no copper to route
  return k.b;
}

interface Case { id: string; board: Board; combos: SwitchMap[] }

function cases(builtins: Scenario[], nightLight: Scenario): Case[] {
  const out: Case[] = [];
  for (const s of [...builtins, nightLight]) {
    const combos: SwitchMap[] = [{}];
    const seen = new Set(['{}']);
    for (const o of s.objectives) {
      if (!('switches' in o) || !o.switches) continue;
      const key = JSON.stringify(o.switches);
      if (!seen.has(key)) { seen.add(key); combos.push(o.switches); }
    }
    out.push({ id: s.id, board: s.board, combos });
  }
  out.push({ id: 'synthetic-bench', board: benchBoard(), combos: [{}] });
  return out;
}

async function run() {
  const modName = 'node:fs';
  const fs = (await import(/* @vite-ignore */ modName)) as Fs;
  const nightLight = parseScenario(fs.readFileSync('examples/mods/starter-kit/boards/night-light-repair.pcbfix.json', 'utf8'));

  // ---- a net nothing drives reads ~0 V, not a divider of leakage terms ----
  // Night-light challenge: BT1 3 V → SW1 → R1 → D1. With SW1 open, R1.1 (net SW) is driven by
  // nothing; a real meter's 10 MΩ input pulls it to 0 V. The fast solver used to stamp the open
  // switch with the same 1 nS as its node shunts and read exactly +1.000 V there.
  {
    const b = nightLight.board, conn = buildConnectivity(b);
    const sw = netOf(b, conn, 'R1', '1'), vbat = netOf(b, conn, 'SW1', '1');
    for (const meters of [undefined, [[sw, -1]] as [number, number][]]) {
      const f = simulate(b, conn, { switches: { SW1: false }, meters });
      const s = simulateSpice(b, conn, { switches: { SW1: false }, meters });
      assert(Math.abs(volts(f, sw)) < 1e-3, `fast: floating R1.1 reads ${volts(f, sw).toFixed(4)} V (meters ${!!meters}), want ~0`);
      assert(Math.abs(volts(s, sw)) < 1e-3, `spice: floating R1.1 reads ${volts(s, sw).toFixed(4)} V, want ~0`);
      assert(Math.abs(volts(f, vbat) - 3) < 0.01, 'fast: BT1 side of SW1 still at 3 V');
    }
    const f = simulate(b, conn, { switches: { SW1: true } });
    assert(Math.abs(volts(f, sw) - 3) < 0.01, `fast: SW1 closed puts ~3 V on R1.1 (got ${volts(f, sw).toFixed(3)})`);
    // power off: across the open switch the ohmmeter reads OL, the diode test OL
    assert(measureOhms(b, conn, sw, vbat) === Infinity, 'open switch reads OL in Ω mode');
    assert(measureDiode(b, conn, sw, vbat).volts === Infinity && measureDiodeSpice(b, conn, sw, vbat).volts === Infinity, 'open switch reads OL in diode mode');
  }

  // ---- every board, every mode, both solvers ----
  const fails: string[] = [];
  const stats = { v: 0, a: 0, led: 0, ohm: 0, diode: 0, cap: 0, junctionOhms: 0 };
  const near = (x: number, y: number, abs: number, rel: number) => Math.abs(x - y) <= abs + rel * Math.max(Math.abs(x), Math.abs(y));
  // boards that name their solver (the transistor switch: SPICE) never run on the fast one, which has no
  // model for their parts: nothing to agree on
  const allCases = cases((await builtinScenarios()).filter((s) => !s.solver), nightLight);
  for (const { id, board, combos } of allCases) {
    const conn = buildConnectivity(board);
    const nets = [...Array(conn.netCount).keys()];
    const name = (n: number) => conn.netNames[n] || `#${n}`;
    const bad = (m: string) => fails.push(`[${id}] ${m}`);

    for (const sw of combos) {
      const tag = Object.keys(sw).length ? ` ${JSON.stringify(sw)}` : '';
      // V: the 10 MΩ meter on each net in turn (red on the net, black on supply ground)
      for (const n of nets) {
        const opt: SimOpts = { switches: sw, meters: [[n, -1]] };
        const f = simulate(board, conn, opt), s = simulateSpice(board, conn, opt);
        if (f.source !== s.source) { bad(`V${tag}: supply found by one solver only`); break; }
        if (!f.source) break;
        stats.v++;
        if (!near(volts(f, n), volts(s, n), 5e-3, 2e-3)) bad(`V${tag} ${name(n)}: fast ${fmt(volts(f, n))} spice ${fmt(volts(s, n))}`);
      }
      // part currents (what lights an LED, blows a fuse, heats a part), plus bench current limit
      for (const limit of [undefined, 0.02]) {
        const opt: SimOpts = { switches: sw, ...(limit && { currentLimit: limit }) };
        const f = simulate(board, conn, opt), s = simulateSpice(board, conn, opt);
        if (!f.source || !s.source) continue;
        if (f.ccLimited !== s.ccLimited) bad(`CC${tag} ${limit}: ccLimited fast ${f.ccLimited} spice ${s.ccLimited}`);
        for (const c of board.components) {
          if (!['led', 'diode', 'resistor', 'fuse', 'battery'].includes(c.kind)) continue;
          const fi = f.comps.get(c.id)?.i ?? 0, si = s.comps.get(c.id)?.i ?? 0;
          stats.led++;
          if (!near(fi, si, 20e-6, 0.01)) bad(`I${tag}${limit ? ` (limit ${limit} A)` : ''} ${c.ref}: fast ${fmt(fi)} A spice ${fmt(si)} A`);
        }
      }
      // A: the meter in series between every ordered pair of nets
      for (const a of nets) for (const b of nets) {
        if (a === b) continue;
        const opt: SimOpts = { switches: sw, ammeter: { a, b, ohms: 0.25 } };
        const fa = simulate(board, conn, opt).ammeterAmps ?? 0;
        const sa = simulateSpice(board, conn, opt).ammeterAmps ?? 0;
        stats.a++;
        if (!near(fa, sa, 20e-6, 0.01)) bad(`A${tag} ${name(a)}→${name(b)}: fast ${fmt(fa)} spice ${fmt(sa)}`);
      }
    }

    // power-off modes between every ordered pair of nets
    for (const a of nets) for (const b of nets) {
      if (a === b) continue;
      const pair = `${name(a)}→${name(b)}`;
      const of = measureOhms(board, conn, a, b), os = measureOhmsSpice(board, conn, a, b);
      stats.ohm++;
      if (Number.isFinite(of) !== Number.isFinite(os) || (Number.isFinite(of) && !near(of, os, 0, 1e-3))) bad(`Ω ideal ${pair}: fast ${fmt(of)} spice ${fmt(os)}`);
      const od = measureOhmsDmm(board, conn, a, b).value ?? Infinity;
      if (of === Infinity && od === Infinity) { /* both OL */ }
      else if (Number.isFinite(of) && Number.isFinite(od) && near(of, od, 1.5, 0.01)) { /* same */ }
      else if (od < of) stats.junctionOhms++; // junctions conducting under the DMM's 1 V source
      else bad(`Ω shown ${pair}: fast ${fmt(of)} DMM ${fmt(od)} (the DMM may only read lower)`);

      const df = measureDiode(board, conn, a, b).volts, ds = measureDiodeSpice(board, conn, a, b).volts;
      const dd = measureDiodeDmm(board, conn, a, b).value ?? Infinity;
      stats.diode++;
      for (const [label, other] of [['spice', ds], ['DMM', dd]] as const) {
        const same = df === other || (Number.isFinite(df) && Number.isFinite(other) && Math.abs(df - other) <= 8e-3);
        const atOl = [df, other].every((v) => !Number.isFinite(v) || v > DIODE_TEST.olVolts - 0.01);
        if (!same && !atOl) bad(`diode ${pair}: fast ${fmt(df)} ${label} ${fmt(other)}`);
      }

      const cTrue = capacitanceBetween(board, conn, a, b);
      const rd = measureCapDmm(board, conn, a, b);
      if (cTrue > 0) {
        stats.cap++;
        const c = rd.value;
        if (of >= 20e6) { if (!(c !== null && near(c, cTrue, 0, 0.035))) bad(`F ${pair}: ${rd.text} for ${cTrue} F with no parallel path`); }
        else if (of < 1e3) { if (c !== null) bad(`F ${pair}: ${rd.text} across ${fmt(of)} Ω, want OL`); }
        else if (c !== null && c < cTrue * 0.965) bad(`F ${pair}: ${rd.text} reads below ${cTrue} F with ${fmt(of)} Ω in parallel`);
      }
    }
  }
  assert(!fails.length, `${fails.length} solver disagreement(s):\n  ${fails.slice(0, 40).join('\n  ')}`);
  assert(stats.cap >= 6 && stats.junctionOhms > 0, 'the bench board exercises capacitance and junction conduction');

  console.log(`DIFFERENTIAL TESTS PASSED (floating net ~0 V; ${allCases.length} boards: ${stats.v} V, ${stats.led} part currents, ${stats.a} series A, ${stats.ohm} Ω, ${stats.diode} diode, ${stats.cap} F readings agree; ${stats.junctionOhms} Ω readings lower on the DMM by junction conduction)`);
}

run().catch((e) => { console.error(e); (globalThis as unknown as { process: { exitCode: number } }).process.exitCode = 1; });
