// DC operating-point solver: nodal analysis with Norton-equivalent sources and
// piecewise-linear diodes (iterated until every diode sits on a consistent segment).
// The diode curves are chords of the SPICE engine's own models (src/spice/board.ts), so both
// solvers simulate the same parts and differ only in method (test/differential.test.ts).
import { t } from './i18n';
import type { Board, Component, SwitchMap } from './types';
import { pinNet, type Conn } from './connectivity';
import { MODELED, batteryRint, twoRoles } from './model';
import { GENERIC_DMM, activeDmm } from './spice/dmm';
import { DIODE_MODEL, ledModel } from './spice/board';
import { VT_300K } from './spice/devices';

export interface CompSim {
  /** Current through the part, + flowing from first role to second (A->K, through a resistor 1->2). For batteries: current delivered. */
  i: number;
  v: number;
  p: number;
  on: boolean;
  bright: number;
  over: boolean;
  overMsg?: string;
}

export interface Sim {
  nodeOfNet: Map<number, number>;
  V: Float64Array;
  ground: number;
  comps: Map<string, CompSim>;
  source: boolean;
  ccLimited?: boolean;
  /** Current through the ammeter (red → black), when one was attached. */
  ammeterAmps?: number;
}

// Shunt from every solved node to ground (1 TΩ, as the SPICE engine's rshunt): keeps the matrix
// regular and leaves a node that nothing drives at 0 V. The voltmeter's own 10 MΩ load is
// stamped separately (`meters`). Open parts (open switch, off diode) are not stamped at all: a
// conductance comparable to this shunt would form a divider with it and read a phantom voltage
// on a floating net (an open switch from 3 V used to read exactly 1.000 V). A larger shunt also
// read megohm resistances low in Ω mode (1 GΩ per node: −0.6 % on 2 MΩ).
const GMIN = 1e-12;
export const LED_MAX_I = 0.03;
export const LED_ON_I = 0.002;

/** seg: diode segment in its PWL curve (-1 = off, no conduction). */
interface El { c: Component; a: number; b: number; seg: number }

function solve(A: Float64Array, b: Float64Array, n: number): Float64Array {
  for (let k = 0; k < n; k++) {
    let piv = k, best = Math.abs(A[k * n + k]);
    for (let r = k + 1; r < n; r++) { const v = Math.abs(A[r * n + k]); if (v > best) { best = v; piv = r; } }
    if (best < 1e-300) continue;
    if (piv !== k) {
      for (let c = 0; c < n; c++) { const t = A[k * n + c]; A[k * n + c] = A[piv * n + c]; A[piv * n + c] = t; }
      const t = b[k]; b[k] = b[piv]; b[piv] = t;
    }
    const d = A[k * n + k];
    for (let r = k + 1; r < n; r++) {
      const f = A[r * n + k] / d;
      if (f === 0) continue;
      for (let c = k; c < n; c++) {
        const akc = A[k * n + c];
        if (akc !== 0) A[r * n + c] -= f * akc;
      }
      b[r] -= f * b[k];
    }
  }
  const x = new Float64Array(n);
  for (let k = n - 1; k >= 0; k--) {
    let s = b[k];
    for (let c = k + 1; c < n; c++) s -= A[k * n + c] * x[c];
    const d = A[k * n + k];
    x[k] = Math.abs(d) < 1e-300 ? 0 : s / d;
  }
  return x;
}

/**
 * Piecewise-linear I–V curve of a junction: chords of the Shockley curve with series resistance,
 * V(I) = N·Vt·ln(1 + I/IS) + RS·I, through (0, 0) and currents from 1 pA doubling to beyond 10 A
 * (chord error under 4 mV for N = 2). The curve is convex, so every segment's line lies below it
 * and picking the segment that holds the last solution converges monotonically.
 */
interface Pwl { v: Float64Array; i: Float64Array; g: Float64Array }
const pwlCache = new Map<string, Pwl>();
function junctionPwl(c: Component): Pwl {
  const model = c.kind === 'led' ? ledModel(c.color ?? 'red') : DIODE_MODEL;
  let p = pwlCache.get(model.name);
  if (p) return p;
  const { is, n, rs } = model.params as { is: number; n: number; rs: number };
  const cur = [0];
  for (let x = 1e-12; x < 20; x *= 2) cur.push(x);
  const i = Float64Array.from(cur);
  const v = i.map((x) => n * VT_300K * Math.log1p(x / is) + rs * x);
  const g = new Float64Array(i.length - 1).map((_, k) => (i[k + 1] - i[k]) / (v[k + 1] - v[k]));
  pwlCache.set(model.name, (p = { v, i, g }));
  return p;
}
/** Segment of the curve that holds vd (-1 below 0 V: off). */
function segmentAt(p: Pwl, vd: number): number {
  if (!(vd > 0)) return -1;
  let lo = 0, hi = p.g.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (p.v[mid] <= vd) lo = mid; else hi = mid - 1; }
  return lo;
}
/** Diode current at vd on segment k (the line extended past its ends). */
function segmentCurrent(p: Pwl, k: number, vd: number): number {
  return k < 0 ? 0 : p.i[k] + p.g[k] * (vd - p.v[k]);
}

