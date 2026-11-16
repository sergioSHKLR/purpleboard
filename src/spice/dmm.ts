// Handheld multimeter model. A real meter is not an ideal probe:
//  • V: 10 MΩ input (loads high-impedance nodes), auto-ranged counts, gain error + last-digit noise
//  • Ω: a Thevenin test source per range (open-circuit voltage + test current); the meter reports
//       V_terminals / I_test, so junctions that conduct below V_oc, capacitors, and lead/contact
//       resistance all show up as on a bench
//  • diode test: ~1 mA source with a compliance limit, OL above it
// Deterministic: the same probe placement gives the same reading (no flicker).
import type { Board } from '../types';
import type { Conn } from '../connectivity';
import { boardToCircuit } from './board';
import { Engine } from './engine';
import { rng, seedOf } from '../faults';

export interface OhmRange { fullScale: number; itest: number; voc: number }
export interface DmmProfile {
  name: string;
  counts: number;
  vInputOhms: number;
  /** ±(fraction of reading) gain error and ± counts of last-digit noise. */
  vGainError: number;
  noiseCounts: number;
  ohmRanges: OhmRange[];
  /** Test-lead resistance (Ω) and probe-tip contact resistance range (Ω, log-uniform). */
  leadOhms: number;
  contactOhms: [number, number];
  beepOhms: number;
  diode: { itest: number; voc: number; olVolts: number };
}

/** Generic 6000-count handheld; values typical of the class, not a specific model. */
export const GENERIC_DMM: DmmProfile = {
  name: 'generic 6000-count DMM',
  counts: 6000,
  vInputOhms: 10e6,
  vGainError: 0.001,
  noiseCounts: 1,
  ohmRanges: [
    { fullScale: 600, itest: 0.5e-3, voc: 1.0 },
    { fullScale: 6e3, itest: 0.1e-3, voc: 1.0 },
    { fullScale: 60e3, itest: 10e-6, voc: 1.0 },
    { fullScale: 600e3, itest: 1e-6, voc: 1.0 },
    { fullScale: 6e6, itest: 0.1e-6, voc: 1.0 },
    { fullScale: 60e6, itest: 10e-9, voc: 1.0 },
  ],
  leadOhms: 0.2,
  contactOhms: [0.02, 0.6],
  beepOhms: 30,
  diode: { itest: 1e-3, voc: 3.0, olVolts: 2.5 },
};

export interface Reading { text: string; value: number | null; range?: string; beep?: boolean; sub?: string }

function quantize(v: number, res: number) { return Math.round(v / res) * res; }

/** Placement-dependent deterministic randomness (probe contact, noise). */
export function placementRng(...keys: (string | number)[]): () => number { return rng(seedOf(keys.join('|'))); }

export function contactResistance(p: DmmProfile, r: () => number): number {
  const [a, b] = p.contactOhms;
  return Math.exp(Math.log(a) + r() * (Math.log(b) - Math.log(a)));
}

/** Displays a voltage the way an auto-ranging meter would. */
export function displayVolts(v: number, p: DmmProfile = GENERIC_DMM, r: () => number = () => 0.5): Reading {
  const ranges = [0.6, 6, 60, 600, 1000];
  const fs = ranges.find((x) => Math.abs(v) < x * 0.999) ?? 1000;
  if (Math.abs(v) >= 1000) return { text: 'OL', value: null, range: '1000 V' };
  const res = fs / p.counts;
  const gain = 1 + (r() * 2 - 1) * p.vGainError;
  const noise = Math.round((r() * 2 - 1) * p.noiseCounts) * res;
  const shown = quantize(v * gain + noise, res);
  const digits = Math.max(0, Math.round(-Math.log10(res)));
  const text = fs <= 0.6 ? `${(shown * 1000).toFixed(Math.max(0, digits - 3))} mV` : `${shown.toFixed(digits)} V`;
  return { text, value: shown, range: fs <= 0.6 ? '600 mV' : `${fs} V` };
}

const fmtOhms = (r: number, fs: number, counts: number) => {
  const res = fs / counts;
  const q = quantize(r, res);
  if (fs <= 600) return `${q.toFixed(1)} Ω`;
  if (fs <= 600e3) return `${(q / 1e3).toFixed(Math.max(0, 3 - Math.round(Math.log10(fs / 600)) + 0))} kΩ`;
  return `${(q / 1e6).toFixed(Math.max(0, 3 - Math.round(Math.log10(fs / 600e3))))} MΩ`;
};

