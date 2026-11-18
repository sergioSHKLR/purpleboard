// Tebo-ICT boardview (.tvw) import.
//
// The record layout follows the reverse-engineered reader in nitrocaster/eagleview
// (src/TeboBoard.cpp, MIT License, Copyright (c) 2019-2020 Pavel Kovalenko). Like eagleview, this
// walks the file front to back (layers, net list, probe and fixture tables) to reach the part
// list; anything that does not match the known layout stops the import with a clear error.
//
// What a TVW gives us: the net names, every part on the top / bottom copper layer with its pins,
// each pin's pad (position, shape, size, rotation, net, plated hole) and the printed part value;
// the route layer's slots are the board edge. Coordinates are hundredths of a mil, y up, both
// sides in one frame (CAM data seen from the top), so y is negated and nothing else is flipped.
import type { PadShape, Scenario, Side } from '../types';
import { buildBoardview, type RawBoard, type RawPart, type RawPin } from './brd';

const UNIT = 0.01; // file unit → mil

class TvwError extends Error {}

class Reader {
  p = 0;
  private dv: DataView;
  constructor(private u: Uint8Array) { this.dv = new DataView(u.buffer, u.byteOffset, u.byteLength); }
  fail(what: string): never {
    throw new TvwError(`Unsupported .tvw file: ${what} at byte 0x${this.p.toString(16)}. This Tebo-ICT version is not supported yet.`);
  }
  private need(n: number) { if (this.p + n > this.u.length) this.fail('the file ends early'); }
  expect(ok: boolean, what: string) { if (!ok) this.fail(what); }
  u8() { this.need(1); return this.u[this.p++]; }
  bool() { const v = this.u8(); if (v > 1) this.fail(`flag byte ${v}`); return v === 1; }
  u32() { this.need(4); const v = this.dv.getUint32(this.p, true); this.p += 4; return v; }
  s32() { this.need(4); const v = this.dv.getInt32(this.p, true); this.p += 4; return v; }
  f32() { this.need(4); const v = this.dv.getFloat32(this.p, true); this.p += 4; return v; }
  /** A point in mils. */
  vec(): [number, number] { return [this.s32() * UNIT, this.s32() * UNIT]; }
  str() { const n = this.u8(); this.need(n); const s = new TextDecoder('latin1').decode(this.u.subarray(this.p, this.p + n)); this.p += n; return s; }
  skip(n: number) { this.need(n); this.p += n; }
  /** A count that must fit in what is left of the file at `minSize` bytes per entry. */
  count(minSize: number, what: string) {
    const n = this.u32();
    if (n * minSize > this.u.length - this.p) this.fail(`${what} count ${n}`);
    return n;
  }
}

interface Shape { shape: PadShape; w: number; h: number; rot: number }
interface TvwPad { net: number; shape: Shape; x: number; y: number; hole: boolean }
interface Layer { kind: 'logic' | 'through'; type: number; name: string; pads: TvwPad[]; slots: [number, number, number, number][] }

// layer types
const TOP = 1, BOTTOM = 2, ROUTE = 12;

function readShape(r: Reader): Shape {
  r.expect(r.u32() === 1, 'pad shape header');
  const [w, h] = r.vec();
  const type = r.u32();
  switch (type) {
    case 0: r.skip(8); return { shape: 'circle', w, h: w, rot: 0 };
    case 1: { const rot = r.f32(); r.skip(4); return { shape: 'rect', w, h, rot }; }
    case 3: { const rot = r.f32(); r.skip(4); return { shape: 'roundrect', w, h, rot }; }
    case 5: {
      r.skip(4);
      r.str();
      const [x0, y0] = r.vec(), [x1, y1] = r.vec();
      const subs = r.count(4, 'polygon part');
      for (let i = 0; i < subs; i++) {
        const t = r.u32();
        if (t === 2) { r.skip(12); r.skip(r.count(8, 'polygon vertex') * 8); }
        else if (t === 5) { r.expect(r.u32() === 1 && r.u32() === 0 && r.u32() === 0, 'polygon line'); r.skip(20); }
        else r.fail(`polygon part type ${t}`);
      }
      // a custom pad: its bounding box, as a rectangle
      return { shape: 'rect', w: w || Math.abs(x1 - x0), h: h || Math.abs(y1 - y0), rot: 0 };
    }
    default: return r.fail(`pad shape type ${type}`);
  }
}

