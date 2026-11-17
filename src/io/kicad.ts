import type { Board, Body, Component, ComponentKind, InnerCopper, Pad, PadLayers, PadShape, Scenario, Side, V2 } from '../types';
import { parseValue } from '../model';
import { parseScenario } from './format';
import { emptyBoard } from '../scenarios/builder';
import { isBrdData, parseBrd } from './brd';
import { addBenchSupply, chooseInputRail } from './benchSupply';

type SExpr = string | SExpr[];

function tokenize(src: string): SExpr {
  const stack: SExpr[][] = [[]];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src.charCodeAt(i);
    if (ch <= 32) { i++; continue; }
    if (ch === 40) { // '('
      const child: SExpr[] = [];
      stack[stack.length - 1].push(child);
      stack.push(child);
      i++;
    } else if (ch === 41) { // ')'
      if (stack.length > 1) stack.pop();
      i++;
    } else if (ch === 34) { // '"'
      i++;
      let s = '';
      while (i < n) {
        const c = src.charCodeAt(i);
        if (c === 92 && i + 1 < n) { s += src[i + 1]; i += 2; continue; }
        if (c === 34) { i++; break; }
        s += src[i++];
      }
      stack[stack.length - 1].push(s);
    } else {
      let s = '';
      while (i < n) {
        const c = src.charCodeAt(i);
        if (c <= 32 || c === 40 || c === 41) break;
        s += src[i++];
      }
      stack[stack.length - 1].push(s);
    }
  }
  return stack[0][0] ?? [];
}

const head = (x: SExpr | undefined): string => (Array.isArray(x) && typeof x[0] === 'string' ? x[0] : '');
const kids = (x: SExpr | undefined, tag: string): SExpr[][] =>
  Array.isArray(x) ? x.filter((k): k is SExpr[] => Array.isArray(k) && k[0] === tag) : [];
const kid = (x: SExpr | undefined, tag: string): SExpr[] | undefined => kids(x, tag)[0];
const str = (x: SExpr | undefined, idx = 1, d = ''): string =>
  Array.isArray(x) && typeof x[idx] === 'string' ? x[idx] : d;
const flt = (x: SExpr | undefined, idx = 1, d = 0): number => {
  const v = Array.isArray(x) && typeof x[idx] === 'string' ? parseFloat(x[idx]) : NaN;
  return Number.isFinite(v) ? v : d;
};

