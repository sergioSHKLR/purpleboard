// KiCad import of real-world multilayer boards: rotation, inner planes, thermal reliefs, DNP,
// protection diodes, library-style values, rail names and the bench supply. Synthetic files.
import { importScenarioOrPcb } from '../src/io/kicad';
import { parseScenario } from '../src/io/format';
import { buildConnectivity, pinNet } from '../src/connectivity';
import { netRole, railVoltage } from '../src/spice/powertree';
import type { Board } from '../src/types';
import { runSolver } from '../src/verify';

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

const NETS = ['""', '"VIN"', '"GND"', '"/Power/+3.3V"', '"N1"', '"PLANE"', '"SW"', '"+5V"', '"EN5"'];
const netTable = NETS.map((n, i) => `(net ${i} ${n})`).join(' ');
const edge = '(gr_rect (start 0 0) (end 60 40) (layer "Edge.Cuts") (width 0.1))';
const fp = (ref: string, value: string, at: string, pads: string, extra = '') =>
  `(footprint "lib:${ref}" (layer "F.Cu") (at ${at}) ${extra} (property "Reference" "${ref}") (property "Value" "${value}") ${pads})`;
const pad = (name: string, at: string, net: number, layer = 'F.Cu', size = '0.6 0.5') =>
  `(pad "${name}" smd rect (at ${at}) (size ${size}) (layers "${layer}") (net ${net} ${NETS[net]}))`;
const board = (body: string): Board => importScenarioOrPcb('t.kicad_pcb', `(kicad_pcb (version 20221018) ${netTable} ${edge} ${body})`).board;
const get = (b: Board, ref: string) => b.components.find((c) => c.ref === ref)!;

