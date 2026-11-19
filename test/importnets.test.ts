// Import net invariants: after any import, every named net of the file is exactly one conductor
// and no conductor carries two names — otherwise the importer reports it (Scenario.importWarnings,
// shown as a toast). Boardviews store pin positions, not copper, so pads of different nets that
// overlap (stacked pads, guessed sizes) must not short; a real overlap in a KiCad file is a short
// and is reported. Synthetic files only.
import { importScenarioOrPcb } from '../src/io/kicad';
import { buildBoardview, type RawBoard } from '../src/io/brd';
import { parseScenario, serializeScenario } from '../src/io/format';
import { buildConnectivity, netReport, type Conn } from '../src/connectivity';
import { addBlob } from '../src/ops';
import { padWorld } from '../src/model';
import type { Board } from '../src/types';

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const bytes = (s: string) => new TextEncoder().encode(s);
const get = (b: Board, ref: string) => b.components.find((c) => c.ref === ref)!;
const padNet = (conn: Conn, b: Board, ref: string, name: string) => { const c = get(b, ref); return conn.net[conn.padItem.get(c)![c.pads.findIndex((p) => p.name === name)]]; };
const padAt = (b: Board, ref: string, name: string) => { const c = get(b, ref); return padWorld(c, c.pads.find((p) => p.name === name)!).at; };

/** A boardview where U2.1 (net C) sits exactly on U1.1 (net A), same side: a stacked pad. */
const BRD2 = `BRDOUT: 4 2000 1000
0 0
2000 0
2000 1000
0 1000

NETS: 4
1 A
2 B
3 C
4 GND

PARTS: 3
U1 450 250 650 350 0 1
U2 450 250 750 350 2 1
R1 900 250 1000 350 4 1

PINS: 6
500 300 1 1
600 300 2 1
500 300 3 1
700 300 4 1
900 300 1 1
1000 300 3 1

NAILS: 0
`;

const TOPTEST = `str_length: 0
var_data: 4 3 6 0
Format:
0 0
2000 0
2000 1000
0 1000
Parts:
U1 5 2
U2 5 4
R1 5 6
Pins:
500 300 -99 1 A
600 300 -99 1 B
500 300 -99 1 C
700 300 -99 1 GND
900 300 -99 1 A
1000 300 -99 1 C
Nails:
`;

/** Checks a boardview import: the stacked pads stay two nets, nothing is reported, a blob still shorts. */
function checkStacked(label: string, b: Board, warnings: string[] | undefined) {
  assert(b.estimatedPads === true, `${label}: pad shapes marked as estimates`);
  const p1 = padAt(b, 'U1', '1'), p2 = padAt(b, 'U2', '1');
  assert(Math.hypot(p1[0] - p2[0], p1[1] - p2[1]) < 1e-6, `${label}: U2.1 sits exactly on U1.1 (the stacked case)`);
  const conn = buildConnectivity(b);
  assert(padNet(conn, b, 'U1', '1') !== padNet(conn, b, 'U2', '1'), `${label}: stacked pads of nets A and C stay apart`);
  assert(padNet(conn, b, 'U1', '1') === padNet(conn, b, 'R1', '1') && padNet(conn, b, 'U2', '1') === padNet(conn, b, 'R1', '2'), `${label}: each still joins its own net by name`);
  const r = netReport(conn);
  assert(r.named === 4 && !r.merged.length && !r.split.length, `${label}: 4 file nets = 4 conductors (merged ${JSON.stringify(r.merged)}, split ${JSON.stringify(r.split)})`);
  assert(!warnings?.length, `${label}: no import warnings: ${warnings}`);
  // without the flag the old rule would short them: the check is what would catch it
  const old = netReport(buildConnectivity({ ...b, estimatedPads: false }));
  assert(old.merged.some((m) => m.nets.join() === 'A,C'), `${label}: treated as real copper, the stacked pads would join A + C`);
  // a solder blob is real copper: it still bridges pads of different nets on a boardview board
  const fixed = structuredClone(b);
  addBlob(fixed, padAt(fixed, 'U1', '2'), 'F', 0.6);
  addBlob(fixed, padAt(fixed, 'U1', '1'), 'F', 0.6);
  const bc = buildConnectivity(fixed);
  const blobNet = bc.net[bc.blobItem.get(fixed.blobs[1])!];
  assert(blobNet === padNet(bc, fixed, 'U1', '1') && blobNet === padNet(bc, fixed, 'U2', '1'), `${label}: a blob over the stacked pads shorts A and C`);
  // the flag survives a save
  assert(parseScenario(serializeScenario({ format: 'pcbfix/1', id: 't', meta: { title: 't', author: '', difficulty: 1, description: '', hints: [] }, board: b, objectives: [] })).board.estimatedPads === true, `${label}: flag saved`);
}

