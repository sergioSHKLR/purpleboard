// KiCad import of real-world multilayer boards: rotation, inner planes, thermal reliefs, DNP,
// protection diodes, library-style values, rail names and the bench supply. Synthetic files.
import { importScenarioOrPcb } from '../src/io/kicad';
import { parseScenario } from '../src/io/format';
import { buildConnectivity, pinNet } from '../src/connectivity';
import { netRole, railVoltage } from '../src/spice/powertree';
import type { Board } from '../src/types';

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

  // ---- fitted / not fitted, protection diodes, ferrites ----
  {
    const b = board(`${fp('R9', 'R_0R_0402', '30 30 0', pad('1', '-1 0', 7) + pad('2', '1 0', 2), '(attr smd dnp)')}
      ${fp('D1', 'ESD5B5_0ST1G', '30 34 0', pad('1', '-1 0', 2) + pad('2', '1 0', 7))}
      ${fp('D2', 'SMBJ33A', '30 36 0', pad('1', '-1 0', 1) + pad('2', '1 0', 2))}
      ${fp('D3', 'BAT54C', '30 38 0', pad('1', '-1 0', 1) + pad('2', '1 0', 7) + pad('3', '0 1', 4))}
      ${fp('FB1', '600R', '40 34 0', pad('1', '-1 0', 1) + pad('2', '1 0', 4))}`);
    assert(!get(b, 'R9').state.populated, 'a dnp footprint is on the board but not fitted');
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

  console.log('KICAD TESTS PASSED (90° rotation, inner planes, thermal reliefs, dnp, ESD/TVS/dual diodes, ferrites, library values, rail names, bench supply, fab-outline bodies)');
}

run();