function readLogicLayer(r: Reader, head: Omit<Layer, 'kind' | 'pads' | 'slots'>): Layer {
  const layer: Layer = { ...head, kind: 'logic', pads: [], slots: [] };
  const shapes: Shape[] = [];
  const maxDcode = r.u32();
  if (maxDcode) {
    r.expect(maxDcode >= 10, 'aperture count');
    for (let i = 0; i < maxDcode - 10; i++) shapes.push(readShape(r));
  }
  if (shapes.length) {
    const order = r.u32();
    r.expect(order === 1 || order === 2, `data order ${order}`);
    r.expect(r.u32() === 0 && r.u32() === 1, 'layer data header');
    // pads
    const nPads = r.count(15, 'pad');
    if (nPads) {
      r.expect(r.u32() === 2, 'pad table header');
      for (let i = 0; i < nPads; i++) {
        const net = r.s32(), dcode = r.u32();
        const [x, y] = r.vec();
        const exposed = r.bool(), copper = r.bool(), tp = r.u8();
        const shape = shapes[dcode - 10];
        if (!shape) r.fail(`pad aperture D${dcode}`);
        let hole = false;
        if (copper) {
          const something = r.bool();
          if (tp === 1) r.skip(12);
          if (exposed || something) r.skip(16);
          hole = r.bool();
          r.u8();
          if (hole) r.skip(7 + 8 + 1);
        } else r.expect(!exposed && tp !== 1, 'non-copper pad');
        layer.pads.push({ net, shape, x, y, hole });
      }
    }
    const lines = () => { const n = r.count(24, 'track'); if (n) { r.expect(r.u32() === 0, 'track table header'); r.skip(n * 24); } };
    const arcs = () => { const n = r.count(28, 'arc'); if (n) { r.expect(r.u32() === 0, 'arc table header'); r.skip(n * 28); } };
    lines();
    arcs();
    // copper pours
    const nSurf = r.count(12, 'pour');
    if (nSurf) {
      r.expect(r.u32() === 2, 'pour table header');
      for (let i = 0; i < nSurf; i++) {
        r.s32();
        r.skip(r.count(8, 'pour vertex') * 8);
        r.s32();
        const voids = r.count(8, 'pour cut-out');
        if (voids) {
          for (let v = 0; v < voids; v++) { r.expect(r.u32() <= 1, 'cut-out tag'); r.skip(r.count(8, 'cut-out vertex') * 8); }
          r.u32();
        }
      }
    }
    if (order === 2) {
      r.skip(16);
      lines();
      arcs();
      r.expect(r.u32() === 0, 'second track table end');
    }
  }
  // unidentified named items
  const nItems = r.count(40, 'item');
  r.u32();
  if (nItems) {
    for (let i = 0; i < nItems; i++) { r.str(); r.skip(8 + 24); for (let k = 0; k < 3; k++) r.bool(); r.skip(4); }
    r.expect(r.u32() === 0, 'item table end');
  }
  r.expect(r.u32() === 7, 'item table end');
  // test points and test sequence
  const nTp = r.count(42, 'test point');
  r.skip(nTp * 42);
  r.expect(r.u32() === 0 && r.u32() === 4, 'test point table end');
  for (let t = 0; t < 2; t++) { const n = r.count(54, 'test point'); r.u32(); r.skip(n * 54); }
  const nSeq = r.count(9, 'test step'), seqParam = r.u32();
  r.skip(nSeq * 9);
  if (seqParam === 1) r.expect(r.u32() === 0 && r.u32() === 0 && r.u32() === 0, 'test sequence end');
  return layer;
}

