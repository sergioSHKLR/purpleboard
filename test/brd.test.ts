// Boardview (.brd) import: BRD2 (sections, pin ranges, bottom-side flip, through-hole parts,
// nails, declared counts), plain-text TopTest delivered as bytes, and an explicit error for
// files that are no boardview we know. Synthetic files.
import { importScenarioOrPcb } from '../src/io/kicad';
import { buildConnectivity, type Conn } from '../src/connectivity';
import { padWorld } from '../src/model';
import type { Board } from '../src/types';

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const near = (a: number, b: number, m: string) => assert(Math.abs(a - b) < 1e-3, `${m}: expected ${b}, got ${a}`);
const bytes = (s: string) => new TextEncoder().encode(s);
const get = (b: Board, ref: string) => b.components.find((c) => c.ref === ref)!;
const padAt = (b: Board, ref: string, name: string) => { const c = get(b, ref); return padWorld(c, c.pads.find((p) => p.name === name)!).at; };
const MIL = 0.0254;
/** Connectivity net of a pad by its name (connectors carry no pin roles for pinNet). */
const padNet = (conn: Conn, b: Board, ref: string, name: string) => { const c = get(b, ref); return conn.net[conn.padItem.get(c)![c.pads.findIndex((p) => p.name === name)]]; };

// 2000 × 1000 mil board. Real (board-frame) positions:
//   R1 top    (500,300)–(600,300)   +5V / LED_A
//   D1 top    (800,300)–(900,300)   LED_A / GND
//   C1 bottom (500,700)–(600,700)   +5V / GND     → stored mirrored: y = 1000 − 700 = 300
//   J1 through-hole, pins listed on the bottom: (200,400), (200,500) → stored y 600, 500
//   nail 1 bottom at (550,700) → stored y 300; nail 2 top at (850,300)
const brd2 = (pinsDeclared = 8) => `BRDOUT: 4 2000 1000
0 0
2000 0
2000 1000
0 1000

NETS: 3
1 GND
2 +5V
3 LED_A

PARTS: 4
R1 480 280 620 320 0 1
D1 780 280 920 320 2 1
C1 480 280 620 320 4 2
J1 150 350 250 650 6 1

PINS: ${pinsDeclared}
500 300 2 1
600 300 3 1
800 300 3 1
900 300 1 1
500 300 2 2
600 300 1 2
200 600 2 2
200 500 1 2

NAILS: 2
1 550 300 1 2
2 850 300 3 1
`;

