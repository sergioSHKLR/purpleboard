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

const hasMagic = (u: Uint8Array) => u.length >= 4 && MAGIC_ENC.every((m, i) => u[i] === m);

/** Detects `.brd` boardviews: obfuscated or plain TopTest/OpenBoardView, and BRD2. */
export function isBrdData(data: Uint8Array | string): boolean {
  const u = toBytes(typeof data === 'string' ? data.slice(0, 4096) : data.subarray(0, 4096));
  if (hasMagic(u)) return true;
  const head = new TextDecoder('latin1').decode(u);
  const t = head.trimStart();
  return t.startsWith('str_length:') || t.startsWith('var_data:') || (head.includes('BRDOUT:') && head.includes('NETS:'));
}

/** Text of a `.brd` file: the byte-rotated bitwise-NOT stream is decoded only when it carries the
 * obfuscation signature; plain-text files (TopTest written out by a viewer, BRD2) pass through. */
export function decodeBrdText(data: Uint8Array | string): string {
  const src = toBytes(data);
  if (!hasMagic(src)) return typeof data === 'string' ? data : new TextDecoder('latin1').decode(src);
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
/** One part with its pins, in file units (mils), with both board sides in one frame. */
interface RawPart { ref: string; side: Side; tht: boolean; pins: RawPin[]; box?: [number, number, number, number] }
interface RawNail { x: number; y: number; side: Side; net?: string }
interface RawBoard { outline: [number, number][]; parts: RawPart[]; nails: RawNail[] }

const SECTION = /^([A-Za-z_]+):/;
const cols = (t: string) => t.split(/\s+/);
const num = (v: string | undefined) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };

/** TopTest / OpenBoardView `.brd`: `Format:` outline, `Parts:` (ref, type/side, end-of-pins), `Pins:`, `Nails:`. */
function readTopTest(lines: string[]): RawBoard {
  const outline: [number, number][] = [];
  const rawParts: { ref: string; typeCode: number; endPin: number }[] = [];
  const rawPins: RawPin[] = [];
  const nails: RawNail[] = [];
  let sec = '';
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t.endsWith(':') && /^[A-Za-z_]+:$/.test(t)) { sec = t.slice(0, -1); continue; }
    const c = cols(t);
    if (sec === 'Format') {
      const x = num(c[0]), y = num(c[1]);
      if (c.length >= 2 && !isNaN(x) && !isNaN(y)) outline.push([x, y]);
    } else if (sec === 'Parts') {
      if (c.length >= 3) rawParts.push({ ref: c[0], typeCode: Number(c[1]) || 0, endPin: Number(c[2]) || 0 });
    } else if (sec === 'Pins') {
      if (c.length >= 2) {
        const x = num(c[0]), y = num(c[1]);
        rawPins.push({ x: isNaN(x) ? 0 : x, y: isNaN(y) ? 0 : y, net: c.length >= 5 ? normalizeNetName(c[4]) : undefined });
      }
    } else if (sec === 'Nails') {
      const x = num(c[1]), y = num(c[2]);
      if (c.length >= 4 && !isNaN(x) && !isNaN(y)) nails.push({ x, y, side: Number(c[3]) === 1 ? 'F' : 'B', net: c.length >= 5 ? normalizeNetName(c[4]) : undefined });
    }
  }
  // each part's third column is the running pin count at its last pin
  const parts: RawPart[] = [];
  let prevEnd = 0;
  for (const { ref, typeCode, endPin } of rawParts) {
    const start = prevEnd, end = Math.min(rawPins.length, Math.max(start, endPin));
    prevEnd = end;
    if (ref === '...' || start >= end) continue;
    parts.push({ ref, side: typeCode > 0 && typeCode < 8 ? 'F' : 'B', tht: false, pins: rawPins.slice(start, end) });
  }
  return { outline, parts, nails };
}

/**
 * BRD2 (OpenBoardView's BRD2File): `BRDOUT: n maxX maxY` + outline points, `NETS: n` (id name),
 * `PARTS: n` (name x1 y1 x2 y2 firstPin side), `PINS: n` (x y netId side), `NAILS: n`
 * (probe x y netId side). Side 1 = top, 2 = bottom, anything else = both. A part's pins run from
 * its 0-based first-pin index to the next part's. Bottom-side items are stored mirrored about
 * the board's height and are flipped back (y → maxY − y) so both sides share one frame.
 */
