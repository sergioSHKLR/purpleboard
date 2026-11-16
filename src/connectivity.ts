import type { Blob, Board, Component, Jumper, Trace, Via, Zone } from './types';
import { Grid, makeShape, pointInPolygon, polyBB, shapeGap, type BB, type Shape } from './geom';
import { padMask, padShape, rolePadName } from './model';

export type ItemKind = 'pad' | 'trace' | 'via' | 'blob' | 'jend' | 'zone';

export interface CuItem {
  kind: ItemKind;
  layers: number; // bit 1 = F, bit 2 = B
  shape: Shape;
  comp?: Component;
  pi?: number;
  trace?: Trace;
  via?: Via;
  blob?: Blob;
  jumper?: Jumper;
  end?: number;
  zone?: Zone;
  net?: string;
}

export interface Conn {
  items: CuItem[];
  /** Net index per item. */
  net: Int32Array;
  netCount: number;
  netNames: string[];
  netItems: number[][];
  grid: Grid;
  /** Item index for each pad of each component. */
  padItem: Map<Component, number[]>;
  traceItem: Map<Trace, number>;
  viaItem: Map<Via, number>;
  blobItem: Map<Blob, number>;
}

export const sideMask = (s: 'F' | 'B') => (s === 'F' ? 1 : 2);

function find(p: Int32Array, i: number): number {
  while (p[i] !== i) { p[i] = p[p[i]]; i = p[i]; }
  return i;
}
function union(p: Int32Array, a: number, b: number) {
  a = find(p, a); b = find(p, b);
  if (a !== b) p[a < b ? b : a] = a < b ? a : b;
}

function zoneTouches(z: CuItem, o: CuItem): boolean {
  const poly = z.zone!.poly;
  for (const p of o.shape.pts) if (pointInPolygon(p, poly)) return true;
  // thermal relief: the pour keeps clear of its own pads and reaches them through spokes, so
  // only the spoke ends touch the pad edge — test the pour's edges near the item against it
  const bb = o.shape.bb, e = 0.02;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if (Math.max(a[0], b[0]) < bb[0] - e || Math.min(a[0], b[0]) > bb[2] + e || Math.max(a[1], b[1]) < bb[1] - e || Math.min(a[1], b[1]) > bb[3] + e) continue;
    if (shapeGap(makeShape([a, b], 0), o.shape) <= 0.01) return true;
  }
  return false;
}