function run() {
  // ---- BRD2 from the Import button (bytes) ----
  {
    // as found in the wild: a numeric line before BRDOUT:, CRLF line endings, upper-case extension
    const sc = importScenarioOrPcb('LSM613P-R10.BRD', bytes('0\r\n' + brd2().replace(/\n/g, '\r\n')));
    const b = sc.board;
    for (const ref of ['R1', 'D1', 'C1', 'J1']) assert(get(b, ref), `${ref} imported`);
    assert(sc.meta.author === 'Boardview (BRD2)', `credited as BRD2: ${sc.meta.author}`);

    // sides and layers
    assert(get(b, 'R1').side === 'F' && get(b, 'R1').pads.every((p) => p.layers === 'F'), 'R1 is a top SMD part');
    assert(get(b, 'C1').side === 'B' && get(b, 'C1').pads.every((p) => p.layers === 'B'), 'C1 is a bottom SMD part');
    assert(get(b, 'J1').pads.every((p) => p.layers === 'FB'), 'J1, a top part whose pins are all on the bottom, is through-hole');

    // nets by id
    assert(get(b, 'R1').pads[0].net === '+5V' && get(b, 'R1').pads[1].net === 'LED_A', 'R1 nets from the NETS table');
    assert(get(b, 'C1').pads[1].net === 'GND', 'C1.2 on GND');

    // both sides in one frame: C1 sits 400 mil from R1 in y, at the same x (not stacked on it)
    const r1 = padAt(b, 'R1', '1'), c1 = padAt(b, 'C1', '1');
    near(c1[0], r1[0], 'C1.1 x lines up with R1.1');
    near(c1[1] - r1[1], 400 * MIL, 'bottom pins flipped back (y → maxY − y)');
    const j1a = padAt(b, 'J1', '1'), j1b = padAt(b, 'J1', '2');
    near(j1a[1] - r1[1], 100 * MIL, 'through-hole pin listed on the bottom flipped too');
    near(j1b[1] - j1a[1], 100 * MIL, 'J1 pin pitch kept');

    // nails: bottom one flipped onto C1's row, top one where it was
    const bot = b.vias.find((v) => v.side === 'B')!, top = b.vias.find((v) => v.side === 'F')!;
    assert(bot && top, 'both nails imported as single-sided test points');
    near(bot.at[1], c1[1], 'bottom nail on C1\'s row');
    near(bot.at[0] - r1[0], 50 * MIL, 'bottom nail between C1\'s pins');
    near(top.at[1], r1[1], 'top nail stays on the top row');
    assert(bot.net === 'GND' && top.net === 'LED_A', 'nail nets');

    // body sized from the part outline
    assert(get(b, 'J1').body.h >= 300 * MIL - 1e-3, `J1 body from its outline box: ${get(b, 'J1').body.h}`);

    // one +5V net across top, bottom and through-hole parts
    const conn = buildConnectivity(b);
    const p5 = padNet(conn, b, 'R1', '1');
    assert(p5 === padNet(conn, b, 'C1', '1') && p5 === padNet(conn, b, 'J1', '1'), '+5V joins R1, C1 and J1');
    assert(padNet(conn, b, 'D1', '2') === padNet(conn, b, 'C1', '2') && padNet(conn, b, 'C1', '2') !== p5, 'GND joins D1 and C1, apart from +5V');
  }

  // ---- detected by content even without a .brd name ----
  assert(importScenarioOrPcb('board.bv', bytes(brd2())).board.components.some((c) => c.ref === 'C1'), 'BRD2 detected by its sections');

  // ---- a BRD2 that lost lines says so ----
  {
    let msg = '';
    try { importScenarioOrPcb('cut.brd', bytes(brd2(9))); } catch (e) { msg = String(e); }
    assert(/PINS declares 9 entries, found 8/.test(msg), `truncated BRD2 is an error: ${msg}`);
  }

  // ---- plain-text TopTest as bytes: not run through the de-obfuscation ----
  {
    const tt = `str_length: 0
var_data: 4 2 4 0
Format:
0 0
1000 0
1000 1000
0 1000
Parts:
R1 5 2
U1 10 4
Pins:
100 100 -99 1 VCC
200 100 -99 1 GND
500 500 -99 2 VCC
600 500 -99 2 GND
Nails:
`;
    const b = importScenarioOrPcb('plain.brd', bytes(tt)).board;
    assert(get(b, 'R1')?.side === 'F' && get(b, 'U1')?.side === 'B', 'plain-text TopTest parts and sides');
    assert(get(b, 'U1').pads[0].net === 'VCC', 'plain-text TopTest nets');
  }

  // ---- anything else: an explicit error, never an empty board ----
  for (const [name, data] of [
    ['allegro.brd', new Uint8Array([0x00, 0x14, 0x00, 0x13, 0x00, 0x03, 0x00, 0x00, 0xff, 0x7f, 0x10, 0x20])],
    ['notes.brd', bytes('hello\nthis is not a boardview\n')],
  ] as const) {
    let msg = '';
    try { importScenarioOrPcb(name, data); } catch (e) { msg = String(e); }
    assert(/Unrecognised \.brd file/.test(msg), `${name} is rejected with a clear message: ${msg || 'imported an empty board'}`);
  }

  console.log('BRD TESTS PASSED (BRD2 sections, pin ranges, bottom-side flip, through-hole, nails, counts; plain TopTest bytes; unknown .brd rejected)');
}

run();
