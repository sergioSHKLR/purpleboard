// Calibration: parsing bench measurements, comparing them with the simulation, fitting the
// rail-load scale. The "measurements" are generated from the model with known errors, so the
// test knows the answer the fit must recover. Synthetic board.
import type { Board, Component, ComponentKind } from '../src/types';
import { buildConnectivity } from '../src/connectivity';
import { compareMeasurements, fitLoadScale, parseMeasurements } from '../src/calibrate';
import { simulateSpice } from '../src/spice/adapter';
import { measureDiodeDmm } from '../src/spice/dmm';
import { parseScenario, serializeScenario } from '../src/io/format';

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

let x0 = 0;
function part(ref: string, kind: ComponentKind, nets: string[], value = 0, pins: Record<string, string> = {}): Component {
  x0 += 10;
  return {
    id: ref, ref, kind, value, at: [x0, 10], rot: 0, side: 'F',
    pads: nets.map((n, i) => ({ name: String(i + 1), at: [i * 1.5, 0], size: [0.6, 0.6], shape: 'rect', layers: 'F', net: n })),
    pins, body: { shape: 'box', w: 1, h: 1, z: 0.5 }, state: { populated: true, reversed: false, burnt: false, cold: [] },
  };
}
const two = { '1': '1', '2': '2' };

function mkBoard(): Board {
  x0 = 0;
  const comps: Component[] = [
    part('J1', 'battery', ['PP12V_G3H', 'GND'], 12, { '+': '1', '-': '2' }),
    part('U1', 'ic', ['PP12V_G3H', 'P5VS5_SW', 'P5VS5_EN', 'P5VS5_FB', 'GND']),
    part('L1', 'resistor', ['P5VS5_SW', 'PP5V_S5'], 0.02, two),
    part('U2', 'ic', ['PP5V_S5', 'PP1V8_S0', 'P1V8S0_EN', 'GND']),
    part('D1', 'diode', ['GND', 'PP5V_S5'], 0.65, { A: '1', K: '2' }),
  ];
  comps.find((c) => c.ref === 'L1')!.label = 'Inductor';
  for (const [rail, n] of [['PP5V_S5', 6], ['PP1V8_S0', 20]] as [string, number][]) for (let i = 0; i < n; i++) comps.push(part(`C_${rail}_${i}`, 'capacitor', [rail, 'GND'], 1e-6, two));
  return { w: 400, h: 30, thickness: 1.6, components: comps, traces: [], vias: [], blobs: [], jumpers: [], zones: [], silk: [], texts: [], nextId: 1 };
}

function run() {
  // ---- parsing ----
  const rows = parseMeasurements(`kind,net,value,state
# a comment
diode,PP5V_S5,0.512
ohm,PP1V8_S0,OL
volt,PP5V_S5,5.02,S5
amps,,0.010,G3H   # standby`);
  assert(rows.length === 4 && rows[1].value === null && rows[2].state === 'S5' && rows[3].kind === 'amps', `parsed: ${JSON.stringify(rows)}`);
  let threw = false;
  try { parseMeasurements('volt,PP5V_S5,5,S9'); } catch { threw = true; }
  assert(threw, 'unknown power states are rejected');

  // ---- a "real board" whose rails draw 2.5× the estimate: the fit recovers ×2.5 ----
  const b = mkBoard();
  const conn = buildConnectivity(b);
  const amps = (st: 'S5' | 'S0', scale: number) => {
    const s = simulateSpice(b, conn, { powerTree: true, powerState: st, loadScale: scale });
    return s.comps.get('J1')!.i;
  };
  const gnd = conn.netNames.indexOf('GND'), p5 = conn.netNames.indexOf('PP5V_S5');
  const diode = measureDiodeDmm(b, conn, gnd, p5, { seed: 'cal-PP5V_S5' }).value!;
  const csv = [
    `amps,,${amps('S0', 2.5)},S0`,
    `amps,,${amps('S5', 2.5)},S5`,
    'volt,PP5V_S5,5.0,S5',
    `diode,PP5V_S5,${diode}`,
    `diode,PP1V8_S0,${diode * 2}`, // a reading the model gets badly wrong: must be flagged
    'volt,NO_SUCH_NET,1.0',
  ].join('\n');
  const res = compareMeasurements(b, conn, parseMeasurements(csv));
  const scale = fitLoadScale(res)!;
  assert(Math.abs(scale - 2.5) / 2.5 < 0.08, `fitted load scale ×${scale} ≈ ×2.5`);
  assert(res[2].flag === 'ok' && res[3].flag === 'ok', `matching readings are ok: ${JSON.stringify(res.slice(2, 4))}`);
  assert(res[4].flag === 'off' && res[5].flag === 'missing-net', `bad / unknown readings are flagged: ${res[4].flag}, ${res[5].flag}`);
  // applying the fitted scale closes the gap
  const after = compareMeasurements(b, conn, parseMeasurements(csv), { loadScale: scale });
  assert(after.filter((r) => r.kind === 'amps').every((r) => r.flag === 'ok'), 'after calibration the supply currents agree');

  // ---- the calibration travels with the scenario ----
  const sc = parseScenario(serializeScenario({ format: 'pcbfix/1', id: 'x', meta: { title: 't', author: 'a', difficulty: 1, description: '', hints: [] }, board: b, objectives: [], calibration: { loadScale: scale, source: 'bench.csv' } }));
  assert(sc.calibration?.loadScale === scale && sc.calibration.source === 'bench.csv', 'calibration survives save / load');

  console.log(`CALIBRATE TESTS PASSED (measurement parsing, model vs bench comparison with tolerances, load scale fit ×${scale}, scenario round-trip)`);
}

run();
