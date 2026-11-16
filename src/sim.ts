// DC operating-point solver: nodal analysis with Norton-equivalent sources and
// piecewise-linear diodes (iterated until the on/off states are consistent).
import type { Board, Component, SwitchMap } from './types';
import { pinNet, type Conn } from './connectivity';
import { LED_INFO, MODELED, batteryRint, twoRoles } from './model';

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
}

const OPEN = 1e-9;
const LED_RS = 15;
const DIODE_VF = 0.7, DIODE_RS = 0.5;
export const LED_MAX_I = 0.03;
export const LED_ON_I = 0.002;

interface El { c: Component; a: number; b: number; on: boolean }

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

const vf = (c: Component) => (c.kind === 'led' ? LED_INFO[c.color ?? 'red'].vf : DIODE_VF);
const rs = (c: Component) => (c.kind === 'led' ? LED_RS : DIODE_RS);

export interface SimOpts { switches?: SwitchMap; ohm?: [number, number]; diode?: [number, number]; currentLimit?: number }

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
    const el: El = { c, a: node(aNet), b: node(bNet), on: false };
    els.push(el);
    if (c.kind === 'battery' && !firstBattery) firstBattery = el;
  }

  const comps = new Map<string, CompSim>();
  const empty = (source: boolean): Sim => ({ nodeOfNet, V: new Float64Array(nn), ground: -1, comps, source });

  const probePair = opt.ohm ?? opt.diode;
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
    for (let iter = 0; iter < 60; iter++) {
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
      for (let i = 0; i < m; i++) G[i * m + i] += OPEN;
      for (const e of activeEls) {
        const c = e.c;
        switch (c.kind) {
          case 'resistor': stampG(e.a, e.b, c.state.burnt ? OPEN : 1 / Math.max(c.value, 1e-3)); break;
          case 'fuse': stampG(e.a, e.b, c.state.burnt ? OPEN : 10); break;
          case 'switch': {
            const closed = sw?.[c.ref] ?? !!c.state.closed;
            stampG(e.a, e.b, closed && !c.state.burnt ? 50 : OPEN);
            break;
          }
          case 'led': case 'diode':
            if (!c.state.burnt && e.on && !opt.ohm) stampE(e.a, e.b, vf(c), 1 / rs(c));
            else stampG(e.a, e.b, OPEN);
            break;
          case 'battery':
            if (!probePair) stampE(e.a, e.b, batV.get(c.id) ?? c.value, 1 / batteryRint(c.value));
            break;
        }
      }
      if (opt.ohm) { const ra = row[nodeOfNet.get(opt.ohm[0])!]; if (ra >= 0) I[ra] += 1e-3; }
      if (opt.diode) {
        const na = nodeOfNet.get(opt.diode[0])!;
        const nb = nodeOfNet.get(opt.diode[1])!;
        stampE(na, nb, 3.3, 1 / 3300);
      }
      const x = solve(G, I, m);
      V = new Float64Array(n);
      for (let i = 0; i < n; i++) V[i] = row[i] < 0 ? 0 : x[row[i]];
      if (opt.ohm) break;
      let changed = false;
      for (const e of activeEls) {
        if (e.c.kind !== 'led' && e.c.kind !== 'diode') continue;
        if (e.c.state.burnt) continue;
        const vd = V[e.a] - V[e.b];
        const on = e.on ? (vd - vf(e.c)) / rs(e.c) > 0 : vd > vf(e.c);
        if (on !== e.on) { e.on = on; changed = true; }
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
      case 'led': case 'diode': i = e.on && !c.state.burnt ? (v - vf(c)) / rs(c) : 0; break;
      case 'battery': i = ((batV.get(c.id) ?? c.value) - v) / batteryRint(c.value); break;
    }
    const r: CompSim = { i, v, p: Math.abs(v * i), on: false, bright: 0, over: false };
    if (c.kind === 'led') {
      r.on = i >= LED_ON_I;
      r.bright = i > 3e-4 ? Math.min(1, Math.max(0.12, i / 0.015)) : 0;
      if (i > LED_MAX_I) { r.over = true; r.overMsg = `burned out — ${(i * 1000).toFixed(0)} mA through an LED rated ${LED_MAX_I * 1000} mA`; }
    } else if (c.kind === 'diode' && Math.abs(i) > 1) {
      r.over = true; r.overMsg = `overheated at ${i.toFixed(2)} A`;
    } else if (c.kind === 'resistor' && r.p > (c.rating ?? 0.5)) {
      r.over = true; r.overMsg = `went up in smoke dissipating ${r.p.toFixed(2)} W (rated ${c.rating ?? 0.5} W)`;
    } else if (c.kind === 'fuse' && Math.abs(i) > c.value) {
      r.over = true; r.overMsg = `blew at ${Math.abs(i).toFixed(2)} A (rated ${c.value} A)`;
    }
    comps.set(c.id, r);
  }
  for (const cap of caps) {
    const na = nodeOfNet.get(cap.aNet);
    const nb = nodeOfNet.get(cap.bNet);
    const v = (na !== undefined ? V[na] : 0) - (nb !== undefined ? V[nb] : 0);
    comps.set(cap.c.id, { i: 0, v, p: 0, on: false, bright: 0, over: false });
  }
  return { nodeOfNet, V, ground, comps, source: true, ccLimited };
}

export function netVoltage(s: Sim, net: number): number | null {
  if (!s.source) return null;
  const k = s.nodeOfNet.get(net);
  return k === undefined ? null : s.V[k];
}

/** In-circuit resistance between two nets with the supply disconnected (Infinity = open). */
export function measureOhms(board: Board, conn: Conn, a: number, b: number): number {
  if (a < 0 || b < 0) return Infinity;
  if (a === b) return 0;
  const s = simulate(board, conn, { ohm: [a, b] });
  if (!s.source) return Infinity;
  const r = s.V[s.nodeOfNet.get(a)!] / 1e-3;
  return r > 2e7 ? Infinity : r;
}

/** Multimeter diode-check mode (3.3 V / 1 mA limited probe) with supply disconnected. */
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
  return { volts: v >= 3.25 ? Infinity : Math.max(0, v), litIds };
}