function run() {
  // ---- boardviews: BRD2 and TopTest .brd with a stacked pad ----
  {
    const sc = importScenarioOrPcb('stacked.brd', bytes(BRD2));
    assert(sc.meta.author === 'Boardview (BRD2)', 'read as BRD2');
    checkStacked('BRD2', sc.board, sc.importWarnings);
  }
  {
    const sc = importScenarioOrPcb('stacked.brd', bytes(TOPTEST));
    assert(sc.meta.author === 'Boardview (.brd)', 'read as TopTest');
    checkStacked('TopTest', sc.board, sc.importWarnings);
  }

  // ---- real pad shapes (the TVW route): overlaps trimmed, coincident pads kept apart ----
  {
    const pad = (w: number, h: number) => ({ w, h, shape: 'rect' as const, rot: 0 });
    const raw: RawBoard = {
      outline: [[0, 0], [2000, 0], [2000, 1000], [0, 1000]],
      parts: [
        { ref: 'U1', side: 'F', tht: false, pins: [{ x: 500, y: 300, net: 'A', pad: pad(60, 60) }, { x: 600, y: 300, net: 'B', pad: pad(60, 60) }] },
        // U2.1 is coincident with U1.1; U2.2 overlaps U1.2 by 20 mil (a misread size)
        { ref: 'U2', side: 'F', tht: false, pins: [{ x: 500, y: 300, net: 'C', pad: pad(40, 40) }, { x: 640, y: 300, net: 'GND', pad: pad(60, 60) }] },
        { ref: 'R1', side: 'F', tht: false, pins: [{ x: 900, y: 300, net: 'A', pad: pad(40, 40) }, { x: 1000, y: 300, net: 'C', pad: pad(40, 40) }] },
      ],
      nails: [{ x: 1000, y: 300, side: 'F', net: 'C' }],
    };
    const sc = buildBoardview(raw, 'shapes', 'Boardview (TVW)');
    const b = sc.board;
    const conn = buildConnectivity(b);
    const u12 = get(b, 'U1').pads[1], u22 = get(b, 'U2').pads[1];
    assert(u12.size[0] < 60 * 0.0254 && u22.size[0] < 60 * 0.0254, 'overlapping pads of different nets trimmed for the drawing');
    assert(padNet(conn, b, 'U1', '2') !== padNet(conn, b, 'U2', '2') && padNet(conn, b, 'U1', '1') !== padNet(conn, b, 'U2', '1'), 'no pad pair of different nets joined');
    const r = netReport(conn);
    assert(r.named === 4 && !r.merged.length && !r.split.length && !sc.importWarnings, `4 nets, 4 conductors, nothing reported (${sc.importWarnings})`);
  }

  // ---- KiCad: real copper, so an overlap is a short and is reported; so is an unrouted net ----
  {
    const NETS = ['""', '"VIN"', '"GND"', '"N1"', '"unconnected-(U1-Pad3)"', '"unconnected-(U1-Pad4)"'];
    const head = `(kicad_pcb (version 20221018) ${NETS.map((n, i) => `(net ${i} ${n})`).join(' ')} (gr_rect (start 0 0) (end 60 40) (layer "Edge.Cuts") (width 0.1))`;
    const fp = (ref: string, at: string, pads: string) => `(footprint "lib:${ref}" (layer "F.Cu") (at ${at}) (property "Reference" "${ref}") (property "Value" "10k") ${pads})`;
    const pad = (name: string, at: string, net: number) => `(pad "${name}" smd rect (at ${at}) (size 0.6 0.5) (layers "F.Cu") (net ${net} ${NETS[net]}))`;
    const imp = (body: string) => importScenarioOrPcb('t.kicad_pcb', `${head} ${body})`);

    // clean: R1 and R2 on N1, joined by a track; two no-connect pads joined by a track (harmless)
    const clean = imp(`${fp('R1', '10 10 0', pad('1', '-1 0', 3) + pad('2', '1 0', 2))}
      ${fp('R2', '20 10 0', pad('1', '-1 0', 3) + pad('2', '1 0', 2))}
      (segment (start 9 10) (end 9 7) (width 0.25) (layer "F.Cu") (net 3))
      (segment (start 9 7) (end 19 7) (width 0.25) (layer "F.Cu") (net 3))
      (segment (start 19 7) (end 19 10) (width 0.25) (layer "F.Cu") (net 3))
      (segment (start 11 10) (end 11 14) (width 0.25) (layer "F.Cu") (net 2))
      (segment (start 11 14) (end 21 14) (width 0.25) (layer "F.Cu") (net 2))
      (segment (start 21 14) (end 21 10) (width 0.25) (layer "F.Cu") (net 2))
      ${fp('U1', '30 20 0', pad('3', '0 0', 4) + pad('4', '0 1', 5))}
      (segment (start 30 20) (end 30 21) (width 0.2) (layer "F.Cu") (net 4))`);
    assert(!clean.importWarnings, `a clean file reports nothing (no-connect pads joined are harmless): ${clean.importWarnings}`);
    assert(!clean.board.estimatedPads, 'KiCad pads are real copper');

    // R2.1 (N1) drawn overlapping R3.1 (VIN): a short in the design; R4 on N1 never routed
    const bad = imp(`${fp('R1', '10 10 0', pad('1', '-1 0', 3) + pad('2', '1 0', 2))}
      ${fp('R2', '20 10 0', pad('1', '-1 0', 3) + pad('2', '1 0', 2))}
      (segment (start 9 10) (end 9 7) (width 0.25) (layer "F.Cu") (net 3))
      (segment (start 9 7) (end 19 7) (width 0.25) (layer "F.Cu") (net 3))
      (segment (start 19 7) (end 19 10) (width 0.25) (layer "F.Cu") (net 3))
      ${fp('R3', '19.2 10 0', pad('1', '0 0', 1) + pad('2', '0 3', 2))}
      ${fp('R4', '40 30 0', pad('1', '-1 0', 3) + pad('2', '1 0', 2))}`);
    const w = bad.importWarnings ?? [];
    assert(w.some((x) => /join different nets/.test(x) && /N1 \+ VIN|VIN \+ N1/.test(x)), `the overlap is reported as a short: ${w}`);
    assert(w.some((x) => /fall apart/.test(x) && /N1 ×2 \(R1\.1, R4\.1\)/.test(x)), `the unrouted net is reported: ${w}`);
    assert(w.length === 2, `GND has no copper at all, so it joins by name and is not reported: ${w}`);
    assert(!JSON.parse(serializeScenario(bad)).importWarnings, 'warnings are not saved with the board');
  }

  console.log('IMPORT NET TESTS PASSED (stacked boardview pads stay apart in BRD2 / TopTest / real pad shapes, blobs still short, KiCad overlap and unrouted net reported)');
}

run();
