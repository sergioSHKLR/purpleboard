// Airwires ("ratsnest"): straight lines that show which pins share a net. They state what is
// connected *by design*, not where the copper runs — boardview files carry no routing, so
// drawing a path would be invented. Like a real boardview they follow the netlist (pad net
// names), so they do not give away damage (a cold joint or broken trace still shows its
// airwire); boards without net names fall back to live connectivity. Per net, the lines form
// a minimum spanning tree (shortest set of lines that links every pin).
import type { Board, Component, Side, V2 } from './types';
import type { Conn } from './connectivity';
import { padWorld } from './model';

export interface Airwire { a: V2; sa: Side; b: V2; sb: Side; /** stable per-net colour key */ net: number }

/** Nets with more pins than this (ground, main rails) would only draw a starburst; skipped. */
export const AIRWIRE_MAX_PINS = 250;

const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

/** Airwires for every net that touches one of `comp`'s pads. */
export function airwiresFor(board: Board, conn: Conn, comp: Component, maxPins = AIRWIRE_MAX_PINS): Airwire[] {
  type Pin = { at: V2; side: Side };
  const pinOf = (c: Component, pi: number): Pin => {
    const p = c.pads[pi];
    return { at: padWorld(c, p).at, side: p.layers === 'B' ? 'B' : p.layers === 'F' ? 'F' : c.side };
  };
  const groups = new Map<string, Pin[]>();
  const own = conn.padItem.get(comp) ?? [];
  comp.pads.forEach((p, pi) => {
    const key = p.net ? `n:${p.net}` : `c:${conn.net[own[pi]] ?? -1}`;
    if (groups.has(key) || key === 'c:-1') return;
    const pins: Pin[] = [];
    if (p.net) {
      for (const c of board.components) c.pads.forEach((q, qi) => { if (q.net === p.net) pins.push(pinOf(c, qi)); });
    } else {
      for (const i of conn.netItems[conn.net[own[pi]]] ?? []) {
        const it = conn.items[i];
        if (it.kind === 'pad' && it.comp && it.pi !== undefined) pins.push(pinOf(it.comp, it.pi));
      }
    }
    groups.set(key, pins);
  });
  const out: Airwire[] = [];
  for (const [key, pts] of groups) {
    if (pts.length < 2 || pts.length > maxPins) continue;
    const net = hash(key) % 100003;
    // Prim's MST, O(n²) — fine for n ≤ maxPins, computed once per selection
    const n = pts.length;
    const inTree = new Uint8Array(n);
    const best = new Float64Array(n).fill(Infinity);
    const parent = new Int32Array(n).fill(-1);
    best[0] = 0;
    for (let k = 0; k < n; k++) {
      let u = -1;
      for (let j = 0; j < n; j++) if (!inTree[j] && (u < 0 || best[j] < best[u])) u = j;
      inTree[u] = 1;
      if (parent[u] >= 0) {
        const p = pts[parent[u]], q = pts[u];
        if (Math.hypot(p.at[0] - q.at[0], p.at[1] - q.at[1]) > 0.01 || p.side !== q.side) out.push({ a: p.at, sa: p.side, b: q.at, sb: q.side, net });
      }
      for (let j = 0; j < n; j++) {
        if (inTree[j]) continue;
        const d = Math.hypot(pts[j].at[0] - pts[u].at[0], pts[j].at[1] - pts[u].at[1]);
        if (d < best[j]) { best[j] = d; parent[j] = u; }
      }
    }
  }
  return out;
}