export function buildConnectivity(board: Board): Conn {
  const items: CuItem[] = [];
  const padItem = new Map<Component, number[]>();
  const traceItem = new Map<Trace, number>();
  const viaItem = new Map<Via, number>();
  const blobItem = new Map<Blob, number>();
  const tracedNets = new Set<string>();
  const hiddenNets = new Set(board.hiddenCopperNets ?? []);

  for (const c of board.components) {
    const idx: number[] = [];
    c.pads.forEach((p, pi) => {
      idx.push(items.length);
      items.push({ kind: 'pad', layers: padMask(p), shape: padShape(c, p), comp: c, pi, net: p.net });
    });
    padItem.set(c, idx);
  }
  for (const t of board.traces) {
    if (t.net) tracedNets.add(t.net);
    traceItem.set(t, items.length);
    items.push({ kind: 'trace', layers: sideMask(t.layer), shape: makeShape([t.a, t.b], t.w / 2), trace: t, net: t.net });
  }
  for (const v of board.vias) {
    viaItem.set(v, items.length);
    items.push({ kind: 'via', layers: v.side ? sideMask(v.side) : 3, shape: makeShape([v.at], v.d / 2), via: v, net: v.net });
  }
  for (const b of board.blobs) {
    blobItem.set(b, items.length);
    items.push({ kind: 'blob', layers: sideMask(b.layer), shape: makeShape([b.at], b.r), blob: b });
  }
  const jStart = items.length;
  for (const j of board.jumpers) {
    items.push({ kind: 'jend', layers: sideMask(j.la), shape: makeShape([j.a], 0.35), jumper: j, end: 0 });
    items.push({ kind: 'jend', layers: sideMask(j.lb), shape: makeShape([j.b], 0.35), jumper: j, end: 1 });
  }
  for (const z of board.zones) {
    if (z.poly.length < 3) continue;
    if (z.net) tracedNets.add(z.net);
    items.push({ kind: 'zone', layers: sideMask(z.layer), shape: { pts: z.poly, r: 0, bb: polyBB(z.poly) }, zone: z, net: z.net });
  }

  const n = items.length;
  const bb: BB = [-5, -5, board.w + 5, board.h + 5];
  for (const it of items) {
    bb[0] = Math.min(bb[0], it.shape.bb[0]); bb[1] = Math.min(bb[1], it.shape.bb[1]);
    bb[2] = Math.max(bb[2], it.shape.bb[2]); bb[3] = Math.max(bb[3], it.shape.bb[3]);
  }
  const area = (bb[2] - bb[0]) * (bb[3] - bb[1]);
  const grid = new Grid(bb, Math.max(1.5, Math.sqrt(area / Math.max(1, n)) * 1.5), n);
  items.forEach((it, i) => grid.insert(i, it.shape.bb));

  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const cand: number[] = [];
  for (let i = 0; i < n; i++) {
    const A = items[i];
    grid.query(A.shape.bb, cand);
    for (const j of cand) {
      if (j <= i) continue;
      const B = items[j];
      if (!(A.layers & B.layers)) continue;
      if (A.net && B.net && A.net !== B.net) continue;
      if (A.kind === 'pad' && B.kind === 'pad' && A.comp === B.comp) continue; // same footprint, handled below
      let hit: boolean;
      if (A.kind === 'zone' && B.kind === 'zone') hit = false;
      else if (A.kind === 'zone') hit = zoneTouches(A, B);
      else if (B.kind === 'zone') hit = zoneTouches(B, A);
      else {
        const a = A.shape.bb, b = B.shape.bb;
        if (a[0] > b[2] || b[0] > a[2] || a[1] > b[3] || b[1] > a[3]) continue;
        hit = shapeGap(A.shape, B.shape) <= 1e-6;
      }
      if (hit) union(parent, i, j);
    }
  }
  // Jumper wire ends are joined by the wire itself.
  for (let i = jStart; i < jStart + board.jumpers.length * 2; i += 2) union(parent, i, i + 1);
  // Pads sharing a name in one populated part are internally connected (e.g. tactile switch legs).
  for (const c of board.components) {
    if (!c.state.populated) continue;
    const idx = padItem.get(c)!;
    const first = new Map<string, number>();
    c.pads.forEach((p, pi) => {
      if (c.state.cold.includes(pi)) return;
      const f = first.get(p.name);
      if (f === undefined) first.set(p.name, idx[pi]);
      else union(parent, f, idx[pi]);
    });
  }
  // Connect un-traced multi-layer planes (GND / mega power nets with no traces) across non-cold pads and vias.
  // Nets with broken copper (state.netBreak) connect along their spanning tree minus the broken links.
  const broken = new Map<string, number[]>(); // net name → item indices of pads with a break
  for (const c of board.components) {
    for (const pi of c.state.netBreak ?? []) {
      const nm = c.pads[pi]?.net, idx = padItem.get(c)?.[pi];
      if (!nm || idx === undefined) continue;
      (broken.get(nm) ?? broken.set(nm, []).get(nm)!).push(idx);
    }
  }
  const firstByNet = new Map<string, number>();
  const brokenMembers = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const it = items[i];
    if ((it.kind !== 'pad' && it.kind !== 'via') || !it.net) continue;
    // drawn copper connects by geometry — except through a hidden inner plane: there the
    // net's vias and through-hole pads (which reach every layer) are joined by design
    if (tracedNets.has(it.net) && !(hiddenNets.has(it.net) && (it.kind === 'via' || it.layers === 3))) continue;
    if (it.kind === 'pad' && it.comp!.state.cold.includes(it.pi!)) continue;
    if (broken.has(it.net)) { (brokenMembers.get(it.net) ?? brokenMembers.set(it.net, []).get(it.net)!).push(i); continue; }
    const prev = firstByNet.get(it.net);
    if (prev === undefined) firstByNet.set(it.net, i);
    else union(parent, prev, i);
  }
  for (const [nm, members] of brokenMembers) {
    for (const [a, b] of brokenTree(items, members, broken.get(nm)!)) union(parent, a, b);
  }

  const net = new Int32Array(n);
  const rootToNet = new Map<number, number>();
  const netItems: number[][] = [];
  for (let i = 0; i < n; i++) {
    const r = find(parent, i);
    let k = rootToNet.get(r);
    if (k === undefined) { k = netItems.length; rootToNet.set(r, k); netItems.push([]); }
    net[i] = k;
    netItems[k].push(i);
  }
  const netNames: string[] = netItems.map((list, k) => {
    for (const i of list) if (items[i].net) return items[i].net!;
    for (const i of list) {
      const it = items[i];
      if (it.kind === 'pad') return `Net-(${it.comp!.ref}-${it.comp!.pads[it.pi!].name})`;
    }
    return `Net-${k}`;
  });

  return { items, net, netCount: netItems.length, netNames, netItems, grid, padItem, traceItem, viaItem, blobItem };
}

