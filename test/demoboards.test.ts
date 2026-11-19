// Full-board regression on the open-hardware demos (public/demos): the public replacement for the
// private MacBook coverage. Each board: import structure and net invariants, budgets, power-tree
// discovery, the faulted board fails for the planted reason (thermal camera finds the short), the
// intended repair passes and unlocks the flag (also after a save), rails match the published
// design values (docs/calibration), and a power-off meter snapshot.
//
// "snapshot" values below are this simulator's own output, kept to catch unintended model
// changes. They are NOT measurements; supply currents in particular rest on the estimated rail
// loads (src/spice/loads.ts). Update them deliberately when a model change is meant.
import { buildConnectivity, netReport } from '../src/connectivity';
import { parseScenario, serializeScenario } from '../src/io/format';
import { repairedDemo } from '../src/scenarios/demoRepairs';
import { runSolver, verifyScenario } from '../src/verify';
import { discoverPowerTree } from '../src/spice/powertree';
import { measureDiodeDmm, measureOhmsDmm } from '../src/spice/dmm';
import { compareMeasurements, parseMeasurements } from '../src/calibrate';
import { ThermalModel } from '../src/thermal';
import { airwiresFor } from '../src/airwires';
import { pickAt } from '../src/pick';
import type { Scenario } from '../src/types';

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
interface Fs { readFileSync(p: string, enc: 'utf8'): string }

interface Expect {
  parts: number;
  conductors: number;
  named: number;
  /** Nets the design file itself leaves in pieces (see netReport). */
  splits: string[];
  /** Converters the power tree must find: ref → output rail. */
  converters: Record<string, string>;
  supply: { ref: string; volts: number };
  /** Faulted board: the objective index that fails, and the reading range it shows. */
  fails: { index: number; min: number; max: number };
  /** Faulted board: the part the thermal camera must show as hottest. */
  hottest?: string;
  /** Repaired board, booted (S0SW): rail → volts (design values; ±1 %). */
  rails: Record<string, number>;
  /** Snapshot: repaired board's bench-supply current in S0SW (A, ±25 %). */
  amps: number;
  /** Snapshot: power off, realistic DMM, red on GND / black on the rail: diode volts (±15 mV), Ω (±5 %, null = OL). */
  meter: Record<string, [number, number | null]>;
  flag: string;
}

const EXPECT: Record<string, Expect> = {
  'demo-mnt-reform2-mb30': {
    parts: 530, conductors: 701, named: 681, splits: [],
    converters: { U7: '+5V', U9: '+3V3', U13: '+1V2', U19: '+1V5', U14: 'LPC_VCC' },
    supply: { ref: 'J_BENCH', volts: 30 },
    fails: { index: 0, min: 0.3, max: 1.0 },
    hottest: 'C173',
    rails: { '+5V': 5.0, '+3V3': 3.3, '+1V2': 1.2, '+1V5': 1.5, LPC_VCC: 3.3 },
    amps: 0.0162,
    meter: { '+5V': [0.509, 55.8e3], '+3V3': [0.5, 143e3], '+1V2': [0.536, 200e3], '+1V5': [0.548, 250e3], '30V_GATE': [0.527, null] },
    flag: 'DEAD{r3f0rm_3v3_sh0rt_g0n3}',
  },
  'demo-antmicro-jetson-nano-bb': {
    parts: 392, conductors: 497, named: 485, splits: ['Net-(IC3-~{FAULT})'],
    converters: { U6: '5V0_SYS', U2: '3V3_SYS' },
    supply: { ref: 'J_BENCH', volts: 12 },
    fails: { index: 0, min: -0.05, max: 0.1 },
    rails: { '5V0_SYS': 4.984, '3V3_SYS': 3.3 },
    amps: 0.0389,
    meter: { '5V0_SYS': [0.516, 62e3], '3V3_SYS': [0.52, null], VIN: [0.547, null] },
    flag: 'DEAD{b4s3b0ard_3v3_b4ck}',
  },
};

const time = <T>(f: () => T): [T, number] => { const t0 = performance.now(); const r = f(); return [r, performance.now() - t0]; };

