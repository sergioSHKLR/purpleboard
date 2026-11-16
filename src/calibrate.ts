// Calibration against a real board. Every model value without a datasheet behind it (rail load
// estimate, device-library specs, meter model) can be checked against bench measurements of one
// known-good board, and the rail-load scale is fitted from measured supply currents.
//
// Measurements CSV (one reading per line, '#' comments, header optional):
//   kind,net,value[,state]
//   diode,PP3V3_S5,0.412        diode mode, red probe on GND, black on the net (boardview-database convention); OL = open
//   ohm,PP3V3_S5,120            resistance to GND, power off (Ω; OL = open)
//   volt,PP3V3_S5,3.31,S5       rail voltage (V) with the board in a power state (default S0)
//   amps,,0.018,G3H             bench-supply current (A) in a power state
import type { Board } from './types';
import type { Conn } from './connectivity';
import { measureDiodeDmm, measureOhmsDmm } from './spice/dmm';
import { simulateSpice } from './spice/adapter';
import { POWER_STATES, type PowerStateName } from './spice/sequencer';

export type MeasureKind = 'diode' | 'ohm' | 'volt' | 'amps';
export interface Measurement { kind: MeasureKind; net: string; value: number | null; state: PowerStateName; line: number }

export interface Compared extends Measurement {
  sim: number | null;
  /** (sim − measured) / measured, or null when not comparable (open / missing). */
  error: number | null;
  flag: 'ok' | 'off' | 'mismatch' | 'missing-net';
}

const STATES = new Set<string>(POWER_STATES.map((s) => s.name));

export function parseMeasurements(text: string): Measurement[] {
  const out: Measurement[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) return;
    const [kind, net = '', val = '', st = ''] = line.split(',').map((x) => x.trim());
    if (kind === 'kind') return; // header
    if (!['diode', 'ohm', 'volt', 'amps'].includes(kind)) throw new Error(`line ${i + 1}: unknown kind "${kind}"`);
    const value = /^(OL|open)$/i.test(val) ? null : Number(val);
    if (value !== null && !Number.isFinite(value)) throw new Error(`line ${i + 1}: bad value "${val}"`);
    if (st && !STATES.has(st)) throw new Error(`line ${i + 1}: unknown power state "${st}"`);
    if (kind !== 'amps' && !net) throw new Error(`line ${i + 1}: net missing`);
    out.push({ kind: kind as MeasureKind, net, value, state: (st || 'S0') as PowerStateName, line: i + 1 });
  });
  return out;
}

/** Relative error tolerated before a reading is flagged (meter + model, per kind). */
export const TOLERANCE: Record<MeasureKind, number> = { diode: 0.1, ohm: 0.25, volt: 0.05, amps: 0.3 };

export interface CompareOptions { groundNet?: string; loadScale?: number }

export function compareMeasurements(board: Board, conn: Conn, rows: Measurement[], opt: CompareOptions = {}): Compared[] {
  const gnd = conn.netNames.indexOf(opt.groundNet ?? 'GND');
  const sims = new Map<PowerStateName, ReturnType<typeof simulateSpice>>();
  const solve = (st: PowerStateName) => {
    let s = sims.get(st);
    if (!s) sims.set(st, (s = simulateSpice(board, conn, { powerTree: true, powerState: st, loadScale: opt.loadScale })));
    return s;
  };
  const supplyAmps = (st: PowerStateName) => {
    const s = solve(st);
    return board.components.filter((c) => c.kind === 'battery').reduce((a, c) => a + Math.max(0, s.comps.get(c.id)?.i ?? 0), 0);
  };
  return rows.map((m): Compared => {
    let sim: number | null;
    if (m.kind === 'amps') sim = supplyAmps(m.state);
    else {
      const net = conn.netNames.indexOf(m.net);
      if (net < 0) return { ...m, sim: null, error: null, flag: 'missing-net' };
      if (m.kind === 'volt') {
        const s = solve(m.state);
        const k = s.nodeOfNet.get(net);
        sim = k === undefined ? 0 : s.V[k];
      } else if (m.kind === 'diode') sim = gnd < 0 ? null : measureDiodeDmm(board, conn, gnd, net, { seed: `cal-${m.net}` }).value;
      else sim = gnd < 0 ? null : measureOhmsDmm(board, conn, net, gnd, { seed: `cal-${m.net}` }).value;
    }
    if (m.value === null || sim === null) {
      return { ...m, sim, error: null, flag: m.value === null && sim === null ? 'ok' : 'mismatch' };
    }
    const error = m.value === 0 ? (sim === 0 ? 0 : Infinity) : (sim - m.value) / Math.abs(m.value);
    return { ...m, sim, error, flag: Math.abs(error) <= TOLERANCE[m.kind] ? 'ok' : 'off' };
  });
}

/**
 * Rail-load scale from supply-current readings: the factor that makes the simulated S0-class
 * load match (least squares on the current above standby). null when there is no usable data.
 */
export function fitLoadScale(results: Compared[]): number | null {
  const amps = results.filter((r) => r.kind === 'amps' && r.value !== null && r.sim !== null && r.sim > 0);
  if (!amps.length) return null;
  let num = 0, den = 0;
  for (const r of amps) { num += r.value! * r.sim!; den += r.sim! * r.sim!; }
  return den > 0 ? +(num / den).toPrecision(3) : null;
}
