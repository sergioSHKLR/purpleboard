// Tebo-ICT (.tvw) import: a synthetic file written to the record layout (route edge, top and
// bottom copper with apertures, plated holes, a test point, the probe / fixture tables, parts with
// values and pin names), then imported. Checks sides, the y flip, real pad shapes, values, nets,
// that overlapping pads of two nets are trimmed apart, and the error for a cut-off file.
import { importScenarioOrPcb } from '../src/io/kicad';
import { buildConnectivity, type Conn } from '../src/connectivity';
import { padWorld, padShape } from '../src/model';
import { shapeGap } from '../src/geom';
import type { Board } from '../src/types';

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const near = (a: number, b: number, m: string) => assert(Math.abs(a - b) < 1e-3, `${m}: expected ${b}, got ${a}`);
const MIL = 0.0254;
const get = (b: Board, ref: string) => b.components.find((c) => c.ref === ref)!;
const pad = (b: Board, ref: string, name: string) => get(b, ref).pads.find((p) => p.name === name)!;
const at = (b: Board, ref: string, name: string) => padWorld(get(b, ref), pad(b, ref, name)).at;
const padNet = (conn: Conn, b: Board, ref: string, name: string) => { const c = get(b, ref); return conn.net[conn.padItem.get(c)![c.pads.findIndex((p) => p.name === name)]]; };

class W {
  b: number[] = [];
  u8(v: number) { this.b.push(v & 0xff); return this; }
  bool(v: boolean) { return this.u8(v ? 1 : 0); }
  u32(v: number) { const d = new DataView(new ArrayBuffer(4)); d.setUint32(0, v >>> 0, true); this.b.push(...new Uint8Array(d.buffer)); return this; }
  s32(v: number) { return this.u32(v | 0); }
  f32(v: number) { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, v, true); this.b.push(...new Uint8Array(d.buffer)); return this; }
  vec(x: number, y: number) { return this.s32(Math.round(x * 100)).s32(Math.round(y * 100)); } // mils
  str(s: string) { this.u8(s.length); for (const ch of s) this.u8(ch.charCodeAt(0)); return this; }
  zeros(n: number) { for (let i = 0; i < n; i++) this.u8(0); return this; }
  bytes() { return new Uint8Array(this.b); }
}

type Ap = { kind: 'round'; d: number } | { kind: 'rect'; w: number; h: number; turn: number };
type P = { net: number; ap: number; x: number; y: number; hole?: boolean };

function layerHead(w: W, kind: 1 | 3, name: string, type: number) {
  w.u32(kind).u32(2).u32(1).str(name).str('').str('').u32(type).u32(0xff0000).u32(0x00ff00);
}

function logicLayer(w: W, name: string, type: number, aps: Ap[], pads: P[], opts: { order2?: boolean; testPoint?: boolean; item?: boolean } = {}) {
  w.u32(0); // skipped by layer detection
  layerHead(w, 3, name, type);
  w.u32(10 + aps.length);
  for (const a of aps) {
    w.u32(1);
    if (a.kind === 'round') w.vec(a.d, a.d).u32(0).vec(0, 0);
    else w.vec(a.w, a.h).u32(1).f32(a.turn).s32(0);
  }
  w.u32(opts.order2 ? 2 : 1).u32(0).u32(1);
  w.u32(pads.length);
  if (pads.length) w.u32(2);
  for (const p of pads) {
    w.s32(p.net).u32(10 + p.ap).vec(p.x, p.y).bool(false).bool(true).u8(0);
    w.bool(false).bool(!!p.hole).u8(0);
    if (p.hole) w.zeros(7).vec(30, 30).u8(0);
  }
  w.u32(1).u32(0).s32(0).u32(10).vec(0, 0).vec(10, 10); // one track
  w.u32(0); // arcs
  w.u32(0); // pours
  if (opts.order2) { w.zeros(16); w.u32(0); w.u32(0); w.u32(0); }
  // unidentified items
  if (opts.item) { w.u32(1).u32(0).str('X').vec(1, 1).zeros(24).bool(false).bool(true).bool(false).s32(0).u32(0); }
  else w.u32(0).u32(0);
  w.u32(7);
  // test points
  if (opts.testPoint) { w.u32(1).bool(true).zeros(16).vec(5, 5).s32(0).bool(false).zeros(12); } else w.u32(0);
  w.u32(0).u32(4);
  w.u32(0).u32(0); w.u32(0).u32(0);
  w.u32(0).u32(1).u32(0).u32(0).u32(0); // empty test sequence, param 1
}

