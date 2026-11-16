// Fault-severity models and the multimeter model.
import type { Board, Component, ComponentKind } from '../src/types';
import { buildConnectivity } from '../src/connectivity';
import { FAULT_RANGES, injectFault, rng, sampleSeverity } from '../src/faults';
import { installPart, removePart, toggleCold } from '../src/ops';
import { AMMETER_SHUNT, displayAmps, displayVolts, measureCapDmm, measureDiodeDmm, measureOhmsDmm } from '../src/spice/dmm';
import { simulateSpice } from '../src/spice/adapter';
import { normalizeBoard } from '../src/io/format';

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const near = (a: number | null | undefined, b: number, t: number, m: string) => assert(a != null && Math.abs(a - b) <= t, `${m}: expected ${b} ± ${t}, got ${a}`);

let x0 = 0;
function part(ref: string, kind: ComponentKind, nets: string[], value = 0, pins: Record<string, string> = { '1': '1', '2': '2' }): Component {
  x0 += 10;
  return {
    id: ref, ref, kind, value, at: [x0, 10], rot: 0, side: 'F',
    pads: nets.map((n, i) => ({ name: String(i + 1), at: [i * 1.5, 0], size: [0.6, 0.6], shape: 'rect', layers: 'F', net: n })),
    pins, body: { shape: 'box', w: 1, h: 1, z: 0.5 }, state: { populated: true, reversed: false, burnt: false, cold: [] },
  };
}
const boardOf = (comps: Component[]): Board => ({ w: 300, h: 30, thickness: 1.6, components: comps, traces: [], vias: [], blobs: [], jumpers: [], zones: [], silk: [], texts: [], nextId: 1 });

