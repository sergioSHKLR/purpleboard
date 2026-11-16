import type { Board, Component, ComponentKind, Pad, Scenario, Side, V2 } from '../types';
import { emptyBoard } from '../scenarios/builder';

const MIL_TO_MM = 0.0254;

/**
 * Board-specific adjustments for a scenario. The generic importer knows nothing about any
 * particular board; scenarios pass quirks (e.g. simplified stand-ins for parts the game
 * solver cannot model) explicitly.
 */
export interface BrdQuirks {
  /** Per-refdes overrides applied after generic classification. */
  parts?: Record<string, Partial<Pick<Component, 'kind' | 'value' | 'pins' | 'label'>> & { bodyShape?: Component['body']['shape']; bodyZ?: number }>;
  /** Places a bench supply; return true when placed (otherwise the generic rail/GND finder runs). */
  supply?: (board: Board, nextId: () => number, components: Component[]) => boolean;
}
const MAGIC_ENC = [0x23, 0xe2, 0x63, 0x28];

const round3 = (n: number) => Math.round(n * 1000) / 1000;

function toBytes(data: Uint8Array | string): Uint8Array {
  if (data instanceof Uint8Array) return data;
  const u = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) u[i] = data.charCodeAt(i) & 0xff;
  return u;
}

/** Detects binary obfuscated or decoded TopTest/OpenBoardView `.brd` files. */
export function isBrdData(data: Uint8Array | string): boolean {
  if (typeof data === 'string') {
    const t = data.trimStart();
    if (t.startsWith('str_length:') || t.startsWith('var_data:')) return true;
    return data.length >= 4 &&
      data.charCodeAt(0) === MAGIC_ENC[0] &&
      data.charCodeAt(1) === MAGIC_ENC[1] &&
      data.charCodeAt(2) === MAGIC_ENC[2] &&
      data.charCodeAt(3) === MAGIC_ENC[3];
  }
  if (data.length >= 4 &&
    data[0] === MAGIC_ENC[0] &&
    data[1] === MAGIC_ENC[1] &&
    data[2] === MAGIC_ENC[2] &&
    data[3] === MAGIC_ENC[3]) {
    return true;
  }
  const head = new TextDecoder('latin1').decode(data.subarray(0, 64)).trimStart();
  return head.startsWith('str_length:') || head.startsWith('var_data:');
}

/** Decodes the byte-rotated bitwise-NOT `.brd` stream into plain ASCII/Latin-1 text. */
export function decodeBrdText(data: Uint8Array | string): string {
  if (typeof data === 'string') {
    const t = data.trimStart();
    if (t.startsWith('str_length:') || t.startsWith('var_data:') || t.includes('\nParts:') || t.includes('\nPins:')) {
      return data;
    }
  }
  const src = toBytes(data);
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    out[i] = (c === 0x0d || c === 0x0a || c === 0)
      ? c
      : (~(((c >> 6) & 3) | ((c << 2) & 0xfc)) & 0xff);
  }
  return new TextDecoder('latin1').decode(out);
}

interface RawPin { x: number; y: number; net?: string }

function normalizeNetName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  if (!s || s === 'NC' || s.startsWith('UNCONNECTED')) return undefined;
  return s;
}

function addBridgeSupply(
  nextId: () => number,
  components: Component[],
  netPins: Map<string, { pos: V2; side: Side }[]>,
) {
  // Generic fallback for arbitrary .brd files
  let posNet: string | undefined;
  let posPt: { pos: V2; side: Side } | undefined;
  let negPt: { pos: V2; side: Side } | undefined;
  const gndList = netPins.get('GND');
  if (gndList?.length) negPt = gndList[0];
  for (const pref of ['PPBUS', 'PP3V3', 'PP5V', '+5V', '+3V', 'VCC', 'VDD']) {
    for (const [net, list] of netPins) {
      if (net.startsWith(pref) && list.length > 0) {
        posNet = net;
        posPt = list[0];
        break;
      }
    }
    if (posPt) break;
  }
  if (posPt && negPt && posNet) {
    const volts = posNet.includes('3V') ? 3.3 : posNet.includes('5V') ? 5.0 : 8.6;
    components.push({
      id: 'c' + nextId().toString(36),
      ref: 'J_PWR',
      kind: 'battery',
      value: volts,
      label: posNet,
      at: [posPt.pos[0], posPt.pos[1]],
      rot: 0,
      side: posPt.side,
      pads: [
        { name: '1', at: [0, 0], size: [1.0, 1.0], shape: 'rect', layers: 'FB', net: posNet },
        { name: '2', at: [round3(negPt.pos[0] - posPt.pos[0]), round3(negPt.pos[1] - posPt.pos[1])], size: [1.0, 1.0], shape: 'circle', layers: 'FB', net: 'GND' },
      ],
      pins: { '+': '1', '-': '2' },
      body: { shape: 'header', w: 2.5, h: 2.5, z: 3.0 },
      state: { populated: true, reversed: false, burnt: false, cold: [] },
    });
  }
}