function run() {
  // ---- rail names: decimal and hierarchical; gated rails ----
  assert(railVoltage('/Power/+3.3V') === 3.3 && netRole('/Power/+3.3V') === 'rail', 'hierarchical decimal rail');
  assert(railVoltage('1.1V_SYS') === 1.1 && railVoltage('+3V3') === 3.3, 'decimal and V-separated voltages');
  assert(netRole('30V_GATE') === 'rail' && netRole('Q1_GATE') === 'gate', 'a gated rail is a rail, a FET gate is not');

  // ---- a part rotated 90°: KiCad angles are counter-clockwise on screen, kept as-is ----
  {
    // pad 1 at local (-1, 0) of a footprint at (20, 20) rotated 90° lands at KiCad (20, 21)
    const b = board(`${fp('R1', '10k', '20 20 90', pad('1', '-1 0 90', 4) + pad('2', '1 0 90', 2))}
      (segment (start 20 21) (end 20 30) (width 0.25) (layer "F.Cu") (net 4))
      (segment (start 20 30) (end 40 30) (width 0.25) (layer "F.Cu") (net 4))
      ${fp('R2', '10k', '41 30 0', pad('1', '-1 0', 4) + pad('2', '1 0', 2))}`);
    const conn = buildConnectivity(b);
    assert(pinNet(conn, get(b, 'R1'), '1') === pinNet(conn, get(b, 'R2'), '1'), 'the rotated pad touches its track (R1.1 — N1 — R2.1)');
    assert(get(b, 'R1').value === 10e3, 'value parsed');
  }

  // ---- inner-layer plane: vias of the plane net joined by design; outer tracks still geometric ----
  {
    const b = board(`(segment (start 10 10) (end 50 10) (width 0.3) (layer "In1.Cu") (net 5))
      (via (at 10 10) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 5))
      (via (at 50 30) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 5))
      (segment (start 10 10) (end 10 14) (width 0.25) (layer "F.Cu") (net 5))
      (segment (start 50 30) (end 50 26) (width 0.25) (layer "F.Cu") (net 5))
      ${fp('C1', 'C_100n_0402', '10 15 0', pad('1', '0 -1', 5) + pad('2', '0 1', 2))}
      ${fp('C2', '100n', '50 25 0', pad('1', '0 1', 5) + pad('2', '0 -1', 2))}`);
    assert(b.hiddenCopperNets?.includes('PLANE'), 'inner-layer copper marks the net as hidden');
    const conn = buildConnectivity(b);
    assert(pinNet(conn, get(b, 'C1'), '1') === pinNet(conn, get(b, 'C2'), '1'), 'pads joined through the hidden plane (via → plane → via)');
    assert(Math.abs(get(b, 'C1').value - 100e-9) < 1e-15 && !get(b, 'C1').valueGuessed, 'library-style value "C_100n_0402" parsed as 100 nF');
    // the inner copper is kept for display (X-ray / selected net) and survives a save
    assert(b.inner?.traces.length === 1 && b.inner.traces[0].layer === 1 && b.inner.traces[0].net === 'PLANE', 'inner track kept for display');
    const saved = parseScenario(JSON.stringify({ format: 'pcbfix/1', id: 't', meta: { title: 't' }, board: b, objectives: [] })).board;
    assert(saved.inner?.traces.length === 1, 'inner copper survives serialization');
  }

  // ---- inner pour: only the fill is drawn, simplified within tolerance ----
  {
    // a 40-segment arc (radius 5) plus a rectangle: the arc keeps its shape, collinear points go
    const arc = Array.from({ length: 41 }, (_, i) => { const t = (Math.PI * i) / 40; return `(xy ${(30 + 5 * Math.cos(t)).toFixed(4)} ${(20 - 5 * Math.sin(t)).toFixed(4)})`; }).join(' ');
    const pts = `(xy 20 20) (xy 22 20) (xy 24 20) ${arc.replace(/\(xy 35\.0000 20\.0000\) /, '')} (xy 40 20) (xy 40 30) (xy 20 30)`;
    const b = board(`(zone (net 7) (net_name "+5V") (layer "In2.Cu") (polygon (pts (xy 0 0) (xy 60 0) (xy 60 40) (xy 0 40)))
        (filled_polygon (layer "In2.Cu") (pts ${pts})))
      (zone (net 2) (net_name "GND") (layer "In1.Cu") (polygon (pts (xy 0 0) (xy 60 0) (xy 60 40) (xy 0 40))))`);
    assert(b.inner?.zones.length === 1 && b.inner.zones[0].layer === 2 && b.inner.zones[0].net === '+5V', 'one filled inner pour (an unfilled outline is not copper)');
    const poly = b.inner.zones[0].poly;
    assert(poly.length < 30 && poly.length > 8, `pour simplified but the arc kept (${poly.length} vertices)`);
    assert(b.hiddenCopperNets?.includes('GND') && b.hiddenCopperNets.includes('+5V'), 'both inner nets still joined by design');
  }

  // ---- thermal relief: the pour clears the pad and joins it through a spoke ----
  {
    // GND pour from x 0..30 with a clearance window around the pad at (15, 20), joined by one spoke
    const pour = '(xy 0 0) (xy 30 0) (xy 30 40) (xy 0 40) (xy 0 21) (xy 14 21) (xy 14 20.1) (xy 14.5 20.1) (xy 14.5 20.6) (xy 0 20.6)';
    const b = board(`(zone (net 2) (net_name "GND") (layer "F.Cu") (polygon (pts (xy 0 0) (xy 30 0) (xy 30 40) (xy 0 40)))
        (filled_polygon (layer "F.Cu") (pts ${pour})))
      ${fp('R3', '1k', '15 20 0', pad('1', '0 0', 2, 'F.Cu', '1.2 1.2') + pad('2', '3 0', 4))}`);
    const conn = buildConnectivity(b);
    const zoneNet = conn.net[conn.items.findIndex((it) => it.kind === 'zone')];
    assert(pinNet(conn, get(b, 'R3'), '1') === zoneNet, 'a pad reached only by a relief spoke is connected to the pour');
  }

  // ---- no copper, no connection: keepout areas, paste-only windows, non-plated holes ----
  {
    // R4 (VIN / +5V) and R5 (+3.3V / GND) sit under a keepout rule area; U1 has a GND thermal pad
    // split into paste windows that reach over the +5V pad beside it; a mounting hole spans
    // VIN and GND pads. Real board files (Olimex ESP32 boards) have all three.
    const keep = `(zone (net 0) (net_name "") (layer "F.Cu") (hatch edge 0.5) (connect_pads (clearance 0))
        (keepout (tracks allowed) (vias allowed) (pads allowed) (copperpour not_allowed) (footprints allowed))
        (polygon (pts (xy 5 5) (xy 25 5) (xy 25 15) (xy 5 15))))`;
    const paste = (at: string) => `(pad "" smd rect (at ${at}) (size 1.6 1.2) (layers "F.Paste"))`;
    const npth = '(pad "" np_thru_hole circle (at 0 0) (size 3.3 3.3) (drill 3.3) (layers "F&B.Cu" "*.Mask"))';
    const b = board(`${keep}
      ${fp('R4', '1k', '10 10 0', pad('1', '-1 0', 1) + pad('2', '1 0', 7))}
      ${fp('R5', '1k', '20 10 0', pad('1', '-1 0', 3) + pad('2', '1 0', 2))}
      ${fp('U1', 'QFN', '40 10 0', pad('EP', '0 0', 2, 'F.Cu', '2 2') + pad('1', '1.9 0', 7, 'F.Cu', '0.6 0.6') + paste('0.6 0') + paste('-0.6 0'))}
      ${fp('H1', 'MountingHole', '40 30 0', npth)}
      ${fp('R6', '1k', '38.9 30 0', pad('1', '0 0', 1) + pad('2', '-3 0', 4))}
      ${fp('R7', '1k', '41.1 30 0', pad('1', '0 0', 2) + pad('2', '3 0', 4))}`);
    const conn = buildConnectivity(b);
    const nets = new Set(['R4', 'R5'].flatMap((r) => ['1', '2'].map((p) => pinNet(conn, get(b, r), p))));
    assert(nets.size === 4 && !b.zones.length, 'a keepout area is a design rule, not copper: the four pads under it stay four nets');
    assert(get(b, 'U1').pads.length === 2 && pinNet(conn, get(b, 'U1'), 'EP') !== pinNet(conn, get(b, 'U1'), '1'), 'paste-only windows are not copper and do not join the thermal pad to its neighbour');
    assert(!get(b, 'H1') && pinNet(conn, get(b, 'R6'), '1') !== pinNet(conn, get(b, 'R7'), '1'), 'a non-plated hole has no copper: the mounting hole is not a part');
  }

  // ---- fitted / not fitted, protection diodes, ferrites ----
  {
    const b = board(`${fp('R9', 'R_0R_0402', '30 30 0', pad('1', '-1 0', 7) + pad('2', '1 0', 2), '(attr smd dnp)')}
      ${fp('D1', 'ESD5B5_0ST1G', '30 34 0', pad('1', '-1 0', 2) + pad('2', '1 0', 7))}
      ${fp('D2', 'SMBJ33A', '30 36 0', pad('1', '-1 0', 1) + pad('2', '1 0', 2))}
      ${fp('D3', 'BAT54C', '30 38 0', pad('1', '-1 0', 1) + pad('2', '1 0', 7) + pad('3', '0 1', 4))}
      ${fp('FB1', '600R', '40 34 0', pad('1', '-1 0', 1) + pad('2', '1 0', 4))}`);
    assert(!get(b, 'R9').state.populated, 'a dnp footprint is on the board but not fitted');
    const nf = board(`${fp('R7', 'NA/R0402', '10 10 0', pad('1', '-1 0', 3) + pad('2', '1 0', 4))}
      ${fp('R12', 'DNP', '10 14 0', pad('1', '-1 0', 3) + pad('2', '1 0', 4))}
      ${fp('U7', 'NA(SN74LVC1G04DBVR(SOT23-5))', '10 18 0', pad('1', '-1 0', 3) + pad('2', '1 0', 2))}
      ${fp('R8', 'NAND_PULLUP_10k', '10 22 0', pad('1', '-1 0', 3) + pad('2', '1 0', 4))}
      ${fp('SW2', 'NC', '10 26 0', pad('1', '-1 0', 3) + pad('2', '1 0', 4))}`);
    assert(!get(nf, 'R7').state.populated && !get(nf, 'R12').state.populated && !get(nf, 'U7').state.populated, 'a value that says "not fitted" (NA/…, DNP, NA(…)) leaves the footprint empty');
    assert(get(nf, 'R8').state.populated && get(nf, 'SW2').state.populated, 'other values starting with those letters, and a normally-closed switch, stay fitted');
    assert(get(b, 'D1').kind === 'ic', 'a bidirectional ESD protector does not conduct in normal operation');
    assert(get(b, 'D2').kind === 'diode', 'a unidirectional TVS stays a diode (diode-mode readings)');
    assert(get(b, 'D3').kind === 'ic', 'a three-pin dual diode is not one junction');
    assert(get(b, 'FB1').kind === 'resistor' && get(b, 'FB1').value === 0.05 && get(b, 'FB1').label === 'Ferrite bead', 'a ferrite is a low-ohm power path');
  }

  // ---- bench supply on the input rail; coin cells stay 3 V RTC cells ----
  {
    const b = board(`${fp('J1', 'DC_JACK', '5 20 0', pad('1', '0 -1', 1) + pad('2', '0 1', 2))}
      ${fp('U1', 'BUCK', '20 20 0', pad('1', '-2 -1', 1) + pad('2', '-2 1', 2) + pad('3', '2 -1', 6) + pad('4', '2 1', 8))}
      ${fp('L1', '2.2uH', '30 20 0', pad('1', '-1 0', 6) + pad('2', '1 0', 7))}
      ${fp('C5', '22u', '36 20 0', pad('1', '0 -1', 7) + pad('2', '0 1', 2))}
      ${fp('BT1', 'CR1220', '50 10 0', pad('1', '-1 0', 4) + pad('2', '1 0', 2), '', )}`);
    const sup = b.components.find((c) => c.ref === 'J_BENCH');
    assert(sup && sup.pads[0].net === 'VIN' && sup.value === 12 && /assumed/.test(sup.label ?? ''), `bench supply on VIN, 12 V assumed: ${JSON.stringify(sup?.label)}`);
    assert(get(b, 'BT1').value === 3, 'the coin cell is a 3 V cell, not the board supply');
    assert(get(b, 'L1').value === 0.02 && get(b, 'L1').label === 'Inductor', 'an inductor is modelled by its DC resistance');
  }

  // ---- a battery footprint is a cell only when the design says which; else it is the empty socket ----
  {
    const b = board(`${fp('BAT1', 'DW02S', '10 10 0', pad('1', '-1 0', 4) + pad('2', '1 0', 2))}
      ${fp('BAT2', '18650', '20 10 0', pad('1', '-1 0', 4) + pad('2', '1 0', 2))}
      ${fp('BT3', '3.7V LiPo', '30 10 0', pad('1', '-1 0', 4) + pad('2', '1 0', 2))}`);
    assert(get(b, 'BAT1').kind === 'connector' && get(b, 'BAT2').kind === 'connector', 'a pack socket (JST "DW02S", "18650" holder) has nothing plugged in on the bench');
    assert(get(b, 'BT3').kind === 'battery' && get(b, 'BT3').value === 3.7, 'a stated voltage makes it a cell');
  }

  // ---- pads keep their real size: a 0.127 mm net-tie pad beside another net's pad stays apart ----
  {
    // NT1 pads 0.127 mm at x 10.0 / 10.2; R8 pad (other net) 0.2 mm away. Enlarged to 0.4 mm they touched.
    const b = board(`${fp('NT1', 'NetTie', '10 10 0', pad('1', '0 0', 3, 'F.Cu', '0.127 0.127') + pad('2', '0.2 0', 3, 'F.Cu', '0.127 0.127'))}
      ${fp('R8', '10k', '10.45 10 0', pad('1', '0 0', 2, 'F.Cu', '0.15 0.15') + pad('2', '1 0', 4, 'F.Cu', '0.15 0.15'))}`);
    const conn = buildConnectivity(b);
    assert(get(b, 'NT1').pads[0].size[0] === 0.127, 'pad size as designed');
    assert(pinNet(conn, get(b, 'NT1'), '2') !== pinNet(conn, get(b, 'R8'), '1'), 'a tiny pad does not swell into its neighbour');
  }

  // ---- a changeover (SPDT) switch: the part's drawing says which throw is normally open ----
  {
    // Kailh CMI126603D08 (LCSC C400256): 1 COM, 2 NO, 3 NC. COM on GND, NO on N1 and NC on SW, each
    // pulled up to +5V by 10 kΩ (a mouse-switch button with a debounce latch behind it)
    const lc = '(property "LCSC" "C400256")';
    const b = board(`${fp('J1', '5V', '5 20 0', pad('1', '0 -1', 7) + pad('2', '0 1', 2))}
      ${fp('SW2', '~', '20 20 0', pad('1', '0 -5', 2) + pad('2', '0 0', 4) + pad('3', '0 5', 6), lc)}
      ${fp('R1', '10k', '30 15 0', pad('1', '-1 0', 7) + pad('2', '1 0', 4))}
      ${fp('R2', '10k', '30 25 0', pad('1', '-1 0', 7) + pad('2', '1 0', 6))}`);
    const sw = get(b, 'SW2');
    assert(sw.pins.COM === '1' && sw.pins.NO === '2' && sw.pins.NC === '3' && sw.lcsc === 'C400256', `switch roles from the part's drawing: ${JSON.stringify(sw.pins)}`);
    const conn = buildConnectivity(b);
    const no = conn.netNames.indexOf('N1'), nc = conn.netNames.indexOf('SW');
    for (const solver of ['fast', 'spice'] as const) for (const pressed of [false, true]) {
      const sim = runSolver(solver, b, conn, { switches: { SW2: pressed } });
      const v = (net: number) => { const k = sim.nodeOfNet.get(net); return k === undefined ? NaN : sim.V[k]; };
      const [vNo, vNc] = [v(no), v(nc)];
      assert(pressed ? vNo < 0.05 && vNc > 4.5 : vNo > 4.5 && vNc < 0.05, `${solver}, ${pressed ? 'pressed' : 'released'}: NO ${vNo.toFixed(3)} V, NC ${vNc.toFixed(3)} V`);
    }
  }

  // ---- board text keeps the designer's font height (small boards use < 1 mm) ----
  {
    const b = board(`(gr_text "GPIO23" (at 10 10) (layer "F.SilkS") (effects (font (size 0.762 0.762) (thickness 0.15))))
      (gr_text "REV A" (at 20 10) (layer "F.SilkS"))`);
    assert(b.texts.find((x) => x.text === 'GPIO23')?.size === 0.762 && b.texts.find((x) => x.text === 'REV A')?.size === 1.4, 'text height from (effects (font (size …))), 1.4 mm when the file gives none');
  }

  // ---- part bodies: SMD parts are chips, outlines come from the fabrication layer ----
  {
    const fab = '(fp_rect (start -3 -2) (end 7 2) (layer "F.Fab") (width 0.1))';
    const b = board(`${fp('R5', '10k', '10 10 0', pad('1', '-0.5 0', 4) + pad('2', '0.5 0', 4))}
      ${fp('J5', 'CONN', '30 20 0', pad('1', '0 0', 2) + pad('2', '1 0', 2), fab)}`);
    const r = get(b, 'R5'), j = get(b, 'J5');
    assert(r.body.shape !== 'axial' && r.body.w < 2 && r.body.z < 1, `an SMD resistor is a small chip, not an axial THT body: ${JSON.stringify(r.body)}`);
    assert(Math.abs(j.body.w - 10) < 0.01 && Math.abs(j.body.h - 4) < 0.01 && Math.abs((j.body.off?.[0] ?? 0) - 2) < 0.01,
      `body sized from the F.Fab outline, off-centre offset kept: ${JSON.stringify(j.body)}`);
  }

  // ---- through-hole bodies sit over their pins, not on a pin-1 origin ----
  {
    const tht = (name: string, at: string, net: number) => `(pad "${name}" thru_hole rect (at ${at}) (size 1.7 1.7) (drill 1) (layers "*.Cu") (net ${net} ${NETS[net]}))`;
    // a 1×4 header (origin on pin 1) and a 3-pin microswitch in one row, origin on its middle pin
    const b = board(`${fp('J9', 'CONN', '10 10 0', tht('1', '0 0', 2) + tht('2', '0 2.54', 2) + tht('3', '0 5.08', 2) + tht('4', '0 7.62', 2))}
      ${fp('SW2', 'SW', '30 20 0', tht('1', '0 -5.08', 2) + tht('2', '0 0', 4) + tht('3', '0 5.08', 4) + tht('4', '0 10.16', 4))}`);
    const j = get(b, 'J9'), sw = get(b, 'SW2');
    // KiCad y points down, the board's up: pins at local y 0 … -7.62, so the body centre is at -3.81
    assert(Math.abs(j.body.off?.[0] ?? 0) < 0.01 && Math.abs((j.body.off?.[1] ?? 0) + 3.81) < 0.01, `header body centred on its pins: ${JSON.stringify(j.body)}`);
    assert(sw.body.shape === 'tactile' && Math.abs((sw.body.off?.[1] ?? 0) + 2.54) < 0.01, `switch body centred on its pins: ${JSON.stringify(sw.body)}`);
    assert(sw.body.h >= 15.24 + 1.7 - 0.01 && sw.body.w > 4 && sw.body.w < sw.body.h * 0.5, `a one-row switch covers every pin and is long, not square: ${JSON.stringify(sw.body)}`);
  }

  // ---- abutting pads of one footprint on one net are one piece of copper (USB-C A4/B9 VBUS) ----
  {
    // J7: A4 and B9 (both +5V) 0.3 mm wide at 0.3 mm pitch, edges touching; A5 (EN5) touches B9 on
    // the other side. Only A4 is routed. Real sizes: before, the 0.4 mm floor let the track reach B9.
    const b = board(`${fp('J7', 'USB_C', '20 20 0', pad('A4', '0 0', 7, 'F.Cu', '0.3 1.15') + pad('B9', '0.3 0', 7, 'F.Cu', '0.3 1.15') + pad('A5', '0.6 0', 8, 'F.Cu', '0.3 1.15'))}
      (segment (start 20 20) (end 20 30) (width 0.2) (layer "F.Cu") (net 7))
      ${fp('R9', '10k', '21 30 0', pad('1', '-1 0', 7) + pad('2', '1 0', 2))}`);
    const conn = buildConnectivity(b), j = get(b, 'J7');
    const padNet = (name: string) => conn.net[conn.padItem.get(j)![j.pads.findIndex((p) => p.name === name)]]; // connector pads have no roles
    assert(padNet('B9') === pinNet(conn, get(b, 'R9'), '1') && padNet('A4') === padNet('B9'), 'B9 joins A4 through their touching copper');
    assert(padNet('A5') !== padNet('B9'), 'a touching pad of another net in the same footprint is not joined');
  }

  // ---- a fiducial is a copper dot with no body; a test pad is a test point ----
  {
    const b = importScenarioOrPcb('t.kicad_pcb', `(kicad_pcb (version 20221018) ${netTable} ${edge}
      (footprint "OLIMEX_Other-FP:Fiducial1x3" (layer "F.Cu") (at 5 5 0) (property "Reference" "FID1") (property "Value" "FID") ${pad('Fid1', '0 0', 0, 'F.Cu', '1 1')})
      (footprint "OLIMEX_Other-FP:TESTPAD_40-ROUND" (layer "F.Cu") (at 9 5 0) (property "Reference" "GND1") (property "Value" "GND") ${pad('1', '0 0', 2, 'F.Cu', '1 1')}))`).board;
    assert(get(b, 'FID1').body.shape === 'none', `a fiducial has no body: ${JSON.stringify(get(b, 'FID1').body)}`);
    assert(get(b, 'GND1').kind === 'testpoint', `a TESTPAD footprint is a test point: ${get(b, 'GND1').kind}`);
  }

  console.log('KICAD TESTS PASSED (90° rotation, inner planes, thermal reliefs, dnp, ESD/TVS/dual diodes, ferrites, library values, rail names, bench supply, fab-outline bodies, through-hole bodies over their pins, abutting same-net pads, fiducials and test pads)');
}

run();
