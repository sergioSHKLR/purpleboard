// Thermal model: conservation and the bench short-finding workflow.
import type { Board, Component, ComponentKind } from '../src/types';
import { buildConnectivity } from '../src/connectivity';
import { EMISSIVITY, ThermalModel, THERMAL_DEFAULTS, apparentTemp } from '../src/thermal';
import { simulateSpice, type SpiceSim } from '../src/spice/adapter';
import { injectFault, rng } from '../src/faults';

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

let x0 = 0;
function part(ref: string, kind: ComponentKind, nets: string[], value = 0, at?: [number, number]): Component {
  x0 += 6;
  return {
    id: ref, ref, kind, value, at: at ?? [x0, 20], rot: 0, side: 'F',
    pads: nets.map((n, i) => ({ name: String(i + 1), at: [i * 1.0 - 0.5, 0], size: [0.6, 0.5], shape: 'rect', layers: 'F', net: n })),
    pins: { '1': '1', '2': '2' }, body: { shape: 'box', w: 1.0, h: 0.5, z: 0.5 }, state: { populated: true, reversed: false, burnt: false, cold: [] },
  };
}
const boardOf = (comps: Component[]): Board => ({ w: 80, h: 40, thickness: 1.0, components: comps, traces: [], vias: [], blobs: [], jumpers: [], zones: [], silk: [], texts: [], nextId: 1 });