/** Solves the board with the supply removed and a meter source between nets a (+) and b (COM). */
function solveWithSource(board: Board, conn: Conn, a: number, b: number, voc: number, rsrc: number, rseries: number): { vTerm: number; i: number } | null {
  const nl = boardToCircuit(board, conn, { sources: false, unmodeled: 'omit', esdPins: true, groundNet: b });
  const na = nl.netNode.get(a);
  if (!na || !nl.netNode.has(b)) return null;
  nl.circuit.elements.push(
    { kind: 'V', name: 'V_DMM', n: ['dmm_oc', '0'], wave: { type: 'dc', v: voc } },
    { kind: 'R', name: 'R_DMM_SRC', n: ['dmm_oc', 'dmm_tip'], value: rsrc },
    { kind: 'R', name: 'R_DMM_LEADS', n: ['dmm_tip', na], value: Math.max(1e-4, rseries) },
  );
  const e = new Engine(nl.circuit, { gshunt: 1e-12 });
  const op = e.op();
  if (!op.converged) return null;
  const vTip = e.voltage(op.x, 'dmm_tip')!; // the meter measures at its own terminals (2-wire)
  return { vTerm: vTip, i: (voc - vTip) / rsrc };
}

export function measureOhmsDmm(board: Board, conn: Conn, a: number, b: number, opt: { profile?: DmmProfile; seed?: string } = {}): Reading {
  const p = opt.profile ?? GENERIC_DMM;
  if (a < 0 || b < 0) return { text: 'OL', value: null, sub: 'probe not on copper' };
  const r = placementRng('ohm', opt.seed ?? `${a}-${b}`);
  const series = p.leadOhms + contactResistance(p, r) + contactResistance(p, r);
  if (a === b) {
    const v = series;
    return { text: fmtOhms(v, 600, p.counts), value: v, range: '600 Ω', beep: v < p.beepOhms, sub: 'probes on the same net (lead + contact resistance)' };
  }
  for (const rg of p.ohmRanges) {
    const rsrc = rg.voc / rg.itest;
    const s = solveWithSource(board, conn, a, b, rg.voc, rsrc, series);
    if (!s) return { text: 'OL', value: null };
    if (s.i <= 0) continue;
    const rMeas = s.vTerm / s.i;
    if (rMeas < rg.fullScale * 0.999) {
      return { text: fmtOhms(rMeas, rg.fullScale, p.counts), value: rMeas, range: `${rg.fullScale >= 1e6 ? rg.fullScale / 1e6 + ' MΩ' : rg.fullScale >= 1e3 ? rg.fullScale / 1e3 + ' kΩ' : rg.fullScale + ' Ω'}`, beep: rMeas < p.beepOhms };
    }
  }
  return { text: 'OL', value: null, sub: 'above 60 MΩ' };
}

export function measureDiodeDmm(board: Board, conn: Conn, a: number, b: number, opt: { profile?: DmmProfile; seed?: string } = {}): Reading {
  const p = opt.profile ?? GENERIC_DMM;
  if (a < 0 || b < 0) return { text: 'OL', value: null };
  const r = placementRng('diode', opt.seed ?? `${a}-${b}`);
  const series = p.leadOhms + contactResistance(p, r) + contactResistance(p, r);
  if (a === b) return { text: '0.000 V', value: 0 };
  const rsrc = (p.diode.voc - 0.6) / p.diode.itest;
  const s = solveWithSource(board, conn, a, b, p.diode.voc, rsrc, series);
  if (!s || s.vTerm >= p.diode.olVolts) return { text: 'OL', value: null, sub: `open or > ${p.diode.olVolts} V` };
  const v = quantize(s.vTerm, 0.001);
  return { text: `${v.toFixed(3)} V`, value: v, beep: v < 0.05 };
}

// ---------- capacitance ----------
//
// The meter charges the capacitance with a range-dependent test current to a reference voltage
// and converts the time into farads. A resistance in parallel (in circuit) steals part of the
// current, so the reading comes out high; below a point the ramp never reaches the reference and
// the meter shows OL — which is why caps are lifted to be measured. Typical class values.
const CAP_RANGES = [
  { fs: 6e-9, i: 1e-7 }, { fs: 60e-9, i: 1e-6 }, { fs: 600e-9, i: 10e-6 }, { fs: 6e-6, i: 100e-6 },
  { fs: 60e-6, i: 1e-3 }, { fs: 600e-6, i: 5e-3 }, { fs: 6e-3, i: 10e-3 },
];
const CAP_VREF = 1.0;
const CAP_ACCURACY = 0.03;