function readBrd2(lines: string[]): RawBoard {
  const outline: [number, number][] = [];
  const nets = new Map<number, string | undefined>();
  const parts: { ref: string; side: number; first: number; box: [number, number, number, number] }[] = [];
  const pins: (RawPin & { side: number })[] = [];
  const nailsRaw: { x: number; y: number; side: number; net?: string }[] = [];
  const declared: Record<string, number> = {};
  let maxX = 0, maxY = 0, netLines = 0;
  let sec = '';
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const m = SECTION.exec(t);
    if (m && ['BRDOUT', 'NETS', 'PARTS', 'PINS', 'NAILS'].includes(m[1].toUpperCase())) {
      sec = m[1].toUpperCase();
      const h = cols(t.slice(m[0].length).trim());
      declared[sec] = num(h[0]);
      if (sec === 'BRDOUT') { maxX = num(h[1]) || 0; maxY = num(h[2]) || 0; }
      continue;
    }
    const c = cols(t);
    if (sec === 'BRDOUT') {
      const x = num(c[0]), y = num(c[1]);
      if (isNaN(x) || isNaN(y)) continue;
      outline.push([x, y]);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    } else if (sec === 'NETS') {
      const id = num(c[0]);
      if (!isNaN(id)) { nets.set(id, normalizeNetName(c.slice(1).join(' '))); netLines++; }
    } else if (sec === 'PARTS') {
      if (c.length < 7) continue;
      parts.push({ ref: c[0], box: [num(c[1]), num(c[2]), num(c[3]), num(c[4])], first: num(c[5]) || 0, side: num(c[6]) });
    } else if (sec === 'PINS') {
      if (c.length < 4) continue;
      pins.push({ x: num(c[0]) || 0, y: num(c[1]) || 0, net: nets.get(num(c[2])), side: num(c[3]) });
    } else if (sec === 'NAILS') {
      if (c.length < 5) continue;
      nailsRaw.push({ x: num(c[1]) || 0, y: num(c[2]) || 0, net: nets.get(num(c[3])), side: num(c[4]) });
    }
  }
  const counts: [string, number][] = [['NETS', netLines], ['PARTS', parts.length], ['PINS', pins.length], ['NAILS', nailsRaw.length]];
  for (const [k, n] of counts) {
    if (Number.isFinite(declared[k]) && declared[k] !== n) throw new Error(`BRD2 file is incomplete: ${k} declares ${declared[k]} entries, found ${n}`);
  }

  const out: RawPart[] = [];
  parts.forEach((p, i) => {
    const end = i + 1 < parts.length ? parts[i + 1].first : pins.length;
    const own = pins.slice(Math.max(0, p.first), Math.min(pins.length, end));
    if (!own.length || p.ref === '...') return;
    const side: Side = p.side === 2 ? 'B' : 'F';
    // a part none of whose pins sit on its own side is through-hole: its pins reach both sides
    const tht = p.side !== 1 && p.side !== 2 ? true : !own.some((q) => q.side === p.side);
    const box: [number, number, number, number] | undefined = p.box.every((v) => !isNaN(v))
      ? (p.side === 2 ? [p.box[0], maxY - p.box[1], p.box[2], maxY - p.box[3]] : p.box) : undefined;
    out.push({ ref: p.ref, side, tht, box, pins: own.map((q) => ({ x: q.x, y: q.side === 1 ? q.y : maxY - q.y, net: q.net })) });
  });
  const nails: RawNail[] = nailsRaw.map((n) => ({ x: n.x, y: n.side === 1 ? n.y : maxY - n.y, side: n.side === 1 ? 'F' : 'B', net: n.net }));
  return { outline, parts: out, nails };
}

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
        // clip points smaller than the pins they sit on, on the pin's own side: a wider clip would
        // reach neighbouring pins, and connectivity treats touching copper as joined
        { name: '1', at: [0, 0], size: [0.2, 0.2], shape: 'circle', layers: posPt.side, net: posNet },
        { name: '2', at: [round3(negPt.pos[0] - posPt.pos[0]), round3(negPt.pos[1] - posPt.pos[1])], size: [0.2, 0.2], shape: 'circle', layers: negPt.side, net: 'GND' },
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
  const brd2 = txt.includes('BRDOUT:') && txt.includes('NETS:');
  const raw = brd2 ? readBrd2(lines) : readTopTest(lines);
  if (!raw.parts.length) {
    throw new Error('Unrecognised .brd file: no parts or pins found. Supported boardviews: TopTest / OpenBoardView .brd and BRD2.');
  }
  const outlineMils = raw.outline;
  const allPins = raw.parts.flatMap((p) => p.pins);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const srcPts = outlineMils.length >= 3 ? outlineMils : allPins.map((p) => [p.x, p.y] as [number, number]);
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
  for (const part of raw.parts) {
    const { ref, side } = part;
    const worldPts: { pos: V2; net?: string }[] = [];
    let pxMin = Infinity, pyMin = Infinity, pxMax = -Infinity, pyMax = -Infinity;

    for (const rp of part.pins) {
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

    if (part.box) {
      spanW = Math.max(spanW, round3(Math.abs(part.box[2] - part.box[0]) * MIL_TO_MM));
      spanH = Math.max(spanH, round3(Math.abs(part.box[3] - part.box[1]) * MIL_TO_MM));
    }

    const pads: Pad[] = worldPts.map((wp, pi) => ({
      name: String(pi + 1),
      at: [round3(wp.pos[0] - cx), round3(wp.pos[1] - cy)],
      size: [padD, padD],
      shape: pi === 0 ? 'rect' : 'circle',
      layers: part.tht ? 'FB' : side,
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
  for (const rn of raw.nails) {
    board.vias.push({
      id: 'v' + nextId().toString(36),
      at: toWorld(rn.x, rn.y),
      d: 0.34,
      drill: 0.12,
      side: rn.side,
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
      author: brd2 ? 'Boardview (BRD2)' : 'Boardview (.brd)',
      difficulty: 4,
      description: `Imported ${cleanTitle} (${board.components.length} components, ${netPins.size} nets). Probe nets in Voltage map / Thermal mode or inject CTF faults in Author Studio.`,
      hints: ['Use Inspector search to locate parts on large multi-thousand-component boards.'],
    },
    board,
    objectives: [],
  };
}
