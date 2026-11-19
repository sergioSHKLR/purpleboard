// Part data pipeline: the datasheet table extractor (npm run parts -- extract), catalogue ranking,
// and device-library models on any board by its printed part numbers. The datasheet text below
// is synthetic (made-up numbers in the layouts pdftotext -layout prints for Nexperia, Vishay and
// Diodes Inc. tables); no real datasheet text is used.
import { draftEntry, extractRows, parseConditions, parseUnit, seriesRows } from '../src/io/datasheetTable';
import { isOriginalMaker, looksLikePartNumber, rankCatalogue, searchPrefixes } from '../src/io/partNumbers';
import { importScenarioOrPcb } from '../src/io/kicad';
import { buildConnectivity } from '../src/connectivity';
import { boardToCircuit } from '../src/spice/board';
import { simulateSpice } from '../src/spice/adapter';
import { diodeModelParams, findDevice, type DiodeSpec } from '../src/spice/devicelib';
import type { Board } from '../src/types';

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const near = (a: number | undefined, b: number, tol = 1e-9) => a !== undefined && Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

/** A text line with each cell's text starting at its column. */
function line(cells: [number, string][]): string {
  let s = '';
  for (const [col, text] of cells) s = s.padEnd(col) + text;
  return s;
}

function extractor() {
  // ---- Nexperia-style table: symbol, parameter, conditions, Min Typ Max Unit on one line;
  // continuation rows under RDSon; a 150 °C row; rows the library does not use (IDSS, gfs) ----
  const C = { sym: 2, par: 18, cond: 44, min: 86, typ: 94, max: 102, unit: 110 };
  const row = (sym: string, par: string, cond: string, min: string, typ: string, max: string, unit: string) =>
    line([[C.sym, sym], [C.par, par], [C.cond, cond], [C.min, min], [C.typ, typ], [C.max, max], [C.unit, unit]]);
  const nx = [
    'N-channel Trench MOSFET',
    line([[C.sym, 'Symbol'], [C.par, 'Parameter'], [C.cond, 'Conditions'], [C.min, 'Min'], [C.typ, 'Typ'], [C.max, 'Max'], [C.unit, 'Unit']]),
    row('V(BR)DSS', 'breakdown voltage', 'ID = 250 µA; VGS = 0 V', '30', '-', '-', 'V'),
    row('VGS(th)', 'gate threshold', 'ID = 250 µA; VDS = VGS', '0.8', '1.1', '1.6', 'V'),
    row('IDSS', 'drain leakage', 'VDS = 30 V; VGS = 0 V', '-', '-', '1', 'µA'),
    row('RDSon', 'on-state', 'VGS = 4.5 V; ID = 1 A; Tj = 25 °C', '-', '40', '55', 'mΩ'),
    line([[C.par, 'resistance']]),
    row('', '', 'VGS = 4.5 V; ID = 1 A; Tj = 150 °C', '-', '62', '80', 'mΩ'),
    '',
    row('', '', 'VGS = 2.5 V; ID = 0.5 A; Tj = 25 °C', '-', '52', '70', 'mΩ'),
    row('gfs', 'transconductance', 'VDS = 5 V; ID = 1 A', '-', '6', '-', 'S'),
    row('Ciss', 'input capacitance', 'VGS = 0 V; VDS = 10 V;', '-', '410', '-', 'pF'),
    row('Coss', 'output capacitance', 'f = 1 MHz', '-', '60', '-', 'pF'),
    row('Crss', 'reverse transfer', '', '-', '35', '-', 'pF'),
    row('VSD', 'source-drain voltage', 'IS = 1 A; VGS = 0 V', '-', '0.78', '1.2', 'V'),
    row('Rth(j-a)', 'thermal resistance', 'in free air [1]', '-', '250', '300', 'K/W'),
    'Product data sheet    Rev. 2 — 3 March 2021',
  ].join('\n');
  const r = extractRows(nx);
  const q = (k: string) => r.filter((x) => x.quantity === k);
  assert(q('vgsth').length === 1 && q('vgsth')[0].min === 0.8 && q('vgsth')[0].typ === 1.1 && q('vgsth')[0].max === 1.6, `VGS(th) min/typ/max kept apart: ${JSON.stringify(q('vgsth'))}`);
  const rds = q('rdson');
  assert(rds.length === 3 && near(rds[0].typ, 0.04) && near(rds[0].max, 0.055) && rds[0].cond.VGS === 4.5 && near(rds[0].cond.ID, 1), `RDS(on) scaled from mΩ with conditions: ${JSON.stringify(rds)}`);
  assert(rds[1].hot && !rds[0].hot && !rds[2].hot && rds[2].cond.VGS === 2.5, 'the 150 °C row is flagged, continuation rows keep their own VGS');
  assert(!r.some((x) => /IDSS|gfs/.test(x.symbol)) && !q('vgsth').some((x) => x.min === 30), 'IDSS, gfs and V(BR)DSS rows are not taken for library quantities');
  assert(near(q('ciss')[0].typ, 410e-12) && near(q('crss')[0].typ, 35e-12) && q('ciss')[0].unit === 'F', 'capacitances in farads');
  assert(near(q('vsd')[0].typ, 0.78) && q('vsd')[0].cond.IS === 1 && q('rthja')[0].typ === 250, 'body diode and θJA');
  const d = draftEntry('XYZ30N', nx, r);
  assert(d.kind === 'nmos' && /vth: 1\.1, rds: \[\[4\.5, 0\.04\], \[2\.5, 0\.052\]\], body: \[0\.78, 1\], caps: \[4\.1e-10, 3\.5e-11, 6e-11\]/.test(d.entry), `draft entry: ${d.entry}`);
  assert(/verified: false/.test(d.entry) && /pins: \{ D: 'TODO'/.test(d.entry) && /thetaJA: 250/.test(d.entry), 'a draft is never verified and never guesses pins');
  assert(d.review.some((x) => /Rev\. 2 — 3 March 2021/.test(x)), `document revision found: ${d.review.join(' | ')}`);

  // ---- Vishay-style table: symbol between its two value rows, Ω lost in the text, no typical threshold ----
  const V = { par: 4, sym: 40, cond: 54, min: 92, typ: 104, max: 116, unit: 128 };
  const vrow = (par: string, sym: string, cond: string, min: string, typ: string, max: string, unit = '') =>
    line([[V.par, par], [V.sym, sym], [V.cond, cond], [V.min, min], [V.typ, typ], [V.max, max], [V.unit, unit]]);
  const vs = [
    'P-Channel 40 V (D-S) MOSFET',
    vrow('PARAMETER', 'SYMBOL', 'TEST CONDITIONS', 'MIN.', 'TYP.', 'MAX.', 'UNIT'),
    vrow('Gate threshold voltage', 'VGS(th)', 'VDS = VGS, ID = -250 µA', '-1', '-', '-2.5', 'V'),
    vrow('Gate-body leakage', 'IGSS', 'VDS = 0 V, VGS = ± 20 V', '-', '-', '± 100', 'nA'),
    vrow('', '', 'VDS = -40 V, VGS = 0 V', '-', '-', '-1'),
    vrow('Zero gate voltage drain current', 'IDSS', '', '', '', '', 'µA'),
    vrow('', '', 'VDS = -40 V, VGS = 0 V, TJ = 55 °C', '-', '-', '-10'),
    vrow('', '', 'VGS = -10 V, ID = -5 A', '-', '0.012', '0.015'),
    vrow('Drain-source on-state resistance', 'RDS(on)', '', '', '', ''),
    vrow('', '', 'VGS = -4.5 V, ID = -4 A', '-', '0.017', '0.021'),
    vrow('Diode forward voltage', 'VSD', 'IS = -2 A, VGS = 0 V', '-', '-0.8', '-1.2', 'V'),
  ].join('\n');
  const vr = extractRows(vs);
  const vrds = vr.filter((x) => x.quantity === 'rdson');
  assert(vrds.length === 2 && near(vrds[0].typ, 0.012) && vrds[0].cond.VGS === -10 && near(vrds[1].typ, 0.017) && /assumed/.test(vrds[0].unitSource), `rows on both sides of the RDS(on) symbol, Ω assumed: ${JSON.stringify(vrds)}`);
  assert(!vr.some((x) => x.quantity === 'rdson' && x.cond.VDS !== undefined), 'IDSS rows are not RDS(on) rows');
  const vd = draftEntry('SIX40DP', vs, vr);
  assert(vd.kind === 'pmos' && /vth: 1\.75, rds: \[\[10, 0\.012\], \[4\.5, 0\.017\]\], body: \[0\.8, 2\]/.test(vd.entry), `P-channel draft: ${vd.entry}`);
  assert(vd.review.some((x) => /VGS\(th\): no typical \(1–2\.5 V\): midpoint/.test(x)) && vd.review.some((x) => /Ciss/.test(x)), `stand-ins are listed for review: ${vd.review.join(' | ')}`);

  // ---- Diodes Inc. style: conditions after the Unit column; first row above its symbol; sister-part rows ----
  const D = { par: 2, sym: 36, min: 50, typ: 60, max: 70, unit: 80, cond: 88 };
  const drow = (par: string, sym: string, min: string, typ: string, max: string, unit: string, cond: string) =>
    line([[D.par, par], [D.sym, sym], [D.min, min], [D.typ, typ], [D.max, max], [D.unit, unit], [D.cond, cond]]);
  const di = [
    'Schottky barrier rectifier',
    drow('Characteristic', 'Symbol', 'Min', 'Typ', 'Max', 'Unit', 'Test Condition'),
    drow('', '', '', '0.30', '0.35', '', 'IF = 10mA, TJ = +25ºC'),
    drow('Forward Voltage', 'VF', '-', '0.42', '0.48', 'V', 'IF = 0.5A, TJ = +25ºC'),
    drow('', '', '', '-', '0.40', '', 'IF = 0.5A, TJ = +125ºC'),
    drow('', '', '', '-', '100', 'µA', 'VR = 40V, TJ = +25ºC'),
    drow('Leakage Current', 'IR', '-', '', '', '', ''),
    drow('Forward Voltage SBX1240', 'VF', '-', '0.50', '0.55', 'V', 'IF = 1A, TJ = +25ºC'),
  ].join('\n');
  const dr = extractRows(di);
  const vf = dr.filter((x) => x.quantity === 'vf');
  assert(vf.length === 4 && vf[0].cond.IF === 0.01 && near(vf[0].typ, 0.3) && vf[1].cond.IF === 0.5 && vf[2].hot, `VF rows with conditions right of the unit: ${JSON.stringify(vf)}`);
  assert(dr.some((x) => x.quantity === 'ir' && near(x.max, 1e-4) && x.cond.VR === 40), 'the 100 µA row belongs to IR (symbol below it), not VF');
  const dd = draftEntry('SBX0540', di, dr);
  assert(/kind: 'schottky', vf: \[\[0\.3, 0\.01\], \[0\.42, 0\.5\]\]/.test(dd.entry) && dd.review.some((x) => /SBX1240/.test(x)), `sister-part rows left out: ${dd.entry} ${dd.review.join(' | ')}`);

  // ---- series tables: the part's own row with its header, for mapping by hand ----
  const st = ['Type      Marking   VZ @ IZT', '          Nom  Min  Max   IZT', 'ZX5V1     W1   5.1  4.8  5.4   5', 'ZX6V2     W2   6.2  5.8  6.6   5'].join('\n');
  const sr = seriesRows(st, 'ZX6V2-7-F');
  assert(sr.length === 1 && /6\.2/.test(sr[0].row) && sr[0].header.length === 2, `series row + header: ${JSON.stringify(sr)}`);

  // ---- units and conditions ----
  assert(JSON.stringify(parseUnit('mΩ')) === JSON.stringify([1e-3, 'Ω']) && parseUnit('K/W')?.[1] === '°C/W' && parseUnit('nC')?.[1] === 'C' && !parseUnit('Typ'), 'unit parsing');
  const pc = parseConditions('VGS = -4.5 V; ID = -3.3 A; Tj = 150 °C; IF = 250 mA');
  assert(pc.VGS === -4.5 && pc.ID === -3.3 && pc.T === 150 && near(pc.IF, 0.25), `conditions: ${JSON.stringify(pc)}`);
}

function catalogue() {
  assert(looksLikePartNumber('1N4148WS') && looksLikePartNumber('2N7002') && looksLikePartNumber('BAT46WJ,115') && !looksLikePartNumber('100nF') && !looksLikePartNumber('4.7uH'), 'JEDEC numbers and packing codes are part numbers; values are not');
  assert(JSON.stringify(searchPrefixes('BAT46WJ,115')) === JSON.stringify(['BAT46WJ,115', 'BAT46WJ']), 'packing code cut at ","');
  assert(isOriginalMaker('Nexperia') && isOriginalMaker('Vishay Intertech') && isOriginalMaker('Diodes Incorporated') && !isOriginalMaker('TECH PUBLIC') && !isOriginalMaker(''), 'original makers vs clone houses');
  const rows = [
    { mfr: 'BSS138PW', manufacturer: 'TECH PUBLIC', datasheet: 'a' },
    { mfr: 'BSS138PWQ', manufacturer: 'Nexperia', datasheet: 'b' },
    { mfr: 'BSS138PW,115', manufacturer: 'Nexperia', datasheet: 'c' },
    { mfr: 'BSS138PW,115(ES)', manufacturer: 'ElecSuper', datasheet: 'd' },
  ];
  assert(rankCatalogue('BSS138PW', rows)?.datasheet === 'c', 'the original maker\'s ordering code wins over a clone and a look-alike');
  // the device library finds parts by the codes boards print
  for (const [v, mpn] of [['PMV50EPEAR', 'PMV50EPEA'], ['Si7850DP-T1-E3', 'SI7850DP'], ['SI7461DP-T1-GE3', 'SI7461DP'], ['BAT46WJ,115', 'BAT46WJ'], ['SBR0560S1-7', 'SBR0560S1'], ['IRF9395TRPBF', 'IRF9395']]) assert(findDevice(v)?.mpn === mpn, `${v} → ${mpn}`);
  assert(!findDevice('BSS138') && !findDevice('PMV50'), 'no match on a shorter, different part');
}

// ---- device-library models on an imported board, by printed part number ----
const NETS = ['""', '"VIN"', '"GND"', '"OUT"', '"EN"'];
const netTable = NETS.map((n, i) => `(net ${i} ${n})`).join(' ');
const edge = '(gr_rect (start 0 0) (end 80 40) (layer "Edge.Cuts") (width 0.1))';
type P = [name: string, x: number, y: number, net: number];
function kicad(parts: [ref: string, value: string, x: number, y: number, pads: P[]][]): Board {
  const at: Record<number, [number, number][]> = {};
  const fps = parts.map(([ref, value, x, y, pads]) => {
    const ps = pads.map(([name, dx, dy, net]) => {
      (at[net] ??= []).push([x + dx, y + dy]);
      return `(pad "${name}" smd rect (at ${dx} ${dy}) (size 0.6 0.5) (layers "F.Cu") (net ${net} ${NETS[net]}))`;
    }).join(' ');
    return `(footprint "lib:${ref}" (layer "F.Cu") (at ${x} ${y} 0) (property "Reference" "${ref}") (property "Value" "${value}") ${ps})`;
  });
  // each pad: a front stub down to a via on its net's own back-side lane (pads have distinct x)
  const segs = Object.entries(at).flatMap(([net, pts]) => {
    const lane = 30 + 2 * +net;
    const xs = pts.map((p) => p[0]).sort((a, b) => a - b);
    return [
      ...pts.map(([x, y]) => `(segment (start ${x} ${y}) (end ${x} ${lane}) (width 0.25) (layer "F.Cu") (net ${net})) (via (at ${x} ${lane}) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net ${net}))`),
      `(segment (start ${xs[0]} ${lane}) (end ${xs[xs.length - 1]} ${lane}) (width 0.25) (layer "B.Cu") (net ${net}))`,
    ];
  });
  return importScenarioOrPcb('t.kicad_pcb', `(kicad_pcb (version 20221018) ${netTable} ${edge} ${fps.join(' ')} ${segs.join(' ')})`).board;
}

function boardModels() {
  // 12 V header supply on VIN (a bare "J1 12V" header is the board supply), P-FET high-side switch Q1 → OUT → 10 Ω load,
  // reverse-protection 1N4148WS across VIN (cathode on VIN); Q1's gate driver is not on the board
  const parts = (pulldown: boolean): Parameters<typeof kicad>[0] => [
    ['J1', '12V', 5, 20, [['1', -1, 0, 1], ['2', 1, 0, 2]]],
    ['Q1', 'PMV50EPEAR', 20, 20, [['1', -2, 0, 4], ['2', 0, 0, 1], ['3', 2, 0, 3]]],
    ['R1', '10', 35, 20, [['1', -1, 0, 3], ['2', 1, 0, 2]]],
    ['D1', '1N4148WS', 50, 20, [['1', -1, 0, 1], ['2', 1, 0, 2]]],
    ...(pulldown ? [['R2', '10k', 65, 20, [['1', -1, 0, 4], ['2', 1, 0, 2]]] as Parameters<typeof kicad>[0][number]] : []),
  ];
  const b = kicad(parts(false));
  const conn = buildConnectivity(b);
  const nl = boardToCircuit(b, conn);
  const q1 = nl.report.find((r) => r.ref === 'Q1'), d1 = nl.report.find((r) => r.ref === 'D1');
  assert(q1?.source === 'library' && q1.as === 'subckt' && /PMV50EPEA.*datasheet-verified/.test(q1.note ?? ''), `Q1 modelled from the library by its value: ${JSON.stringify(q1)}`);
  assert(d1?.source === 'library' && d1.as === 'D', `D1 is a plain library diode: ${JSON.stringify(d1)}`);
  const dEl = nl.circuit.elements.find((e) => e.kind === 'D' && e.name.startsWith('D1'));
  const model = nl.circuit.models.find((m) => dEl && 'model' in dEl && m.name === dEl.model);
  const want = diodeModelParams(findDevice('1N4148WS')!.units[0] as DiodeSpec);
  assert(model && near(model.params.is, want.IS, 1e-6) && near(model.params.bv, 100), `D1 uses the fitted datasheet model: ${JSON.stringify(model)}`);
  const sub = nl.circuit.subckts.find((s) => s.name.includes('Q1'));
  assert(sub?.elements.some((e) => e.kind === 'M') && sub.elements.some((e) => e.kind === 'R' && e.name.startsWith('RGS')), 'Q1 subcircuit: MOSFET + gate bleed');
  assert(!boardToCircuit(b, conn, { devices: false }).report.some((r) => r.source === 'library'), 'devices: false keeps the generic path');
  const open = boardToCircuit(b, conn, { diodesOpen: true });
  assert(!open.circuit.elements.some((e) => e.name.startsWith('D1') || e.name.startsWith('XQ1')), 'the ideal ohmmeter leaves library junctions open');

  const v = (sim: ReturnType<typeof simulateSpice>, c: ReturnType<typeof buildConnectivity>, net: string) => { const k = sim.nodeOfNet.get(c.netNames.indexOf(net)); return k === undefined ? NaN : sim.V[k]; };
  // undriven gate: the bleed holds it at the source, the P-FET stays off
  const off = simulateSpice(b, conn);
  assert(v(off, conn, 'VIN') > 11 && v(off, conn, 'OUT') < 0.05, `undriven P-FET gate stays off: OUT ${v(off, conn, 'OUT')} V`);
  // gate pulled to ground: on; its dissipation reaches the thermal model (subcircuit power read-back)
  const b2 = kicad(parts(true));
  const c2 = buildConnectivity(b2);
  const on = simulateSpice(b2, c2);
  const out = v(on, c2, 'OUT'), iq = out / 10;
  const q1p = on.comps.get(b2.components.find((c) => c.ref === 'Q1')!.id)?.p ?? 0;
  assert(out > 10 && q1p > 0.5 * iq * iq * 0.035 && q1p < 3 * iq * iq * 0.035, `P-FET on: OUT ${out.toFixed(3)} V, Q1 dissipates ${(q1p * 1e3).toFixed(1)} mW ≈ I²·RDS(on)`);
  // a reversed library diode is reversed in the netlist: forward-biased across the supply, it overheats
  const b3 = kicad(parts(false));
  b3.components.find((c) => c.ref === 'D1')!.state.reversed = true;
  const c3 = buildConnectivity(b3);
  const d1r = simulateSpice(b3, c3).comps.get(b3.components.find((c) => c.ref === 'D1')!.id);
  assert(d1r && d1r.i > 1 && d1r.over, `reversed D1 forward-biased across the supply and flagged: ${JSON.stringify(d1r)}`);
}

extractor();
catalogue();
boardModels();
console.log('PART DATA TESTS PASSED (datasheet tables in three vendor layouts → rows + drafts, catalogue ranking, library models on an imported board: diode, P-FET gate bleed, power read-back, reversal)');