function routeLayer(w: W, slots: [number, number, number, number][]) {
  layerHead(w, 1, 'Route', 12);
  w.u32(0).u32(0).u32(2);
  w.bool(true).bool(false).u32(800).zeros(20).zeros(3); // one tool
  w.u8(0);
  w.u32(slots.length + 1).u32(0).zeros(16);
  w.u8(0x08).s32(-1).u32(1).vec(1000, 500); // a drill hole
  for (const [x1, y1, x2, y2] of slots) w.u8(0x0a).s32(-1).u32(1).vec(x1, y1).vec(x2, y2).u32(0);
}

function fixtureData(w: W) {
  w.zeros(28).bool(false).bool(false).bool(false);
  w.u32(2).bool(false).bool(true).s32(1000).zeros(20).u32(0);
  w.u32(1).u32(0).vec(0, 0).vec(1, 1).u8(1).zeros(16);
}

/** 2000 × 1000 mil board, y up. Top: R1, D1 (pads 100 mil apart, aperture 150 wide: overlapping),
 * J1 through-hole. Bottom: C1, J1's other side. */
function tvw(cut = 0) {
  const w = new W();
  w.str('TEBO').u32(1).str('cust').u8(0).str('date').zeros(3).u32(0).u32(0).u32(0).u32(3);
  routeLayer(w, [[0, 0, 2000, 0], [2000, 0, 2000, 1000], [2000, 1000, 0, 1000], [0, 1000, 0, 0]]);
  const nets = { GND: 0, P5: 1, LED: 2 };
  logicLayer(w, 'Top', 1,
    [{ kind: 'rect', w: 60, h: 40, turn: 90 }, { kind: 'rect', w: 150, h: 40, turn: 0 }, { kind: 'round', d: 60 }],
    [
      { net: nets.P5, ap: 0, x: 500, y: 700 }, { net: nets.LED, ap: 0, x: 600, y: 700 },
      { net: nets.LED, ap: 1, x: 800, y: 700 }, { net: nets.GND, ap: 1, x: 900, y: 700 },
      { net: nets.P5, ap: 2, x: 200, y: 600, hole: true }, { net: nets.GND, ap: 2, x: 200, y: 500, hole: true },
    ], { testPoint: true, item: true });
  logicLayer(w, 'Bottom', 2,
    [{ kind: 'round', d: 40 }, { kind: 'round', d: 60 }],
    [
      { net: nets.P5, ap: 0, x: 500, y: 300 }, { net: nets.GND, ap: 0, x: 600, y: 300 },
      { net: nets.P5, ap: 1, x: 200, y: 600, hole: true }, { net: nets.GND, ap: 1, x: 200, y: 500, hole: true },
    ], { order2: true });
  w.zeros(16);
  w.u32(3).u32(3).str('GND').str('+5V').str('LED_A');
  // probes: one pack with one probe that has no body
  w.u32(0).u32(0).u32(4).str('probes').u32(11811).u32(1).u32(1);
  w.bool(true).u32(15).str('Spear').zeros(24).u32(0xffff).zeros(32).bool(false);
  w.u32(0).bool(false).bool(false).bool(false).zeros(53);
  // fixtures: top with one variant, bottom empty
  w.u32(0).u32(7874);
  for (let i = 0; i < 8; i++) w.str(i ? '' : '100 mil');
  w.u32(3).str('Top').u32(0).u32(1).str('V1').str('v').bool(true).bool(false); fixtureData(w); w.vec(7874, 7874);
  w.u32(3).str('Bottom').u32(0).u32(0).vec(7874, 7874);
  // settings block
  w.zeros(24).bool(true).bool(false).zeros(18).bool(false).bool(false).bool(false).bool(false).bool(false).bool(false).zeros(18);
  // parts: pin handle = pad index × 8 in the part's layer (layer 1 = top, 2 = bottom)
  const part = (ref: string, value: string, layer: number, pins: [number, string][], serial = false) => {
    w.str(ref).zeros(36).u32(0).s32(50).bool(serial).str(value).str('').str('').str('');
    if (serial) w.str('SN').u32(0);
    w.u32(pins.length).u32(layer).u32(0);
    pins.forEach(([idx, name], i) => w.u32(idx * 8).u32(0).u32(i + 1).str(name).u32(0));
  };
  w.u32(5).u32(0);
  part('R1', '4K7', 1, [[0, '1'], [1, '2']]);
  part('D1', '', 1, [[2, 'A'], [3, 'K']], true);
  part('J1', '', 1, [[4, '1'], [5, '2']]);
  part('C1', '100nF', 2, [[0, '1'], [1, '2']]);
  part('MH1', '', 0, [[0, '1']]); // on the route layer: not a copper part, skipped
  // decals follow in a real file; the importer stops after the parts
  w.u32(3).u32(0);
  const b = w.bytes();
  return cut ? b.subarray(0, b.length - cut) : b;
}