/**
 * Links of a name-connected net with broken copper. Without routing data the net is taken to
 * run along its minimum spanning tree (the airwires); a break at a pad removes, of that pad's
 * links, the one toward the larger rest of the net — its local branch is cut off.
 */
function brokenTree(items: CuItem[], members: number[], breaks: number[]): [number, number][] {
  const m = members.length;
  if (m < 2) return [];
  const pos = members.map((i) => { const b = items[i].shape.bb; return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; });
  const inTree = new Uint8Array(m), best = new Float64Array(m).fill(Infinity), par = new Int32Array(m).fill(-1);
  best[0] = 0;
  const edges: [number, number][] = [];
  for (let k = 0; k < m; k++) {
    let u = -1;
    for (let j = 0; j < m; j++) if (!inTree[j] && (u < 0 || best[j] < best[u])) u = j;
    inTree[u] = 1;
    if (par[u] >= 0) edges.push([par[u], u]);
    for (let j = 0; j < m; j++) {
      if (inTree[j]) continue;
      const d = Math.hypot(pos[j][0] - pos[u][0], pos[j][1] - pos[u][1]);
      if (d < best[j]) { best[j] = d; par[j] = u; }
    }
  }
  const alive = edges.map(() => true);
  const local = new Map(members.map((it, k) => [it, k]));
  const reach = (from: number, skip: number) => {
    const seen = new Set([from]);
    const stack = [from];
    while (stack.length) {
      const u = stack.pop()!;
      edges.forEach(([a, b], e) => {
        if (!alive[e] || e === skip) return;
        const v = a === u ? b : b === u ? a : -1;
        if (v >= 0 && !seen.has(v)) { seen.add(v); stack.push(v); }
      });
    }
    return seen.size;
  };
  for (const it of breaks) {
    const p = local.get(it);
    if (p === undefined) continue;
    let cut = -1, far = -1;
    edges.forEach(([a, b], e) => {
      if (!alive[e] || (a !== p && b !== p)) return;
      const size = reach(a === p ? b : a, e);
      if (size > far) { far = size; cut = e; }
    });
    if (cut >= 0) alive[cut] = false;
  }
  return edges.filter((_, e) => alive[e]).map(([a, b]) => [members[a], members[b]]);
}

/** Net that a component's electrical role is attached to, or -1 if floating (empty, cold joint). */
export function pinNet(conn: Conn, c: Component, role: string): number {
  if (!c.state.populated) return -1;
  const name = rolePadName(c, role);
  if (name === undefined) return -1;
  const idx = conn.padItem.get(c);
  if (!idx) return -1;
  for (let pi = 0; pi < c.pads.length; pi++)
    if (c.pads[pi].name === name && !c.state.cold.includes(pi)) return conn.net[idx[pi]];
  return -1;
}

export function padNet(conn: Conn, c: Component, padName: string): number {
  const idx = conn.padItem.get(c);
  const pi = c.pads.findIndex((p) => p.name === padName);
  return idx && pi >= 0 ? conn.net[idx[pi]] : -1;
}