function run() {
  // ---- conservation: at steady state the power in leaves through the surfaces ----
  {
    const r = part('R1', 'resistor', ['A', 'B'], 100, [40, 20]);
    const b = boardOf([r]);
    const m = new ThermalModel(b);
    m.setPower(new Map([['R1', 0.25]]));
    m.settle(3000, 1e-4);
    const amb = THERMAL_DEFAULTS.ambient;
    let loss = 0;
    for (const t of m.T) loss += 2 * THERMAL_DEFAULTS.hAir * m.dx * m.dx * (t - amb);
    loss += THERMAL_DEFAULTS.hAir * 1.0 * 0.5 * 1e-6 * (m.partTemp('R1')! - amb);
    assert(Math.abs(loss - 0.25) / 0.25 < 0.05, `steady state: power out ${loss.toFixed(4)} W ≈ power in 0.25 W`);
    // part rise over the board under it ≈ P / G_joint (0402-class: ~150 K/W)
    const rise = m.partTemp('R1')! - m.tempAt(40, 20);
    const g = THERMAL_DEFAULTS.hJoint * 2 * 0.6 * 0.5 * 1e-6;
    assert(Math.abs(rise - 0.25 / g) / (0.25 / g) < 0.15, `part-to-board rise ${rise.toFixed(1)} K ≈ P/G = ${(0.25 / g).toFixed(1)} K`);
  }

  // ---- bench workflow: 6 identical caps on a rail, one shorted; inject, then find it ----
  const caps = [0, 1, 2, 3, 4, 5].map((k) => part(`C${k + 1}`, 'capacitor', ['PP3V3_S5', 'GND'], 1e-6, [15 + k * 8, 20]));
  const b = boardOf([...caps, part('R9', 'resistor', ['PP3V3_S5', 'X'], 10e3, [10, 30])]);
  const victim = caps[3];
  injectFault(victim, 'mlcc-dead-short', rng(5));
  const conn = buildConnectivity(b);
  const sim = simulateSpice(b, conn, { inject: { net: conn.netNames.indexOf('PP3V3_S5'), volts: 1, amps: 3 } }) as SpiceSim;
  assert(sim.injected && sim.injected.i > 0.4 && sim.injected.i <= 3.03, `injection current within the limit (${sim.injected?.i.toFixed(2)} A)`);
  const pw = new Map<string, number>();
  for (const c of b.components) { const p = sim.comps.get(c.id)?.p ?? 0; if (p > 0) pw.set(c.id, p); }
  assert((pw.get(victim.id) ?? 0) > 0.3, `the shorted cap dissipates the injected power (${pw.get(victim.id)?.toFixed(3)} W)`);
  {
    const strong = structuredClone(b);
    injectFault(strong.components.find((c) => c.ref === 'C2')!, 'mlcc-dead-short', rng(1), { severity: 0.05 });
    const sc = buildConnectivity(strong);
    const s2 = simulateSpice(strong, sc, { inject: { net: sc.netNames.indexOf('PP3V3_S5'), volts: 1, amps: 3 } }) as SpiceSim;
    assert(s2.ccLimited && Math.abs(s2.injected!.i - 3) < 0.05, `a harder short hits the 3 A current limit (${s2.injected!.i.toFixed(2)} A)`);
  }
  const fresh = () => { const m = new ThermalModel(b); m.setPower(pw); m.step(8); return m; };
  {
    const m = fresh();
    assert(m.hottestPart()!.c.ref === victim.ref, `thermal camera: hottest part is the short (${m.hottestPart()!.c.ref} ${m.hottestPart()!.T.toFixed(1)} °C)`);
  }
  const race = (apply: (m: ThermalModel) => void, done: (m: ThermalModel, id: string) => boolean) => {
    const m = fresh(); apply(m);
    for (let k = 0; k < 2400; k++) { m.step(0.05); const hit = caps.find((c) => done(m, c.id)); if (hit) return hit.ref; }
    return null;
  };
  const cx = 15 + 2.5 * 8;
  const defrost = race((m) => m.freezeSpray(cx, 20, 30), (m, id) => m.partSurface(id).frost === 0);
  assert(defrost === victim.ref, `freeze spray: first part to defrost is the short (got ${defrost})`);
  const dry = race((m) => m.applyIpa(cx, 20, 30), (m, id) => m.partSurface(id).wet === 0);
  assert(dry === victim.ref, `isopropyl: first part to dry is the short (got ${dry})`);
  // no power: frost and film persist much longer and no part is singled out early
  {
    const m = new ThermalModel(b);
    m.freezeSpray(cx, 20, 30); m.step(3);
    assert(caps.every((c) => m.partSurface(c.id).frost > 0), 'unpowered board: frost persists on every part after 3 s');
  }
  // regressions found in the browser: dt = 0 must be a no-op (first animation frame), and spray must
  // coat a part body that sits between distant pads (through-hole axial part)
  {
    const r = part('RX', 'resistor', ['A', 'B'], 100, [40, 20]);
    r.pads[0].at = [-5.08, 0]; r.pads[1].at = [5.08, 0]; r.body = { shape: 'axial', w: 6, h: 2.2, z: 2 };
    const m = new ThermalModel(boardOf([r]));
    m.step(0);
    assert(Number.isFinite(m.partTemp('RX')!) && m.T.every(Number.isFinite), 'step(0) leaves every temperature finite');
    m.freezeSpray(40, 20, 3);
    assert(m.partSurface('RX').frost > 0.9, 'freeze spray frosts the body of an axial part between its pads');
  }
  // ---- IR camera: apparent temperature of grey bodies ----
  {
    assert(Math.abs(apparentTemp(80, 1) - 80) < 1e-9, 'a black body reads its true temperature');
    assert(Math.abs(apparentTemp(25, 0.1) - 25) < 1e-9, 'anything at room temperature reads room temperature');
    const metal = apparentTemp(100, EMISSIVITY.metal), pkg = apparentTemp(100, EMISSIVITY.package);
    assert(metal < 40 && pkg > 90, `a 100 °C solder joint reads ${metal.toFixed(1)} °C, its 100 °C package ${pkg.toFixed(1)} °C`);
  }

  // ---- rosin method: the film melts clear on the hot part only ----
  {
    const m = new ThermalModel(b);
    m.setPower(pw);
    m.applyRosin(40, 20, 40);
    assert(caps.every((c) => m.partSurface(c.id).rosin > 0.99), 'the whole row is coated white');
    m.step(20);
    const melted = caps.filter((c) => m.partSurface(c.id).melted > 0.5).map((c) => c.ref);
    assert(melted.length >= 1 && melted.includes(victim.ref), `rosin melts on the shorted cap first: ${melted}`);
    assert(caps.some((c) => m.partSurface(c.id).rosin > 0.9), 'cool parts keep their white film');
  }

  console.log('THERMAL TESTS PASSED (energy conservation, part thermal resistance, injection CC limit, camera / freeze spray / IPA find the short, IR emissivity, rosin method)');
}

run();