/** Douglas–Peucker on a closed ring (tolerance in mm); coordinates rounded to 0.01 mm. */
export function simplifyRing(ring: V2[], tol: number): V2[] {
  const n = ring.length;
  if (n < 4) return ring;
  const keep = new Uint8Array(n);
  // split at the vertex farthest from the first so the closed ring becomes two open chains
  let far = 0, fd = -1;
  for (let i = 1; i < n; i++) { const d = (ring[i][0] - ring[0][0]) ** 2 + (ring[i][1] - ring[0][1]) ** 2; if (d > fd) { fd = d; far = i; } }
  keep[0] = keep[far] = 1;
  const stack: [number, number][] = [[0, far], [far, n]];
  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    const a = ring[i0], b = ring[i1 % n];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
    let best = -1, bd = tol;
    for (let i = i0 + 1; i < i1; i++) {
      const p = ring[i];
      const d = len > 1e-9 ? Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len : Math.hypot(p[0] - a[0], p[1] - a[1]);
      if (d > bd) { bd = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([i0, best], [best, i1]); }
  }
  const out: V2[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push([Math.round(ring[i][0] * 100) / 100, Math.round(ring[i][1] * 100) / 100]);
  return out;
}

function mapLayer(name: string): Side | null {
  if (name === 'F.Cu' || name === 'F.SilkS' || name === 'F.Silkscreen') return 'F';
  if (name === 'B.Cu' || name === 'B.SilkS' || name === 'B.Silkscreen') return 'B';
  return null;
}

// Refdes prefixes need a digit after them: "FB2" is a ferrite, not a fuse; "CN1" a connector, not a cap.
function classifyKind(ref: string, valText: string, fpName: string): ComponentKind {
  const r = ref.toUpperCase();
  const fp = fpName.toLowerCase();
  if (/^(NT|FB|L)\d/.test(r)) return 'resistor'; // net tie / ferrite / inductor: a low-ohm power path
  if (/^R\d/.test(r) || fp.includes('resistor')) return 'resistor';
  if (/^C\d/.test(r) || /(^|[^a-z])cap/.test(fp)) return 'capacitor';
  if (/^(LED|D)\d/.test(r) || fp.includes('led')) {
    return fp.includes('led') || r.startsWith('LED') || /red|green|blue|yellow|white|orange/i.test(valText) ? 'led' : 'diode';
  }
  if (/^F\d/.test(r) || fp.includes('fuse')) return 'fuse';
  if (/^(SW|S|BTN)\d/.test(r) || fp.includes('switch') || fp.includes('button')) return 'switch';
  if (/^(BT|BAT)\d/.test(r) || fp.includes('battery') || fp.includes('cr2032')) return 'battery';
  if (/^TP\d/.test(r) || fp.includes('testpoint')) return 'testpoint';
  if (/^(J|P|CN|X)\d/.test(r) || /^PWR\d/.test(r) || fp.includes('header') || fp.includes('usb') || fp.includes('connector')) return 'connector';
  if (/^(U|IC|Q)\d/.test(r) || fp.includes('soic') || fp.includes('dip') || fp.includes('qfn')) return 'ic';
  return 'generic';
}

/** Bidirectional ESD / TVS protection (no conduction at working voltage); unidirectional TVS ("…A") stay diodes. */
const ESD_BIDIR = /^(ESD|PESD|TPD\d|PRTR|SP0\d|RCLAMP|USBLC|NUP\d|ESDA|CDSOD|TVS)|^(SM[ABCJF]+|P[46]KE|1\.5KE|SMF)\d+(\.\d+)?CA\b/i;

/** Coin / RTC cells: 3 V lithium chemistries (CR, BR, ML, MS series) or coin holders. */
const COIN_CELL = /\b(CR|BR|ML|MS|VL)\d{3,4}|coin|rtc/i;

/** Footprint-local box of the part body: the fabrication outline if the footprint has one (KiCad libraries draw the body on F.Fab / B.Fab), else null. */
function fabBox(f: SExpr): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (n: SExpr | undefined) => { if (!n) return; const x = flt(n, 1), y = -flt(n, 2); if (!Number.isFinite(x) || !Number.isFinite(y)) return; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); };
  for (const tag of ['fp_line', 'fp_rect', 'fp_poly', 'fp_circle', 'fp_arc']) {
    for (const g of kids(f, tag)) {
      if (!/\.Fab$/.test(str(kid(g, 'layer')))) continue;
      add(kid(g, 'start')); add(kid(g, 'end')); add(kid(g, 'mid')); add(kid(g, 'center'));
      const pts = kid(g, 'pts');
      if (pts) for (const xy of kids(pts, 'xy')) add(xy);
      if (tag === 'fp_circle') { const c = kid(g, 'center'), e = kid(g, 'end'); if (c && e) { const r = Math.hypot(flt(e, 1) - flt(c, 1), flt(e, 2) - flt(c, 2)); add(['', String(flt(c, 1) - r), String(flt(c, 2) - r)] as SExpr); add(['', String(flt(c, 1) + r), String(flt(c, 2) + r)] as SExpr); } }
    }
  }
  return Number.isFinite(x0) && x1 - x0 > 0.05 && y1 - y0 > 0.05 ? { x0, y0, x1, y1 } : null;
}

/**
 * Body for a footprint. Surface-mount parts get low SMD bodies sized from the fabrication
 * outline (or the pads); through-hole parts keep the classic leaded shapes. Heights are typical
 * package heights (estimates: a layout carries no 3D model data here).
 */