async function checkBoard(sc: Scenario, x: Expect, fs: Fs) {
  const id = sc.id;
  const b = sc.board;
  // ---- structure and net invariants ----
  const [conn, connMs] = time(() => buildConnectivity(b));
  assert(b.components.length === x.parts, `${id}: ${b.components.length} parts, want ${x.parts}`);
  assert(conn.netCount === x.conductors, `${id}: ${conn.netCount} conductors, want ${x.conductors}`);
  const rep = netReport(conn);
  assert(rep.named === x.named && !rep.merged.length, `${id}: ${rep.named} named nets (want ${x.named}), merged ${JSON.stringify(rep.merged)}`);
  assert(JSON.stringify(rep.split.map((s) => s.net)) === JSON.stringify(x.splits), `${id}: split nets ${JSON.stringify(rep.split)}`);
  assert(connMs < 1500, `${id}: buildConnectivity ${connMs.toFixed(0)} ms`);
  const bench = b.components.find((c) => c.ref === x.supply.ref);
  assert(bench?.kind === 'battery' && bench.value === x.supply.volts, `${id}: bench supply ${x.supply.ref} at ${x.supply.volts} V`);

  // ---- power tree ----
  const tree = discoverPowerTree(b, conn);
  for (const [ref, out] of Object.entries(x.converters)) {
    const s = tree.sources.find((t) => t.ref === ref);
    assert(s && s.output === out && s.confidence === 'high', `${id}: ${ref} found as a high-confidence converter to ${out} (${JSON.stringify(s && { out: s.output, conf: s.confidence })})`);
  }

  // ---- faulted: fails for the planted reason ----
  const faulted = await verifyScenario(sc, b, 'spice-power');
  assert(!faulted.allPassed && faulted.flag === null, `${id}: arrives broken`);
  const bad = faulted.results[x.fails.index];
  const shown = parseFloat(/Measured (-?[\d.]+)/.exec(bad.detail)?.[1] ?? 'NaN');
  assert(!bad.passed && shown >= x.fails.min && shown <= x.fails.max, `${id}: "${bad.label}" fails reading ${bad.detail}, want ${x.fails.min}–${x.fails.max} V`);
  if (x.hottest) {
    const sim = runSolver('spice-power', b, conn, { powerState: 'S0SW' });
    const th = new ThermalModel(b);
    const p = new Map<string, number>();
    for (const c of b.components) { const cs = sim.comps.get(c.id); if (cs && cs.p > 0 && c.kind !== 'battery') p.set(c.id, cs.p); }
    th.setPower(p);
    for (let k = 0; k < 40; k++) th.step(0.25);
    const hot = th.hottestPart();
    assert(hot?.c.ref === x.hottest && hot.T > 40, `${id}: thermal camera shows ${hot?.c.ref} at ${hot?.T.toFixed(1)} °C hottest, want ${x.hottest}`);
  }

  // ---- repaired: passes, unlocks, survives a save ----
  const fixed = repairedDemo(sc)!;
  const [ok, solveMs] = await (async () => { const t0 = performance.now(); const r = await verifyScenario(fixed, fixed.board, 'spice-power'); return [r, performance.now() - t0] as const; })();
  assert(ok.allPassed && ok.flag === x.flag, `${id}: repaired board passes and unlocks (${JSON.stringify(ok.results.map((r) => r.detail))}, flag ${ok.flag})`);
  assert(solveMs < 15000, `${id}: verify ${solveMs.toFixed(0)} ms`);
  const reloaded = parseScenario(serializeScenario(fixed));
  const again = await verifyScenario(reloaded, reloaded.board, 'spice-power');
  assert(again.allPassed && again.flag === x.flag, `${id}: repaired board still unlocks after save / load`);

  const fc = buildConnectivity(fixed.board);
  const sim = runSolver('spice-power', fixed.board, fc, { powerState: 'S0SW' });
  for (const [rail, v] of Object.entries(x.rails)) {
    const k = sim.nodeOfNet.get(fc.netNames.indexOf(rail));
    const got = k === undefined ? NaN : sim.V[k];
    assert(Math.abs(got - v) <= 0.01 * v, `${id}: ${rail} at ${got.toFixed(3)} V, want ${v} V`);
  }
  const amps = sim.comps.get(fixed.board.components.find((c) => c.ref === x.supply.ref)!.id)?.i ?? 0;
  assert(Math.abs(amps - x.amps) <= 0.25 * x.amps, `${id}: supply current ${(amps * 1e3).toFixed(1)} mA, snapshot ${(x.amps * 1e3).toFixed(1)} mA (estimated loads)`);

  // published design values (docs/calibration): every row within its tolerance
  const rows = parseMeasurements(fs.readFileSync(`docs/calibration/${id}.csv`, 'utf8'));
  const cal = compareMeasurements(fixed.board, fc, rows);
  assert(rows.length && cal.every((r) => r.flag === 'ok'), `${id}: calibration rows ${JSON.stringify(cal.filter((r) => r.flag !== 'ok'))}`);

  // power-off meter snapshot (realistic DMM)
  const gnd = fc.netNames.indexOf('GND');
  for (const [rail, [dv, ohm]] of Object.entries(x.meter)) {
    const net = fc.netNames.indexOf(rail);
    const d = measureDiodeDmm(fixed.board, fc, gnd, net, { seed: 'regression' }).value;
    const r = measureOhmsDmm(fixed.board, fc, net, gnd, { seed: 'regression' }).value;
    assert(d !== null && Math.abs(d - dv) <= 0.015, `${id}: diode mode on ${rail} reads ${d} V, snapshot ${dv} V`);
    assert(ohm === null ? r === null : r !== null && Math.abs(r - ohm) <= 0.05 * ohm, `${id}: Ω on ${rail} reads ${r}, snapshot ${ohm ?? 'OL'}`);
  }

  // ---- UI-side helpers on a real board ----
  const part = fixed.board.components.find((c) => c.kind === 'resistor' && c.pads.length === 2 && c.pads.every((p) => p.net && p.net !== 'GND'))!;
  const wires = airwiresFor(fixed.board, fc, part);
  assert(wires.length > 0, `${id}: ${part.ref} has airwires`);
  const hit = pickAt(fixed.board, part.at, part.side);
  assert(hit !== null, `${id}: pickAt finds something at ${part.ref}`);
}

async function run() {
  const modName = 'node:fs';
  const fs = (await import(/* @vite-ignore */ modName)) as Fs;
  const index = JSON.parse(fs.readFileSync('public/demos/index.json', 'utf8')) as { id: string; file: string }[];
  for (const d of index) {
    const x = EXPECT[d.id];
    assert(x, `${d.id}: shipped demo without full-board expectations — add it to EXPECT`);
    await checkBoard(parseScenario(fs.readFileSync(`public/demos/${d.file}`, 'utf8')), x, fs);
  }
  console.log(`DEMO BOARD TESTS PASSED (${index.map((d) => d.id).join(', ')}: structure + nets, power tree, faulted fails + thermal hot spot, repair unlocks after save, rails = design values, meter snapshot)`);
}

run().catch((e) => { console.error(e); (globalThis as unknown as { process: { exitCode: number } }).process.exitCode = 1; });