function run() {
  const sc = importScenarioOrPcb('LAPTOP.TVW', tvw());
  const b = sc.board;
  assert(sc.meta.author === 'Boardview (TVW)' && sc.meta.title === 'LAPTOP', `credited as TVW: ${sc.meta.author} / ${sc.meta.title}`);
  for (const ref of ['R1', 'D1', 'J1', 'C1']) assert(get(b, ref), `${ref} imported`);
  assert(!get(b, 'MH1'), 'part on a non-copper layer skipped');

  // sides and layers
  assert(get(b, 'R1').side === 'F' && get(b, 'C1').side === 'B', 'R1 on top, C1 on the bottom');
  assert(get(b, 'C1').pads.every((p) => p.layers === 'B') && get(b, 'R1').pads.every((p) => p.layers === 'F'), 'SMD pads on their own side');
  assert(get(b, 'J1').pads.every((p) => p.layers === 'FB'), 'plated holes reach both sides');

  // y is up in the file: R1 (y 700) sits above C1 (y 300), so 400 mil less in board y
  near(at(b, 'C1', '1')[1] - at(b, 'R1', '1')[1], 400 * MIL, 'y flipped, both sides in one frame');
  near(at(b, 'C1', '1')[0], at(b, 'R1', '1')[0], 'C1 lines up with R1 in x');

  // the edge from the route layer
  const xs = b.silk.flatMap((s) => [s.a[0], s.b[0]]);
  near(Math.max(...xs) - Math.min(...xs), 2000 * MIL, 'board edge from the route slots');

  // real pads: R1's 60 × 40 mil rectangle turned 90°, J1's 60 mil round
  const r1 = pad(b, 'R1', '1');
  assert(r1.shape === 'rect' && Math.abs(r1.size[0] - 60 * MIL) < 2e-3 && Math.abs(r1.size[1] - 40 * MIL) < 2e-3, `R1 pad size ${r1.size}`);
  assert(Math.abs(Math.abs(r1.rot ?? 0) - 90) < 1e-6, `R1 pad turned 90°: ${r1.rot}`);
  assert(pad(b, 'J1', '1').shape === 'circle', 'J1 round pads');

  // pin names and values
  assert(pad(b, 'D1', 'A') && pad(b, 'D1', 'K') && get(b, 'D1').pins.A === 'A' && get(b, 'D1').pins.K === 'K', 'diode pins keep their names');
  assert(get(b, 'R1').value === 4700 && !get(b, 'R1').valueGuessed, `R1 value read from the file: ${get(b, 'R1').value}`);
  assert(Math.abs(get(b, 'C1').value - 1e-7) < 1e-12 && !get(b, 'C1').valueGuessed, `C1 value: ${get(b, 'C1').value}`);
  assert(get(b, 'D1').valueGuessed, 'no value in the file: still a guess');

  // D1's pads (150 mil wide, 100 mil apart) would touch: trimmed apart, nets stay separate
  const d1 = get(b, 'D1');
  assert(shapeGap(padShape(d1, d1.pads[0]), padShape(d1, d1.pads[1])) > 0, 'overlapping pads of two nets trimmed');
  const conn = buildConnectivity(b);
  assert(padNet(conn, b, 'D1', 'A') !== padNet(conn, b, 'D1', 'K'), 'D1 not shorted by its own pads');
  const p5 = padNet(conn, b, 'R1', '1');
  assert(p5 === padNet(conn, b, 'C1', '1') && p5 === padNet(conn, b, 'J1', '1'), '+5V joins R1, C1 and J1');
  assert(padNet(conn, b, 'D1', 'K') === padNet(conn, b, 'C1', '2') && padNet(conn, b, 'C1', '2') !== p5, 'GND apart from +5V');

  // a bench supply on +5V
  assert(b.components.some((c) => c.kind === 'battery' && c.pads.some((p) => p.net === '+5V')), 'bench supply placed');

  // cut-off file: a clear error
  let msg = '';
  try { importScenarioOrPcb('cut.tvw', tvw(40)); } catch (e) { msg = String(e); }
  assert(/Unsupported \.tvw file: the file ends early/.test(msg), `cut-off file rejected: ${msg || 'imported'}`);
  // anything else named .tvw
  msg = '';
  try { importScenarioOrPcb('notes.tvw', new TextEncoder().encode('hello, this is not a boardview at all, just text')); } catch (e) { msg = String(e); }
  assert(/Unsupported \.tvw file/.test(msg), `junk rejected: ${msg || 'imported'}`);

  console.log('TVW TESTS PASSED (route edge, sides + y flip, real pad shapes, plated holes, pin names, values, trimmed overlaps, nets, errors)');
}

run();