function inferBody(kind: ComponentKind, pads: Pad[], fab: { x0: number; y0: number; x1: number; y1: number } | null, fpName: string): Body {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pads) {
    x0 = Math.min(x0, p.at[0] - p.size[0] / 2);
    x1 = Math.max(x1, p.at[0] + p.size[0] / 2);
    y0 = Math.min(y0, p.at[1] - p.size[1] / 2);
    y1 = Math.max(y1, p.at[1] + p.size[1] / 2);
  }
  const smd = pads.length > 0 && pads.every((p) => !p.drill);
  if (smd) {
    const b = fab ?? (Number.isFinite(x0) ? { x0, y0, x1, y1 } : { x0: -0.5, y0: -0.25, x1: 0.5, y1: 0.25 });
    const w = Math.max(0.3, b.x1 - b.x0), h = Math.max(0.2, b.y1 - b.y0);
    const off: [number, number] = [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
    const withOff = (body: Body): Body => (Math.abs(off[0]) + Math.abs(off[1]) > 0.05 ? { ...body, off } : body);
    const small = Math.min(w, h);
    if (kind === 'capacitor' && /CP_Elec|Elec|Polymer|Tantal/i.test(fpName) && small > 3) return withOff({ shape: 'radial', w, h, z: Math.min(10, small * 1.1) });
    if (kind === 'led') return withOff({ shape: 'led', w, h, z: Math.max(0.5, Math.min(1.2, small * 0.8)) });
    if (kind === 'testpoint') return { shape: 'pin', w: Math.max(0.8, small), h: Math.max(0.8, small), z: 0.3 };
    if (kind === 'connector') return withOff({ shape: 'box', w, h, z: Math.max(1.0, Math.min(6, small * 0.6)) });
    if (pads.length === 2 && kind !== 'ic') return withOff({ shape: 'box', w, h, z: Math.max(0.3, Math.min(1.6, small * 0.6)) });
    return withOff({ shape: 'chip', w, h, z: Math.max(0.6, Math.min(2.5, small * 0.15 + 0.6)) });
  }
  const w = Number.isFinite(x0) ? Math.max(2.0, x1 - x0) : 3.2;
  const h = Number.isFinite(y0) ? Math.max(1.6, y1 - y0) : 1.8;
  switch (kind) {
    case 'resistor': return { shape: 'axial', w: Math.max(3.2, w * 0.65), h: Math.min(3.0, Math.max(1.6, h)), z: 2.6 };
    case 'led': return { shape: 'led', w: Math.min(5, Math.max(2.4, w)), h: Math.min(5, Math.max(2.4, w)), z: 5.5 };
    case 'capacitor': return { shape: 'radial', w: Math.max(2.4, w * 0.7), h: Math.max(2.4, h), z: 3.5 };
    case 'battery': return { shape: w > 12 ? 'coin' : 'header', w: Math.max(3, w), h: Math.max(3, h), z: w > 12 ? 3.4 : 6.0 };
    case 'switch': return { shape: 'tactile', w: Math.max(4, w * 0.8), h: Math.max(4, h * 0.8), z: 4.5 };
    case 'fuse': return { shape: 'fuse', w: Math.max(4, w * 0.7), h: 2.4, z: 3.0 };
    case 'testpoint': return { shape: 'pin', w: 1.4, h: 1.4, z: 3.5 };
    case 'ic': return { shape: 'chip', w: Math.max(3.5, w * 0.75), h: Math.max(3.5, h * 0.75), z: 2.2 };
    case 'connector': return { shape: 'header', w: Math.max(2.5, w), h: Math.max(2.5, h), z: 6.0 };
    default: return { shape: 'box', w: Math.max(2.0, w * 0.7), h: Math.max(1.6, h * 0.7), z: 2.0 };
  }
}