/** Parses an OpenBoardView/TopTest `.brd` file into an interactive `Scenario`. */
export function parseBrd(data: Uint8Array | string, filename = 'board.brd', quirks: BrdQuirks = {}): Scenario {
  const txt = decodeBrdText(data);
  const lines = txt.split(/\r?\n/);

  const outlineMils: [number, number][] = [];
  const rawParts: { ref: string; typeCode: number; endPin: number }[] = [];
  const rawPins: RawPin[] = [];
  const rawNails: { x: number; y: number; sideCode: number; net?: string }[] = [];

  let sec = '';
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (t.endsWith(':') && /^[A-Za-z_]+:$/.test(t)) {
      sec = t.slice(0, -1);
      continue;
    }
    if (sec === 'Format') {
      const cols = t.split(/\s+/);
      if (cols.length >= 2) {
        const x = Number(cols[0]), y = Number(cols[1]);
        if (Number.isFinite(x) && Number.isFinite(y)) outlineMils.push([x, y]);
      }
    } else if (sec === 'Parts') {
      const cols = t.split(/\s+/);
      if (cols.length >= 3) {
        const typeCode = Number(cols[1]) || 0;
        const endPin = Number(cols[2]) || 0;
        rawParts.push({ ref: cols[0], typeCode, endPin });
      }
    } else if (sec === 'Pins') {
      const cols = t.split(/\s+/);
      if (cols.length >= 2) {
        const x = Number(cols[0]), y = Number(cols[1]);
        const net = cols.length >= 5 ? normalizeNetName(cols[4]) : undefined;
        rawPins.push({ x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0, net });
      }
    } else if (sec === 'Nails') {
      const cols = t.split(/\s+/);
      if (cols.length >= 4) {
        const x = Number(cols[1]), y = Number(cols[2]), sideCode = Number(cols[3]);
        const net = cols.length >= 5 ? normalizeNetName(cols[4]) : undefined;
        if (Number.isFinite(x) && Number.isFinite(y)) rawNails.push({ x, y, sideCode, net });
      }
    }
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const srcPts = outlineMils.length >= 3 ? outlineMils : rawPins.map((p) => [p.x, p.y] as [number, number]);
  for (const [xm, ym] of srcPts) {
    const x = xm * MIL_TO_MM, y = ym * MIL_TO_MM;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 100; maxY = 60; }

  const margin = 2;
  const shiftX = margin - minX;
  const shiftY = margin - minY;
  const w = Math.max(20, +(maxX - minX + margin * 2).toFixed(2));
  const h = Math.max(20, +(maxY - minY + margin * 2).toFixed(2));
  const toWorld = (xm: number, ym: number): V2 => [round3(xm * MIL_TO_MM + shiftX), round3(ym * MIL_TO_MM + shiftY)];

  const board = emptyBoard(w, h);
  let next = 1;
  const nextId = () => next++;

  // Board outline silkscreen
  const cleanOutline: V2[] = [];
  for (const [xm, ym] of outlineMils) {
    const p = toWorld(xm, ym);
    const prev = cleanOutline[cleanOutline.length - 1];
    if (!prev || Math.hypot(p[0] - prev[0], p[1] - prev[1]) > 0.05) cleanOutline.push(p);
  }
  for (let i = 0; i < cleanOutline.length; i++) {
    const a = cleanOutline[i];
    const b = cleanOutline[(i + 1) % cleanOutline.length];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.05) {
      board.silk.push({ a, b, w: 0.22, side: 'F' });
      board.silk.push({ a, b, w: 0.22, side: 'B' });
    }
  }

  const netPins = new Map<string, { pos: V2; side: Side }[]>();
  let prevEnd = 0;

  for (let i = 0; i < rawParts.length; i++) {
    const { ref, typeCode, endPin } = rawParts[i];
    const start = prevEnd;
    const end = Math.min(rawPins.length, Math.max(start, endPin));
    prevEnd = end;

    if (ref === '...' || start >= end) continue;

    const side: Side = typeCode > 0 && typeCode < 8 ? 'F' : 'B';
    const worldPts: { pos: V2; net?: string }[] = [];
    let pxMin = Infinity, pyMin = Infinity, pxMax = -Infinity, pyMax = -Infinity;

    for (let k = start; k < end; k++) {
      const rp = rawPins[k];
      const pos = toWorld(rp.x, rp.y);
      worldPts.push({ pos, net: rp.net });
      if (pos[0] < pxMin) pxMin = pos[0];
      if (pos[1] < pyMin) pyMin = pos[1];
      if (pos[0] > pxMax) pxMax = pos[0];
      if (pos[1] > pyMax) pyMax = pos[1];
      if (rp.net) {
        let list = netPins.get(rp.net);
        if (!list) netPins.set(rp.net, (list = []));
        list.push({ pos, side });
      }
    }

    const cx = round3((pxMin + pxMax) * 0.5);
    const cy = round3((pyMin + pyMax) * 0.5);

    let padD: number;
    let spanW: number;
    let spanH: number;
    if (worldPts.length === 1) {
      padD = 0.42;
      spanW = 0.65;
      spanH = 0.65;
    } else if (worldPts.length === 2) {
      const rawW = pxMax - pxMin;
      const rawH = pyMax - pyMin;
      const pinSpan = Math.hypot(rawW, rawH);
      padD = round3(Math.max(0.18, Math.min(1.2, pinSpan * 0.38)));
      const perp = Math.max(0.36, Math.min(4.2, pinSpan * 0.52));
      spanW = round3(Math.max(rawW + padD * 1.15, rawW < 0.15 ? perp : 0.4));
      spanH = round3(Math.max(rawH + padD * 1.15, rawH < 0.15 ? perp : 0.4));
    } else {
      let minPinDist = Infinity;
      const stride = Math.max(1, Math.floor(worldPts.length / 160));
      const sampled: V2[] = [];
      for (let k = 0; k < worldPts.length; k += stride) sampled.push(worldPts[k].pos);
      for (let a = 0; a < sampled.length; a++) {
        for (let b = a + 1; b < sampled.length; b++) {
          const d = Math.hypot(sampled[a][0] - sampled[b][0], sampled[a][1] - sampled[b][1]);
          if (d > 0.05 && d < minPinDist) minPinDist = d;
        }
      }
      for (let k = 1; k < worldPts.length; k++) {
        const d = Math.hypot(worldPts[k].pos[0] - worldPts[k - 1].pos[0], worldPts[k].pos[1] - worldPts[k - 1].pos[1]);
        if (d > 0.05 && d < minPinDist) minPinDist = d;
      }
      if (!Number.isFinite(minPinDist)) minPinDist = 1.2;
      padD = round3(Math.max(0.16, Math.min(0.68, minPinDist * 0.56)));
      spanW = Math.max(0.8, round3((pxMax - pxMin) + padD * 1.25));
      spanH = Math.max(0.8, round3((pyMax - pyMin) + padD * 1.25));
    }

    const pads: Pad[] = worldPts.map((wp, pi) => ({
      name: String(pi + 1),
      at: [round3(wp.pos[0] - cx), round3(wp.pos[1] - cy)],
      size: [padD, padD],
      shape: pi === 0 ? 'rect' : 'circle',
      layers: side,
      net: wp.net,
    }));

    let kind: ComponentKind = 'generic';
    let value = 0;
    let pins: Record<string, string> = {};
    let bodyShape: Component['body']['shape'] = 'box';
    let bodyZ = 0.55;
    let label: string | undefined;

    // Generic classification by refdes prefix; board-specific stand-ins come from `quirks`.
    if (/^F\d/.test(ref) && pads.length >= 2) {
      kind = 'fuse';
      value = 3.0;
      pins = { '1': '1', '2': '2' };
      bodyShape = 'fuse';
      bodyZ = 0.9;
    } else if (/^R(?!P)\d/.test(ref) && pads.length >= 2) {
      kind = 'resistor';
      value = 1000;
      pins = { '1': '1', '2': '2' };
      bodyShape = 'box';
      bodyZ = 0.45;
    } else if (/^L\d/.test(ref) && pads.length >= 2) {
      kind = 'resistor';
      value = 0.05;
      pins = { '1': '1', '2': '2' };
      bodyShape = 'box';
      bodyZ = 1.4;
      label = 'Inductor';
    } else if (/^(XW|SL)\d/.test(ref)) {
      if (pads.length >= 2) {
        kind = 'resistor';
        value = 0.01;
        pins = { '1': '1', '2': '2' };
        bodyShape = 'box';
        bodyZ = 0.22;
        label = '0Ω Link';
      } else {
        kind = 'testpoint';
        pins = { '1': '1' };
        bodyShape = 'pin';
        bodyZ = 0.5;
      }
    } else if (/^D\d/.test(ref)) {
      if (pads.length === 2) {
        kind = 'diode';
        value = 0.65;
        pins = { A: '1', K: '2' };
        bodyShape = 'box';
        bodyZ = 0.65;
      } else {
        kind = 'ic';
        bodyShape = 'chip';
        bodyZ = 0.8;
      }
    } else if (/^C\d/.test(ref)) {
      kind = 'capacitor';
      value = 1e-7;
      pins = pads.length >= 2 ? { '1': '1', '2': '2' } : { '1': '1' };
      bodyShape = 'box';
      bodyZ = 0.55;
    } else if (/^TP\d/.test(ref)) {
      kind = 'testpoint';
      pins = { '1': '1' };
      bodyShape = 'pin';
      bodyZ = 0.7;
    } else if (/^[UQY]/.test(ref)) {
      kind = 'ic';
      bodyShape = 'chip';
      bodyZ = 0.95;
    } else if (/^J/.test(ref)) {
      kind = 'connector';
      bodyShape = 'box';
      bodyZ = 1.8;
    } else {
      kind = pads.length > 2 ? 'ic' : 'generic';
      bodyShape = pads.length > 2 ? 'chip' : 'box';
      bodyZ = 0.7;
    }

    const q = quirks.parts?.[ref];
    if (q) {
      if (q.kind) kind = q.kind;
      if (q.value !== undefined) value = q.value;
      if (q.pins) pins = q.pins;
      if (q.label) label = q.label;
      if (q.bodyShape) bodyShape = q.bodyShape;
      if (q.bodyZ !== undefined) bodyZ = q.bodyZ;
    }

    board.components.push({
      id: 'c' + nextId().toString(36),
      ref,
      kind,
      value,
      // a boardview carries no part values: classification defaults are placeholders
      ...(q?.value === undefined && ['resistor', 'capacitor', 'fuse', 'diode'].includes(kind) && { valueGuessed: true }),
      label,
      at: [cx, cy],
      rot: 0,
      side,
      pads,
      pins,
      body: { shape: bodyShape, w: spanW, h: spanH, z: bodyZ },
      state: { populated: true, reversed: false, burnt: false, cold: [] },
    });
  }

  // Single-sided ICT test points (Nails)
  for (const rn of rawNails) {
    board.vias.push({
      id: 'v' + nextId().toString(36),
      at: toWorld(rn.x, rn.y),
      d: 0.34,
      drill: 0.12,
      side: rn.sideCode === 1 ? 'F' : 'B',
      net: rn.net,
    });
  }

  if (!quirks.supply?.(board, nextId, board.components)) addBridgeSupply(nextId, board.components, netPins);

  // A boardview carries no copper routing, so no traces are drawn: every net connects by
  // name. The UI shows a selected part's connections as airwires (src/airwires.ts).

  board.nextId = next + 1000;
  const cleanTitle = filename.replace(/^.*[\\/]/, '').replace(/\.brd$/i, '') || 'Imported Boardview';
  return {
    format: 'pcbfix/1',
    id: 'brd-' + Date.now().toString(36),
    meta: {
      title: cleanTitle,
      author: 'Boardview (.brd)',
      difficulty: 4,
      description: `Imported ${cleanTitle} (${board.components.length} components, ${netPins.size} nets). Probe nets in Voltage map / Thermal mode or inject CTF faults in Author Studio.`,
      hints: ['Use Inspector search to locate parts on large multi-thousand-component boards.'],
    },
    board,
    objectives: [],
  };
}