function readThroughLayer(r: Reader, head: Omit<Layer, 'kind' | 'pads' | 'slots'>): Layer {
  const layer: Layer = { ...head, kind: 'through', pads: [], slots: [] };
  r.expect(r.u32() === 0 && r.u32() === 0, 'drill layer header');
  const tools = r.u32();
  r.expect(tools >= 1, 'drill tool count');
  r.skip((tools - 1) * 29);
  r.expect(r.u8() === 0, 'drill tool table end');
  const n = r.count(17, 'drill');
  r.u32();
  for (let i = 0; i < 4; i++) r.expect(r.u32() === 0, 'drill table header');
  for (let i = 0; i < n; i++) {
    const code = r.u8();
    if (code === 0x08) r.skip(16);
    else if (code === 0x0a || code === 0x0b) {
      r.s32(); r.u32();
      const [x1, y1] = r.vec(), [x2, y2] = r.vec();
      r.u32();
      layer.slots.push([x1, y1, x2, y2]);
    } else r.fail(`drill code ${code}`);
  }
  return layer;
}

function readLayer(r: Reader): Layer {
  let type = 0;
  for (let i = 0; i < 4 && !type; i++) type = r.u32();
  r.expect(type === 1 || type === 3, `layer kind ${type}`);
  r.expect(r.u32() === 2 && r.u32() === 1, 'layer header');
  const name = r.str();
  r.str(); r.str();
  const head = { name, type: r.u32() };
  r.skip(8); // colours
  return type === 3 ? readLogicLayer(r, head) : readThroughLayer(r, head);
}

function readFixtureData(r: Reader) {
  r.skip(4 + 24);
  for (let i = 0; i < 3; i++) r.bool();
  const items = r.count(1, 'probe size');
  r.expect(items > 0, 'probe size table');
  for (let i = 0; i < items; i++) if (r.bool()) r.skip(28);
  const boxes = r.count(17, 'probe box');
  r.skip(4 + 16 + boxes * 17);
}

function readProbes(r: Reader) {
  r.expect(r.u32() === 0 && r.u32() === 0 && r.u32() === 4, 'probe table header');
  r.str();
  r.u32();
  const packs = r.count(4, 'probe pack');
  r.expect(packs > 0, 'probe pack table');
  for (let p = 0; p < packs; p++) {
    const probes = r.count(60, 'probe');
    for (let i = 0; i < probes; i++) {
      r.bool(); r.u32(); r.str();
      r.skip(6 * 4 + 4 + 8 * 4);
      if (r.bool()) {
        readFixtureData(r);
        r.skip(16);
        r.skip(r.count(44, 'probe box') * 44);
      }
      r.u32();
      for (let k = 0; k < 3; k++) r.bool();
      r.skip(1 + 12 + 40);
    }
  }
}

function readFixtures(r: Reader) {
  r.expect(r.u32() === 0 && r.u32() === 7874, 'fixture table header');
  for (let i = 0; i < 8; i++) r.str();
  for (let side = 0; side < 2; side++) {
    r.expect(r.u32() === 3, 'fixture header');
    r.str();
    r.expect(r.u32() === 0, 'fixture header');
    const variants = r.count(4, 'fixture variant');
    for (let i = 0; i < variants; i++) { r.str(); r.str(); r.bool(); r.bool(); readFixtureData(r); }
    r.skip(8);
  }
}

function readSettings(r: Reader) {
  r.skip(8 + 8 + 8);
  r.bool(); r.bool();
  r.skip(2 + 16);
  for (let i = 0; i < 6; i++) r.bool();
  r.skip(16 + 2);
}

interface TvwPart { ref: string; value: string; layer: number; pins: { handle: number; name: string }[] }