/** Parses a KiCad `.kicad_pcb` file into a simulatable `Board` (Y-flipped to Y-up `[0,w]x[0,h]`). */
export function parseKicadPcb(src: string): { board: Board; title: string } {
  const root = tokenize(src);
  if (head(root) !== 'kicad_pcb') throw new Error('Not a valid KiCad .kicad_pcb file');

  const nets = new Map<number, string>();
  for (const n of kids(root, 'net')) {
    const id = Math.round(flt(n, 1, -1));
    if (id >= 0) nets.set(id, str(n, 2, `Net-${id}`));
  }

  // Collect Edge.Cuts bounds first, fallback to copper bounds.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const expand = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };

  for (const g of kids(root, 'gr_rect')) {
    if (str(kid(g, 'layer')) === 'Edge.Cuts') {
      const s = kid(g, 'start'), e = kid(g, 'end');
      if (s && e) { expand(flt(s, 1), flt(s, 2)); expand(flt(e, 1), flt(e, 2)); }
    }
  }
  for (const g of kids(root, 'gr_line')) {
    if (str(kid(g, 'layer')) === 'Edge.Cuts') {
      const s = kid(g, 'start'), e = kid(g, 'end');
      if (s && e) { expand(flt(s, 1), flt(s, 2)); expand(flt(e, 1), flt(e, 2)); }
    }
  }

  const fps = [...kids(root, 'footprint'), ...kids(root, 'module')];
  const segs = kids(root, 'segment');
  const vias = kids(root, 'via');

  if (!Number.isFinite(minX)) {
    for (const f of fps) { const at = kid(f, 'at'); if (at) expand(flt(at, 1), flt(at, 2)); }
    for (const s of segs) {
      const a = kid(s, 'start'), b = kid(s, 'end');
      if (a && b) { expand(flt(a, 1), flt(a, 2)); expand(flt(b, 1), flt(b, 2)); }
    }
    minX -= 6; minY -= 6; maxX += 6; maxY += 6;
  }

  if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 60; maxY = 40; }
  const w = Math.max(10, Math.round((maxX - minX) * 100) / 100);
  const h = Math.max(10, Math.round((maxY - minY) * 100) / 100);
  // KiCad is Y-down; convert to Y-up [0, w] x [0, h].
  const toWorld = (kx: number, ky: number): V2 => [kx - minX, maxY - ky];

  const board = emptyBoard(w, h);
  let next = 1;
  // copper on inner layers is kept for display only (Board.inner); electrically its nets are
  // joined by design (Board.hiddenCopperNets)
  const hidden = new Set<string>();
  const isInner = (l: string) => /^In\d+\.Cu$/.test(l);
  const innerNo = (l: string) => parseInt(l.slice(2), 10);
  const inner: InnerCopper = { traces: [], zones: [] };
  const netOf = (node: SExpr | undefined) => {
    const n = kid(node, 'net');
    if (!n) return undefined;
    const id = Math.round(flt(n, 1, NaN));
    return Number.isFinite(id) ? nets.get(id) : str(n, 1) || undefined; // KiCad 9 may name the net directly
  };
  const pushTrack = (layerName: string, pts: V2[], width: number, net: string | undefined) => {
    const layer = mapLayer(layerName);
    if (!layer) {
      if (!isInner(layerName)) return;
      if (net) hidden.add(net);
      const r2 = (p: V2): V2 => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100];
      for (let i = 1; i < pts.length; i++) inner.traces.push({ layer: innerNo(layerName), a: r2(pts[i - 1]), b: r2(pts[i]), w: width, net });
      return;
    }
    for (let i = 1; i < pts.length; i++) board.traces.push({ id: 't' + (next++).toString(36), layer, a: pts[i - 1], b: pts[i], w: width, net });
  };

  for (const s of segs) {
    const a = kid(s, 'start'), b = kid(s, 'end');
    if (!a || !b) continue;
    pushTrack(str(kid(s, 'layer')), [toWorld(flt(a, 1), flt(a, 2)), toWorld(flt(b, 1), flt(b, 2))], Math.max(0.15, flt(kid(s, 'width'), 1, 0.4)), netOf(s));
  }
  // arc tracks (KiCad 6+): start → mid → end as a short polyline
  for (const s of kids(root, 'arc')) {
    const a = kid(s, 'start'), m = kid(s, 'mid'), b = kid(s, 'end');
    if (!a || !m || !b) continue;
    pushTrack(str(kid(s, 'layer')), [toWorld(flt(a, 1), flt(a, 2)), toWorld(flt(m, 1), flt(m, 2)), toWorld(flt(b, 1), flt(b, 2))], Math.max(0.15, flt(kid(s, 'width'), 1, 0.4)), netOf(s));
  }

  for (const v of vias) {
    const at = kid(v, 'at');
    if (!at) continue;
    const size = flt(kid(v, 'size'), 1, 1.0);
    const drill = flt(kid(v, 'drill'), 1, 0.5);
    board.vias.push({
      id: 'v' + (next++).toString(36),
      at: toWorld(flt(at, 1), flt(at, 2)),
      d: size,
      drill,
      net: netOf(v),
    });
  }

  for (const g of kids(root, 'gr_line')) {
    const layer = mapLayer(str(kid(g, 'layer')));
    if (!layer) continue;
    const s = kid(g, 'start'), e = kid(g, 'end');
    if (!s || !e) continue;
    const sw = flt(kid(g, 'width'), 1, 0.15);
    board.silk.push({ a: toWorld(flt(s, 1), flt(s, 2)), b: toWorld(flt(e, 1), flt(e, 2)), w: sw, side: layer });
  }

  for (const g of kids(root, 'gr_text')) {
    const layer = mapLayer(str(kid(g, 'layer')));
    if (!layer) continue;
    const at = kid(g, 'at');
    if (!at) continue;
    const txt = str(g, 1);
    if (!txt) continue;
    board.texts.push({ at: toWorld(flt(at, 1), flt(at, 2)), text: txt, size: 1.4, side: layer, rot: flt(at, 3, 0) });
  }

  // copper pours: every filled island on every layer (KiCad 7+ zones may span several layers)
  for (const z of kids(root, 'zone')) {
    const net = netOf(z) ?? (str(kid(z, 'net_name'), 1) || undefined);
    const single = str(kid(z, 'layer'));
    const multi = (kid(z, 'layers') as SExpr[] | undefined)?.slice(1).map(String) ?? [];
    const zoneLayers = single ? [single] : multi;
    const polyPts = (node: SExpr | undefined): V2[] => {
      const ptsNode = node ? kid(node, 'pts') : undefined;
      return ptsNode ? kids(ptsNode, 'xy').map((xy) => toWorld(flt(xy, 1), flt(xy, 2))) : [];
    };
    const addZone = (layerName: string, poly: V2[]) => {
      const layer = mapLayer(layerName);
      if (!layer) {
        if (!isInner(layerName)) return;
        if (net) hidden.add(net);
        // only real fills: a bare zone outline on an inner layer would paint copper that isn't there
        // display-only, so simplified: plane fills carry thousands of antipad-arc vertices
        const simple = simplifyRing(poly, 0.05);
        if (simple.length >= 3 && filled) inner.zones.push({ layer: innerNo(layerName), net, poly: simple });
        return;
      }
      if (poly.length >= 3) board.zones.push({ id: 'z' + (next++).toString(36), layer, net, poly });
    };
    const fills = kids(z, 'filled_polygon');
    const filled = fills.length > 0;
    if (fills.length) for (const fp of fills) addZone(str(kid(fp, 'layer')) || single, polyPts(fp));
    else for (const l of zoneLayers) addZone(l, polyPts(kid(z, 'polygon')));
    // keepout / rule areas carry no net and no copper
    if (!net) continue;
    for (const l of zoneLayers) if (isInner(l)) hidden.add(net);
  }

  for (const f of fps) {
    const fpName = str(f, 1, '');
    const at = kid(f, 'at');
    if (!at) continue;
    const pos = toWorld(flt(at, 1), flt(at, 2));
    const frot = flt(at, 3, 0);
    const side: Side = str(kid(f, 'layer')) === 'B.Cu' ? 'B' : 'F';

    let ref = `U${next}`;
    let valText = '';
    for (const ft of kids(f, 'fp_text')) {
      if (str(ft, 1) === 'reference') ref = str(ft, 2, ref);
      if (str(ft, 1) === 'value') valText = str(ft, 2, '');
    }
    for (const prop of kids(f, 'property')) {
      if (str(prop, 1) === 'Reference') ref = str(prop, 2, ref);
      if (str(prop, 1) === 'Value') valText = str(prop, 2, valText);
    }

    let kind = classifyKind(ref, valText, fpName);
    const attrNode = kid(f, 'attr');
    const attrTokens = Array.isArray(attrNode) ? attrNode.slice(1).map(String) : [];
    if (kids(f, 'property').some((p) => /^dnp$/i.test(str(p, 1)) && !/^(no|false|0)?$/i.test(str(p, 2)))) attrTokens.push('dnp');
    const pads: Pad[] = [];
    for (const pd of kids(f, 'pad')) {
      const pName = str(pd, 1, '1');
      const pType = str(pd, 2, 'thru_hole');
      const pShapeRaw = str(pd, 3, 'circle');
      const pat = kid(pd, 'at');
      const psize = kid(pd, 'size');
      if (!pat || !psize) continue;
      const pLayersNode = kid(pd, 'layers');
      const layerTokens = Array.isArray(pLayersNode) ? pLayersNode.slice(1).map(String) : [];
      let layers: PadLayers = pType === 'thru_hole' ? 'FB' : side;
      if (layerTokens.includes('*.Cu') || (layerTokens.includes('F.Cu') && layerTokens.includes('B.Cu'))) layers = 'FB';
      else if (layerTokens.includes('B.Cu') && !layerTokens.includes('F.Cu')) layers = 'B';
      else if (layerTokens.includes('F.Cu') && !layerTokens.includes('B.Cu')) layers = 'F';

      const shape: PadShape =
        pShapeRaw === 'rect' ? 'rect' : pShapeRaw === 'roundrect' ? 'roundrect' : pShapeRaw === 'oval' ? 'oval' : 'circle';
      const drillNode = kid(pd, 'drill');
      const drill = pType === 'thru_hole' ? flt(drillNode, 1, 0.8) : undefined;
      const netNode = kid(pd, 'net');
      const netName = netNode ? str(netNode, 2) || undefined : undefined;
      // KiCad pad offset is in footprint-local Y-down coords -> negate Y.
      // KiCad angles are counter-clockwise as seen on screen; flipping Y-down → Y-up keeps that
      // visual sense, so angles carry over unchanged (pad angle is absolute in KiCad 6+ files)
      const padAbsRot = Array.isArray(pat) && typeof pat[3] === 'string' ? flt(pat, 3, frot) : frot;
      pads.push({
        name: pName,
        at: [flt(pat, 1), -flt(pat, 2)],
        size: [Math.max(0.4, flt(psize, 1, 1.5)), Math.max(0.4, flt(psize, 2, 1.5))],
        rot: padAbsRot - frot,
        shape,
        layers,
        drill,
        net: netName,
      });
    }

    // Diodes that are not one two-terminal junction: multi-pin packages (ESD arrays, dual diodes)
    // and bidirectional ESD / TVS protectors, which do not conduct in normal operation.
    if (kind === 'diode' && (new Set(pads.map((p) => p.name)).size > 2 || ESD_BIDIR.test(valText.trim()))) kind = 'ic';
    // a bare 2-pin power header on a simple board ("J1 5V") is that board's supply
    if (kind === 'connector' && pads.length === 2 && /^(J|P)\d/i.test(ref) && /^\+?\d+(\.\d+)?v$|^(5v|3v3|vcc|vin|pwr|dc)$/i.test(valText.trim())) kind = 'battery';
    const pins: Record<string, string> = {};
    if (pads.length >= 2) {
      if (kind === 'led' || kind === 'diode') {
        const aPad = pads.find((p) => p.name === 'A' || p.name === '2')?.name ?? pads[1].name;
        const kPad = pads.find((p) => p.name === 'K' || p.name === '1')?.name ?? pads[0].name;
        pins.A = aPad; pins.K = kPad;
      } else if (kind === 'battery') {
        const posPad = pads.find((p) => p.name === '+' || p.name === '1')?.name ?? pads[0].name;
        const negPad = pads.find((p) => p.name === '-' || p.name === '2')?.name ?? pads[1].name;
        pins['+'] = posPad; pins['-'] = negPad;
      } else {
        pins['1'] = pads[0].name;
        pins['2'] = pads[1].name;
      }
    } else if (pads.length === 1) {
      pins['1'] = pads[0].name;
    }

    // library-style values carry a type prefix and a package suffix: "C_100n_0402", "R_10k_0402"
    let value = parseValue(valText.replace(/^[CRL]_/i, ''));
    let guessed = false;
    const rPrefix = ref.toUpperCase();
    if (/^NT\d/.test(rPrefix)) value = 0.001; // net tie: copper
    else if (/^(FB|L)\d/.test(rPrefix)) { value = /^FB/.test(rPrefix) ? 0.05 : 0.02; guessed = true; } // DC resistance (typical), not henries / impedance
    else if (kind === 'battery' && COIN_CELL.test(`${valText} ${fpName}`)) value = 3.0;
    if (!Number.isFinite(value) || (kind === 'battery' && !(value > 0 && value < 60))) {
      guessed = true;
      if (kind === 'resistor') value = 1000;
      else if (kind === 'capacitor') value = 1e-7;
      else if (kind === 'battery') value = 5;
      else if (kind === 'fuse') value = 0.5;
      else value = 0;
    }

    const colorMatch = valText.toLowerCase().match(/\b(red|green|yellow|blue|white|orange)\b/);
    const comp: Component = {
      id: 'c' + (next++).toString(36),
      ref,
      kind,
      value,
      color: kind === 'led' ? ((colorMatch?.[1] as Component['color']) ?? 'red') : undefined,
      label: /^L\d/.test(rPrefix) ? 'Inductor' : /^FB\d/.test(rPrefix) ? 'Ferrite bead' : /^NT\d/.test(rPrefix) ? 'Net tie' : valText || undefined,
      ...(guessed && ['resistor', 'capacitor', 'fuse', 'battery'].includes(kind) && { valueGuessed: true }),
      footprint: fpName,
      at: pos,
      rot: frot,
      side,
      pads,
      pins,
      body: inferBody(kind, pads, fabBox(f), fpName),
      // "dnp" (do not populate): the footprint is on the board, the part is not fitted
      state: { populated: !attrTokens.includes('dnp'), reversed: false, burnt: false, cold: [], closed: false },
    };
    board.components.push(comp);
  }

  board.nextId = next + 1000;
  if (hidden.size) board.hiddenCopperNets = [...hidden].sort();
  if (inner.traces.length || inner.zones.length) board.inner = inner;
  const titleNode = kid(kid(root, 'title_block'), 'title');
  const title = str(titleNode, 1, 'Imported KiCad PCB');
  return { board, title };
}

