// @ts-check
// Ideal DC: an example DEADBOARD code mod. It registers one solver, written as plain modified
// nodal analysis: resistors, batteries (with internal resistance), switches, fuses and leaks are
// conductances; diodes and LEDs are a fixed forward voltage behind a small resistance, switched on
// or off until nothing changes. ICs and anything else are left out, so boards with regulators
// mostly read dead: that's what the official SPICE solvers are for.
//
// Types for editors: packages/mod-api in the repo (@deadboard/mod-api). Code mods can't contain
// the word that loads other modules, so the types come in through a global namespace:
/// <reference types="@deadboard/mod-api/global" />
/** @typedef {DeadboardMod.ModApi} ModApi */
/** @typedef {DeadboardMod.SolveInput} SolveInput */
/** @typedef {DeadboardMod.SolveResult} SolveResult */
/** @typedef {DeadboardMod.NetPart} NetPart */

/** @param {ModApi} api */
export default function activate(api) {
  api.register.solver('ideal-dc', {
    name: 'Ideal DC (example)',
    description: 'Resistors, batteries, switches, fuses, diodes and LEDs; no ICs.',
    solve,
  });
  api.on('board:loaded', ({ title, netlist }) => api.log(`board loaded: ${title} (${netlist.parts.length} parts)`));
}

const R_CLOSED = 0.05;    // a closed switch / intact fuse (Ω)
const R_DIODE = 1;        // diode series resistance when conducting (Ω)
const R_LED = 10;         // LED series resistance when conducting (Ω)
const VF_DIODE = 0.65;    // silicon diode forward voltage (V)
const G_METER = 1e-7;     // the voltmeter's 10 MΩ input
const GMIN = 1e-9;        // every node to ground, so nothing floats in the matrix
const LED_ON = 0.002, LED_MAX = 0.03;

/** The two ends of a two-terminal part: by role (A/K, +/-) or the first two pads. */
function ends(/** @type {NetPart} */ p, /** @type {[string, string]} */ roles) {
  let a = p.pins.find((x) => x.role === roles[0]);
  let b = p.pins.find((x) => x.role === roles[1]);
  if (!a || !b) {
    const seen = new Set();
    const two = p.pins.filter((x) => !seen.has(x.pad) && seen.add(x.pad));
    [a, b] = [two[0], two[1]];
  }
  if (!a || !b || a.open || b.open || a.net < 0 || b.net < 0) return null;
  return { a: a.net, b: b.net, ohms: (a.ohms ?? 0) + (b.ohms ?? 0) };
}