export interface SimOpts {
  switches?: SwitchMap;
  ohm?: [number, number];
  diode?: [number, number];
  currentLimit?: number;
  /** Ammeter between two nets (red, black): a low-ohm shunt; its current is returned as `ammeterAmps`. */
  ammeter?: { a: number; b: number; ohms: number };
  /** Voltmeters attached during the solve: [red net, black net (-1 = supply ground)]. */
  meters?: [number, number][];
  /** Voltmeter input impedance (default 10 MΩ). */
  meterOhms?: number;
}

export function simulate(board: Board, conn: Conn, opt: SimOpts = {}): Sim {
  const nodeOfNet = new Map<number, number>();
  let nn = 0;
  const node = (net: number) => {
    if (net < 0) return nn++;
    let k = nodeOfNet.get(net);
    if (k === undefined) { k = nn++; nodeOfNet.set(net, k); }
    return k;
  };
  const els: El[] = [];
  const caps: { c: Component; aNet: number; bNet: number }[] = [];
  let firstBattery: El | null = null;
  for (const c of board.components) {
    if (!c.state.populated || !MODELED.has(c.kind)) continue;
    const roles = twoRoles(c);
    if (!roles) continue;
    const aNet = pinNet(conn, c, roles[0]);
    const bNet = pinNet(conn, c, roles[1]);
    if (c.kind === 'capacitor') {
      caps.push({ c, aNet, bNet });
      continue;
    }
    const el: El = { c, a: node(aNet), b: node(bNet), seg: -1 };
    els.push(el);
    if (c.kind === 'battery' && !firstBattery) firstBattery = el;
  }

  const probePair = opt.ohm ?? opt.diode;
  const amm = opt.ammeter && !probePair && opt.ammeter.a >= 0 && opt.ammeter.b >= 0 && opt.ammeter.a !== opt.ammeter.b
    ? { a: node(opt.ammeter.a), b: node(opt.ammeter.b), g: 1 / Math.max(opt.ammeter.ohms, 1e-6) }
    : null;

  // A real DMM loads the node it measures (10 MΩ): on a node held only by a junction or a
  // high-value resistor, that load sets the reading. Black = -1 means supply ground.
  const meterEls: { a: number; b: number | 'gnd' }[] = [];
  if (!probePair) for (const [red, black] of opt.meters ?? []) {
    if (red < 0 || red === black) continue;
    meterEls.push({ a: node(red), b: black < 0 ? 'gnd' : node(black) });
  }
  const gMeter = 1 / (opt.meterOhms ?? activeDmm().vInputOhms);

  const comps = new Map<string, CompSim>();
  const empty = (source: boolean): Sim => ({ nodeOfNet, V: new Float64Array(nn), ground: -1, comps, source });

  let ground: number;
  if (probePair) {
    const gb = nodeOfNet.get(probePair[1]);
    if (gb === undefined || !nodeOfNet.has(probePair[0])) return empty(false);
    ground = gb;
  } else {
    if (!firstBattery) return empty(false);
    ground = firstBattery.b;
  }

  // BFS over non-burnt DC elements to solve only nets with an active path from sources/probes (without traversing through ground).
  const n = nn;
  const reachable = new Uint8Array(n);
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const e of els) {
    if (e.c.state.burnt) continue;
    if (probePair && e.c.kind === 'battery') continue;
    adj[e.a].push(e.b);
    adj[e.b].push(e.a);
  }
  if (amm) { adj[amm.a].push(amm.b); adj[amm.b].push(amm.a); }
  for (const me of meterEls) if (me.b !== 'gnd') { adj[me.a].push(me.b); adj[me.b].push(me.a); }
  const q: number[] = [];
  const seed = (idx: number | undefined) => {
    if (idx !== undefined && idx !== ground && !reachable[idx]) {
      reachable[idx] = 1;
      q.push(idx);
    }
  };
  if (probePair) {
    seed(nodeOfNet.get(probePair[0]));
  } else {
    for (const e of els) {
      if (e.c.kind === 'battery' && !e.c.state.burnt) {
        seed(e.a);
        seed(e.b);
      }
    }
  }
  for (let head = 0; head < q.length; head++) {
    const u = q[head];
    for (const v of adj[u]) {
      if (v !== ground && !reachable[v]) { reachable[v] = 1; q.push(v); }
    }
  }

  if (opt.ohm) {
    const na = nodeOfNet.get(opt.ohm[0]);
    if (na === undefined || (na !== ground && !reachable[na])) return empty(false);
  }

  const row = new Int32Array(n);
  let m = 0;
  for (let i = 0; i < n; i++) row[i] = i !== ground && reachable[i] ? m++ : -1;
  const activeEls = els.filter((e) => !e.c.state.burnt && (reachable[e.a] || reachable[e.b]));

  let V = new Float64Array(n);
  const sw = opt.switches;
  const batV = new Map<string, number>();
  for (const e of els) if (e.c.kind === 'battery') batV.set(e.c.id, e.c.value);
  let ccLimited = false;

  const outerSteps = opt.currentLimit && !probePair ? 6 : 1;
  for (let outer = 0; outer < outerSteps; outer++) {
    for (let iter = 0; iter < 100; iter++) {
      const G = new Float64Array(m * m);
      const I = new Float64Array(m);
      const stampG = (a: number, b: number, g: number) => {
        const ra = row[a], rb = row[b];
        if (ra >= 0) G[ra * m + ra] += g;
        if (rb >= 0) G[rb * m + rb] += g;
        if (ra >= 0 && rb >= 0) { G[ra * m + rb] -= g; G[rb * m + ra] -= g; }
      };
      // Series source E with conductance g between a(+) and b.
      const stampE = (a: number, b: number, E: number, g: number) => {
        stampG(a, b, g);
        if (row[a] >= 0) I[row[a]] += g * E;
        if (row[b] >= 0) I[row[b]] -= g * E;
      };
      for (let i = 0; i < m; i++) G[i * m + i] += GMIN;
      for (const e of activeEls) {
        const c = e.c; // activeEls holds no burnt parts
        switch (c.kind) {
          case 'resistor': stampG(e.a, e.b, 1 / Math.max(c.value, 1e-3)); break;
          case 'fuse': stampG(e.a, e.b, 10); break;
          case 'switch':
            if (sw?.[c.ref] ?? !!c.state.closed) stampG(e.a, e.b, 50);
            break;
          case 'led': case 'diode':
            if (e.seg >= 0 && !opt.ohm) {
              const p = junctionPwl(c), k = e.seg;
              stampE(e.a, e.b, p.v[k] - p.i[k] / p.g[k], p.g[k]);
            }
            break;
          case 'battery':
            if (!probePair) stampE(e.a, e.b, batV.get(c.id) ?? c.value, 1 / batteryRint(c.value));
            break;
        }
      }
      if (amm) stampG(amm.a, amm.b, amm.g);
      for (const me of meterEls) stampG(me.a, me.b === 'gnd' ? ground : me.b, gMeter);
      if (opt.ohm) { const ra = row[nodeOfNet.get(opt.ohm[0])!]; if (ra >= 0) I[ra] += 1e-3; }
      if (opt.diode) {
        const na = nodeOfNet.get(opt.diode[0])!;
        const nb = nodeOfNet.get(opt.diode[1])!;
        stampE(na, nb, DIODE_TEST.voc, 1 / DIODE_TEST.rsrc);
      }
      const x = solve(G, I, m);
      V = new Float64Array(n);
      for (let i = 0; i < n; i++) V[i] = row[i] < 0 ? 0 : x[row[i]];
      if (opt.ohm) break;
      let changed = false;
      for (const e of activeEls) {
        if (e.c.kind !== 'led' && e.c.kind !== 'diode') continue;
        if (e.c.state.burnt) continue;
        const seg = segmentAt(junctionPwl(e.c), V[e.a] - V[e.b]);
        if (seg !== e.seg) { e.seg = seg; changed = true; }
      }
      if (!changed) break;
    }

    if (!opt.currentLimit || probePair) break;
    let adjusted = false;
    for (const e of els) {
      if (e.c.kind !== 'battery') continue;
      const ev = batV.get(e.c.id) ?? e.c.value;
      const rint = batteryRint(e.c.value);
      const vterm = V[e.a] - V[e.b];
      const ib = (ev - vterm) / rint;
      if (ib > opt.currentLimit * 1.02) {
        ccLimited = true;
        const rLoad = Math.max(0, vterm / Math.max(1e-6, ib));
        const nextE = Math.min(e.c.value, opt.currentLimit * (rLoad + rint));
        if (Math.abs(nextE - ev) > 1e-3) {
          batV.set(e.c.id, nextE);
          adjusted = true;
        }
      }
    }
    if (!adjusted) break;
  }

  for (const e of els) {
    const c = e.c;
    const v = V[e.a] - V[e.b];
    let i = 0;
    switch (c.kind) {
      case 'resistor': i = c.state.burnt ? 0 : v / Math.max(c.value, 1e-3); break;
      case 'fuse': i = c.state.burnt ? 0 : v * 10; break;
      case 'switch': i = (sw?.[c.ref] ?? c.state.closed) && !c.state.burnt ? v * 50 : 0; break;
      case 'led': case 'diode': i = c.state.burnt || opt.ohm ? 0 : segmentCurrent(junctionPwl(c), e.seg, v); break;
      case 'battery': i = ((batV.get(c.id) ?? c.value) - v) / batteryRint(c.value); break;
    }
    const r: CompSim = { i, v, p: Math.abs(v * i), on: false, bright: 0, over: false };
    if (c.kind === 'led') {
      r.on = i >= LED_ON_I;
      r.bright = i > 3e-4 ? Math.min(1, Math.max(0.12, i / 0.015)) : 0;
      if (i > LED_MAX_I) { r.over = true; r.overMsg = t('burned out — {mA} mA through an LED rated {max} mA', { mA: (i * 1000).toFixed(0), max: LED_MAX_I * 1000 }); }
    } else if (c.kind === 'diode' && Math.abs(i) > 1) {
      r.over = true; r.overMsg = t('overheated at {amps} A', { amps: i.toFixed(2) });
    } else if (c.kind === 'resistor' && r.p > (c.rating ?? 0.5)) {
      r.over = true; r.overMsg = t('went up in smoke dissipating {w} W (rated {rated} W)', { w: r.p.toFixed(2), rated: c.rating ?? 0.5 });
    } else if (c.kind === 'fuse' && Math.abs(i) > c.value) {
      r.over = true; r.overMsg = t('blew at {amps} A (rated {rated} A)', { amps: Math.abs(i).toFixed(2), rated: c.value });
    }
    comps.set(c.id, r);
  }
  for (const cap of caps) {
    const na = nodeOfNet.get(cap.aNet);
    const nb = nodeOfNet.get(cap.bNet);
    const v = (na !== undefined ? V[na] : 0) - (nb !== undefined ? V[nb] : 0);
    comps.set(cap.c.id, { i: 0, v, p: 0, on: false, bright: 0, over: false });
  }
  return { nodeOfNet, V, ground, comps, source: true, ccLimited, ...(amm && { ammeterAmps: (V[amm.a] - V[amm.b]) * amm.g }) };
}