const fmtFarads = (c: number, fs: number, counts: number) => {
  const q = quantize(c, fs / counts);
  const [div, unit] = fs <= 600e-9 ? [1e-9, 'nF'] : fs <= 600e-6 ? [1e-6, 'µF'] : [1e-3, 'mF'];
  const digits = Math.max(0, 3 - Math.round(Math.log10(fs / div / 6)));
  return `${(q / div).toFixed(digits)} ${unit}`;
};

/** Capacitance between nets a and b, from the capacitors wired directly across them. */
export function capacitanceBetween(board: Board, conn: Conn, a: number, b: number): number {
  let c = 0;
  for (const p of board.components) {
    if (p.kind !== 'capacitor' || !p.state.populated || p.state.burnt) continue;
    const idx = conn.padItem.get(p);
    if (!idx) continue;
    const nets = new Set(p.pads.map((_, pi) => (p.state.cold.includes(pi) ? -1 : conn.net[idx[pi]])));
    if (nets.has(a) && nets.has(b)) c += p.value * (p.state.drift && p.state.drift > 0 ? p.state.drift : 1);
  }
  return c;
}

export function measureCapDmm(board: Board, conn: Conn, a: number, b: number, opt: { profile?: DmmProfile; seed?: string } = {}): Reading {
  const p = opt.profile ?? GENERIC_DMM;
  if (a < 0 || b < 0) return { text: 'OL', value: null, sub: 'probe not on copper' };
  if (a === b) return { text: '0.000 nF', value: 0, sub: 'probes on the same net' };
  const cTrue = capacitanceBetween(board, conn, a, b);
  // in-circuit resistance across the probes (1 V test source)
  const s = solveWithSource(board, conn, a, b, CAP_VREF, 1e3, p.leadOhms);
  const rPar = s && s.i > 1e-12 ? s.vTerm / s.i : Infinity;
  const r = placementRng('cap', opt.seed ?? `${a}-${b}`);
  for (const rg of CAP_RANGES) {
    const leak = CAP_VREF / (2 * rPar); // average current lost to the parallel path during the ramp
    if (leak >= rg.i) continue; // this range cannot charge it — try a stronger test current
    const read = (cTrue * rg.i) / (rg.i - leak) * (1 + (r() * 2 - 1) * CAP_ACCURACY);
    if (read < rg.fs * 0.999) {
      const inflated = leak > rg.i * 0.05;
      return {
        text: fmtFarads(read, rg.fs, p.counts), value: read, range: fmtFarads(rg.fs, rg.fs, 6).replace(/\.0+ /, ' '),
        ...(inflated && { sub: `in circuit: ${rPar < 1e3 ? rPar.toFixed(0) + ' Ω' : (rPar / 1e3).toFixed(1) + ' kΩ'} in parallel inflates the reading — lift one end to measure the part` }),
      };
    }
  }
  return rPar < 1e4
    ? { text: 'OL', value: null, sub: `low resistance in parallel (${rPar < 1e3 ? rPar.toFixed(1) + ' Ω' : (rPar / 1e3).toFixed(1) + ' kΩ'}): capacitance cannot be measured in circuit` }
    : { text: 'OL', value: null, sub: 'above 6 mF' };
}

// ---------- current ----------

/** 10 A input shunt (Ω). Typical. */
export const AMMETER_SHUNT = 0.01;

/** Displays a current the way the meter's 10 A input would (± 1.0 % + noise; OL above 10 A). */
export function displayAmps(i: number, p: DmmProfile = GENERIC_DMM, r: () => number = () => 0.5): Reading {
  if (Math.abs(i) > 10) return { text: 'OL', value: null, range: '10 A', sub: 'above 10 A — the meter fuse would blow' };
  const fs = Math.abs(i) < 0.6 ? 0.6 : Math.abs(i) < 6 ? 6 : 10;
  const res = fs / p.counts;
  const shown = quantize(i * (1 + (r() * 2 - 1) * 0.01) + Math.round((r() * 2 - 1) * 2) * res, res);
  return fs === 0.6
    ? { text: `${(shown * 1000).toFixed(1)} mA`, value: shown, range: '600 mA' }
    : { text: `${shown.toFixed(3)} A`, value: shown, range: `${fs} A` };
}