export function importScenarioOrPcb(filename: string, data: string | Uint8Array): Scenario {
  if (filename.toLowerCase().endsWith('.brd') || isBrdData(data)) {
    return parseBrd(data, filename);
  }
  const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
  const trimmed = text.trim();
  if (trimmed.startsWith('(kicad_pcb') || filename.toLowerCase().endsWith('.kicad_pcb')) {
    const { board, title } = parseKicadPcb(trimmed);
    const id = 'kicad-' + Date.now().toString(36);
    // a board with a power tree gets a bench supply on its main input rail (coin cells stay RTC cells)
    let supplyNote = '';
    const choice = chooseInputRail(board);
    if (choice && !board.components.some((c) => c.kind === 'battery' && c.pads.some((p) => p.net === choice.net))) {
      if (addBenchSupply(board, choice, () => board.nextId++)) supplyNote = ` Bench supply: ${choice.volts} V on ${choice.net} (${choice.why}).`;
    }
    return {
      format: 'pcbfix/1',
      id,
      meta: {
        title: title || filename.replace(/\.kicad_pcb$/i, ''),
        author: 'KiCad Import',
        difficulty: 2,
        description: `Imported from ${filename}.${supplyNote} Probe it with the multimeter, power it up on SPICE + PWR, or plant faults in the Author tab.`,
        hints: ['Use Author Studio to lock a flag and export a .pcbfix.json challenge for others!'],
      },
      board,
      objectives: [],
    };
  }
  return parseScenario(trimmed);
}