function readPart(r: Reader): TvwPart {
  const ref = r.str();
  r.skip(16 + 8 + 4 + 4 + 4);
  r.expect(r.u32() === 0, `part ${ref}`);
  r.s32();
  const serial = r.bool();
  const value = r.str();
  r.str(); r.str(); r.str();
  if (serial) { r.str(); r.expect(r.u32() === 0, `part ${ref}`); }
  const nPins = r.count(13, 'pin');
  const layer = r.u32();
  r.expect(r.u32() === 0, `part ${ref}`);
  const pins = [];
  for (let i = 0; i < nPins; i++) {
    const handle = r.u32();
    r.expect(r.u32() === 0, `pin of ${ref}`);
    r.u32();
    const name = r.str();
    r.expect(r.u32() === 0, `pin of ${ref}`);
    pins.push({ handle, name });
  }
  return { ref, value, layer, pins };
}

/** The parts, pins, nets and edge of a `.tvw` file, in mils with both sides in one frame. */
export function readTvw(data: Uint8Array): RawBoard {
  const r = new Reader(data);
  // header: three obfuscated strings, constants and the layer count
  r.str(); r.u32(); r.str(); r.u8(); r.str(); r.skip(3); r.skip(12);
  const nLayers = r.u32();
  r.expect(nLayers > 0 && nLayers <= 256, `layer count ${nLayers}`);
  const layers: Layer[] = [];
  for (let i = 0; i < nLayers; i++) layers.push(readLayer(r));
  for (let i = 0; i < 4; i++) r.expect(r.u32() === 0, 'net list header');

  const nNets = r.count(1, 'net');
  r.expect(nNets > 0 && r.u32() === nNets, 'net list header');
  const nets: string[] = [];
  for (let i = 0; i < nNets; i++) nets.push(r.str());

  readProbes(r);
  readFixtures(r);
  readSettings(r);

  const nParts = r.count(40, 'part');
  r.u32();
  const tvwParts: TvwPart[] = [];
  for (let i = 0; i < nParts; i++) tvwParts.push(readPart(r));

  const top = layers.findIndex((l) => l.kind === 'logic' && l.type === TOP);
  const bottom = layers.findIndex((l) => l.kind === 'logic' && l.type === BOTTOM);
  const netName = (i: number) => {
    const s = nets[i]?.trim();
    return s && s !== 'NC' && !s.startsWith('UNCONNECTED') ? s : undefined;
  };

  const parts: RawPart[] = [];
  for (const tp of tvwParts) {
    if (tp.layer !== top && tp.layer !== bottom) continue;
    const side: Side = tp.layer === top ? 'F' : 'B';
    const pads = layers[tp.layer].pads;
    const pins = tp.pins.flatMap((pin): RawPin[] => {
      const pad = pads[pin.handle >>> 3];
      if (!pad) return [];
      const { shape, w, h, rot } = pad.shape;
      return [{
        x: pad.x, y: -pad.y, net: netName(pad.net), name: pin.name,
        // y is flipped, so a rotation turns the other way
        pad: { shape, w, h, rot: rot ? -rot : 0 },
        layers: pad.hole ? 'FB' : side,
      }];
    });
    if (!pins.length) continue;
    parts.push({ ref: tp.ref, side, tht: pins.every((p) => p.layers === 'FB'), pins, value: tp.value || undefined });
  }
  const route = layers.find((l) => l.kind === 'through' && l.type === ROUTE);
  const edges = route?.slots.map(([x1, y1, x2, y2]) => [x1, -y1, x2, -y2] as [number, number, number, number]);
  return { outline: [], edges, parts, nails: [] };
}

/** Parses a Tebo-ICT `.tvw` boardview into an interactive `Scenario`. */
export function parseTvw(data: Uint8Array, filename = 'board.tvw'): Scenario {
  const raw = readTvw(data);
  if (!raw.parts.length) throw new Error('Unrecognised .tvw file: no parts on the top or bottom layer.');
  return buildBoardview(raw, filename.replace(/^.*[\\/]/, '').replace(/\.tvw$/i, ''), 'Boardview (TVW)');
}