/** @param {SolveInput} input @returns {SolveResult} */
function solve({ netlist, meters }) {
  const live = netlist.parts.filter((p) => p.populated);
  const battery = live.find((p) => p.kind === 'battery' && !p.burnt && ends(p, ['+', '-']));
  if (!battery) return { nets: {}, parts: {}, source: false };
  const ground = /** @type {{a: number, b: number}} */ (ends(battery, ['+', '-'])).b;

  // elements: [kind, net a, net b, value, part]
  /** @type {{ kind: 'R' | 'V' | 'D', a: number, b: number, r: number, v?: number, part?: NetPart }[]} */
  const els = [];
  for (const p of live) {
    if (p.leak) {
      const a = p.pins.find((x) => x.pad === p.leak?.a), b = p.pins.find((x) => x.pad === p.leak?.b);
      if (a && b && !a.open && !b.open && a.net >= 0 && b.net >= 0) els.push({ kind: 'R', a: a.net, b: b.net, r: p.leak.ohms });
    }
    if (p.burnt) continue;
    if (p.kind === 'battery') { const e = ends(p, ['+', '-']); if (e) els.push({ kind: 'V', a: e.a, b: e.b, r: (p.rint ?? 0.2) + e.ohms, v: p.value, part: p }); continue; }
    if (p.kind === 'led' || p.kind === 'diode') {
      const e = ends(p, ['A', 'K']);
      if (e) els.push({ kind: 'D', a: e.a, b: e.b, r: (p.kind === 'led' ? R_LED : R_DIODE) + e.ohms, v: p.vf ?? (p.kind === 'led' ? 2 : VF_DIODE), part: p });
      continue;
    }
    const e = ends(p, ['1', '2']);
    if (!e) continue;
    if (p.kind === 'resistor' && p.value > 0) els.push({ kind: 'R', a: e.a, b: e.b, r: p.value + e.ohms, part: p });
    else if (p.kind === 'switch' && p.closed) els.push({ kind: 'R', a: e.a, b: e.b, r: R_CLOSED + e.ohms, part: p });
    else if (p.kind === 'fuse') els.push({ kind: 'R', a: e.a, b: e.b, r: R_CLOSED + e.ohms, part: p });
  }
  for (const [a, b] of meters) els.push({ kind: 'R', a, b: b < 0 ? ground : b, r: 1 / G_METER });

  // unknowns: every net an element touches, except ground
  /** @type {Map<number, number>} */
  const idx = new Map();
  for (const e of els) for (const n of [e.a, e.b]) if (n !== ground && !idx.has(n)) idx.set(n, idx.size);
  const n = idx.size;
  const on = new Set();

  /** @type {Float64Array} */
  let V = new Float64Array(n);
  const volt = (/** @type {number} */ net) => (net === ground ? 0 : V[/** @type {number} */ (idx.get(net))]);
  for (let iter = 0; iter < 60; iter++) {
    const G = Array.from({ length: n }, () => new Float64Array(n));
    const I = new Float64Array(n);
    for (let i = 0; i < n; i++) G[i][i] += GMIN;
    const stamp = (/** @type {number} */ a, /** @type {number} */ b, /** @type {number} */ g, /** @type {number} */ j) => {
      const ia = idx.get(a), ib = idx.get(b);
      if (ia !== undefined) { G[ia][ia] += g; I[ia] += j; }
      if (ib !== undefined) { G[ib][ib] += g; I[ib] -= j; }
      if (ia !== undefined && ib !== undefined) { G[ia][ib] -= g; G[ib][ia] -= g; }
    };
    for (const e of els) {
      if (e.kind === 'R') stamp(e.a, e.b, 1 / e.r, 0);
      else if (e.kind === 'V') stamp(e.a, e.b, 1 / e.r, /** @type {number} */ (e.v) / e.r);
      else if (on.has(e)) stamp(e.a, e.b, 1 / e.r, /** @type {number} */ (e.v) / e.r);
    }
    V = gauss(G, I);
    let changed = false;
    for (const e of els) {
      if (e.kind !== 'D') continue;
      const vd = volt(e.a) - volt(e.b);
      const conducting = on.has(e) ? vd - /** @type {number} */ (e.v) > -1e-9 : vd > /** @type {number} */ (e.v);
      if (conducting !== on.has(e)) { changed = true; if (conducting) on.add(e); else on.delete(e); }
    }
    if (!changed) break;
  }

  /** @type {Record<number, number>} */
  const nets = { [ground]: 0 };
  for (const [net, i] of idx) nets[net] = V[i];
  /** @type {SolveResult['parts']} */
  const parts = {};
  for (const e of els) {
    if (!e.part) continue;
    const v = volt(e.a) - volt(e.b);
    const i = e.kind === 'V' ? (/** @type {number} */ (e.v) - v) / e.r : e.kind === 'D' ? (on.has(e) ? (v - /** @type {number} */ (e.v)) / e.r : 0) : v / e.r;
    const p = Math.abs(v * i);
    const r = { i, v, p };
    if (e.part.kind === 'led') Object.assign(r, { on: i > LED_ON, bright: Math.min(1, i / 0.02), over: i > LED_MAX, ...(i > LED_MAX && { overMsg: 'LED overcurrent' }) });
    if (e.part.kind === 'resistor' && p > (e.part.rating ?? 0.5)) Object.assign(r, { over: true, overMsg: `${p.toFixed(2)} W in a ${e.part.rating ?? 0.5} W resistor` });
    if (e.part.kind === 'fuse' && e.part.value > 0 && Math.abs(i) > e.part.value) Object.assign(r, { over: true, overMsg: 'fuse blown' });
    parts[e.part.ref] = r;
  }
  return { nets, parts, source: true };
}

/** Solves G·x = I by Gaussian elimination with partial pivoting. */
function gauss(/** @type {Float64Array[]} */ G, /** @type {Float64Array} */ I) {
  const n = I.length;
  for (let c = 0; c < n; c++) {
    let best = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(G[r][c]) > Math.abs(G[best][c])) best = r;
    [G[c], G[best]] = [G[best], G[c]];
    [I[c], I[best]] = [I[best], I[c]];
    const d = G[c][c] || 1e-30;
    for (let r = c + 1; r < n; r++) {
      const f = G[r][c] / d;
      if (!f) continue;
      for (let k = c; k < n; k++) G[r][k] -= f * G[c][k];
      I[r] -= f * I[c];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = I[r];
    for (let k = r + 1; k < n; k++) s -= G[r][k] * x[k];
    x[r] = s / (G[r][r] || 1e-30);
  }
  return x;
}