export function netVoltage(s: Sim, net: number): number | null {
  if (!s.source) return null;
  const k = s.nodeOfNet.get(net);
  return k === undefined ? null : s.V[k];
}

/** Ω readings at or above the meter's top range show OL (the DMM model's 60 MΩ range). */
export const OHM_OL = GENERIC_DMM.ohmRanges[GENERIC_DMM.ohmRanges.length - 1].fullScale;
/** Top of the meter in use's Ω ranges: readings at or above it show OL. */
export const ohmOL = () => { const r = activeDmm().ohmRanges; return r[r.length - 1].fullScale; };

/** In-circuit resistance between two nets with the supply disconnected (Infinity = open). */
export function measureOhms(board: Board, conn: Conn, a: number, b: number): number {
  if (a < 0 || b < 0) return Infinity;
  if (a === b) return 0;
  const s = simulate(board, conn, { ohm: [a, b] });
  if (!s.source) return Infinity;
  const r = s.V[s.nodeOfNet.get(a)!] / 1e-3;
  return r >= ohmOL() ? Infinity : r;
}

/**
 * The meter's diode-test source, shared by both solvers and the realistic DMM model: open-circuit
 * voltage and a source resistance that gives the profile's test current into a 0.6 V junction;
 * readings at or above `olVolts` show OL (typical handheld values, estimates: src/spice/dmm.ts).
 */
export const DIODE_TEST = {
  get voc() { return activeDmm().diode.voc; },
  get rsrc() { const d = activeDmm().diode; return (d.voc - 0.6) / d.itest; },
  get olVolts() { return activeDmm().diode.olVolts; },
};

/** Multimeter diode-check mode (DIODE_TEST source) with supply disconnected. */
export function measureDiode(board: Board, conn: Conn, a: number, b: number): { volts: number; litIds: string[] } {
  if (a < 0 || b < 0) return { volts: Infinity, litIds: [] };
  if (a === b) return { volts: 0, litIds: [] };
  const s = simulate(board, conn, { diode: [a, b] });
  if (!s.source) return { volts: Infinity, litIds: [] };
  const v = s.V[s.nodeOfNet.get(a)!];
  const litIds: string[] = [];
  for (const c of board.components) {
    if (c.kind === 'led' && (s.comps.get(c.id)?.i ?? 0) > 1e-4) litIds.push(c.id);
  }
  return { volts: v >= DIODE_TEST.olVolts ? Infinity : Math.max(0, v), litIds };
}