function run() {
  // ---- severity sampling: deterministic, inside the documented ranges ----
  for (const [cls, f] of Object.entries(FAULT_RANGES)) {
    const a = sampleSeverity(cls as keyof typeof FAULT_RANGES, rng(7)), b = sampleSeverity(cls as keyof typeof FAULT_RANGES, rng(7));
    assert(a === b, `${cls}: same seed → same severity`);
    for (let k = 0; k < 50; k++) {
      const v = sampleSeverity(cls as keyof typeof FAULT_RANGES, rng(k));
      assert(v >= f.min * 0.999 && v <= f.max * 1.001, `${cls}: ${v} within [${f.min}, ${f.max}]`);
    }
  }

  // ---- board: 5 V → R1 10k → OUT → R2 10k → GND, C1 on OUT, D1 OUT→GND reversed (clamp), U1 IC ----
  const mk = () => boardOf([
    part('J1', 'battery', ['P5V', 'GND'], 5, { '+': '1', '-': '2' }),
    part('R1', 'resistor', ['P5V', 'OUT'], 10e3),
    part('R2', 'resistor', ['OUT', 'GND'], 10e3),
    part('C1', 'capacitor', ['OUT', 'GND'], 1e-6),
    part('U1', 'ic', ['P5V', 'SIG', 'GND']),
    part('R3', 'resistor', ['SIG', 'GND'], 1e6),
  ]);
  const V = (b: Board, net: string) => { const conn = buildConnectivity(b); const s = simulateSpice(b, conn); const k = s.nodeOfNet.get(conn.netNames.indexOf(net)); return k === undefined ? null : s.V[k]; };
  near(V(mk(), 'OUT'), 2.5, 1e-3, 'healthy divider');

  // leak across the cap: OUT pulled down by the fault resistance
  { const b = mk(); injectFault(b.components.find((c) => c.ref === 'C1')!, 'cap-partial-short', rng(1), { severity: 10e3 }); near(V(b, 'OUT'), 5 / 3, 0.01, 'leak = 10k in parallel with R2'); }
  // drift: R2 ×3 → 3.75 V
  { const b = mk(); injectFault(b.components.find((c) => c.ref === 'R2')!, 'resistor-drift', rng(1), { severity: 3 }); near(V(b, 'OUT'), 3.75, 0.01, 'R2 drifted ×3'); }
  // resistive cold joint on R2 pad 2 (10k in series) → 3.333 V; open cold joint → 5 V
  { const b = mk(); injectFault(b.components.find((c) => c.ref === 'R2')!, 'cold-joint', rng(1), { severity: 10e3, pad: 1 }); near(V(b, 'OUT'), 10 / 3, 0.01, 'resistive cold joint'); }
  { const b = mk(); const r2 = b.components.find((c) => c.ref === 'R2')!; toggleCold(r2, 1); near(V(b, 'OUT'), 5, 0.01, 'open cold joint floats R2'); }
  // repairs clear the parametric faults
  { const b = mk(); const r2 = b.components.find((c) => c.ref === 'R2')!; injectFault(r2, 'resistor-drift', rng(1)); installPart(r2, { value: 10e3 }); assert(r2.state.drift === undefined, 'replacement clears drift'); }
  { const b = mk(); const r2 = b.components.find((c) => c.ref === 'R2')!; injectFault(r2, 'cold-joint', rng(1), { pad: 0 }); toggleCold(r2, 0); assert(!r2.state.coldOhms && !r2.state.cold.length, 'reflow clears a resistive cold joint'); }
  // serialisation keeps the fault parameters
  { const b = mk(); injectFault(b.components.find((c) => c.ref === 'C1')!, 'liquid-leakage', rng(3)); const nb = normalizeBoard(JSON.parse(JSON.stringify(b))); assert(nb.components.find((c) => c.ref === 'C1')!.state.leak?.ohms === b.components.find((c) => c.ref === 'C1')!.state.leak!.ohms, 'leak survives save/load'); }

  // ---- meter ----
  assert(displayVolts(3.3).text === '3.300 V' && displayVolts(12.3456).text === '12.35 V' && displayVolts(0.1234).text === '123.4 mV', `voltage ranges: ${displayVolts(3.3).text} ${displayVolts(12.3456).text} ${displayVolts(0.1234).text}`);
  {
    const b = mk(); b.components = b.components.filter((c) => c.ref !== 'J1');
    const conn = buildConnectivity(b), n = (x: string) => conn.netNames.indexOf(x);
    // OUT→GND in circuit: R2 ∥ (R1 + ESD-less path through P5V…) — R1 dangles, so ≈ 10 kΩ, plus leads
    const r = measureOhmsDmm(b, conn, n('OUT'), n('GND'));
    near(r.value, 10e3, 30, `in-circuit 10k reads 10k (${r.text}, ${r.range})`);
    const short = measureOhmsDmm(b, conn, n('GND'), n('GND'));
    assert(short.value! > 0.2 && short.value! < 1.5 && short.beep, `probes together read lead + contact resistance with beep (${short.text})`);
    // generic ESD: red on GND, black on an IC pin net → a junction drop; reversed → OL
    const esd = measureDiodeDmm(b, conn, n('GND'), n('SIG'));
    assert(esd.value !== null && esd.value > 0.35 && esd.value < 0.75, `ESD diode reading to ground (${esd.text})`);
    assert(measureDiodeDmm(b, conn, n('SIG'), n('GND')).value === null || measureDiodeDmm(b, conn, n('SIG'), n('GND')).value! > 0.9, 'reverse direction does not show a junction');
    // determinism: same placement → same text
    assert(measureOhmsDmm(b, conn, n('OUT'), n('GND'), { seed: 'p1' }).text === measureOhmsDmm(b, conn, n('OUT'), n('GND'), { seed: 'p1' }).text, 'stable reading per placement');
  }
  // ---- capacitance mode: in circuit vs lifted, shorted ----
  {
    const b = mk(); const conn = buildConnectivity(b);
    const n = (x: string) => conn.netNames.indexOf(x);
    const inCircuit = measureCapDmm(b, conn, n('OUT'), n('GND'), { seed: 's1' });
    assert(inCircuit.value !== null && inCircuit.value > 1.4e-6 && /parallel/.test(inCircuit.sub ?? ''), `in circuit, R2 (10 kΩ) inflates 1 µF: ${inCircuit.text} — ${inCircuit.sub}`);
    removePart(b.components.find((c) => c.ref === 'R2')!);
    const c2 = buildConnectivity(b);
    const lifted = measureCapDmm(b, c2, c2.netNames.indexOf('OUT'), c2.netNames.indexOf('GND'), { seed: 's1' });
    near(lifted.value, 1e-6, 0.035e-6, `with the parallel resistor lifted the meter reads the cap (${lifted.text})`);
    assert(/µF/.test(lifted.text), `auto-ranged to µF: ${lifted.text}`);
    injectFault(b.components.find((c) => c.ref === 'C1')!, 'mlcc-dead-short', rng(1), { severity: 0.1 });
    const shorted = measureCapDmm(b, c2, c2.netNames.indexOf('OUT'), c2.netNames.indexOf('GND'), { seed: 's1' });
    assert(shorted.text === 'OL' && /cannot be measured/.test(shorted.sub ?? ''), `a shorted cap cannot be measured: ${shorted.text} ${shorted.sub}`);
  }

  // ---- current mode: the meter in series across a lifted part ----
  {
    const b = mk();
    removePart(b.components.find((c) => c.ref === 'R1')!); // lift R1, meter across its pads
    const conn = buildConnectivity(b);
    const s = simulateSpice(b, conn, { ammeter: { a: conn.netNames.indexOf('P5V'), b: conn.netNames.indexOf('OUT'), ohms: AMMETER_SHUNT + 0.3 } }) as { ammeterAmps?: number };
    near(s.ammeterAmps, 5 / 10e3, 2e-6, 'series current = 5 V / R2');
    const d = displayAmps(s.ammeterAmps!);
    assert(/^0\.5 mA$/.test(d.text), `shown on the 600 mA range: ${d.text}`);
    assert(displayAmps(12).text === 'OL', 'above 10 A: OL');
  }

  console.log('REALISM TESTS PASSED (fault severities, leak/drift/resistive cold joints in SPICE, meter ranges, contact resistance, ESD diode signature, capacitance in/out of circuit, ammeter in series)');
}

run();
