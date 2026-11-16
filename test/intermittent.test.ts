// Intermittent faults driven by temperature and board flex.
import type { Board, Component, ComponentKind } from '../src/types';
import { buildConnectivity } from '../src/connectivity';
import { FlexField, settleIntermittents, updateIntermittents, type Environment } from '../src/intermittent';
import { injectFault, rng } from '../src/faults';
import { installPart, toggleCold } from '../src/ops';
import { simulateSpice } from '../src/spice/adapter';
import { ThermalModel } from '../src/thermal';
import { normalizeBoard } from '../src/io/format';

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const near = (a: number | null | undefined, b: number, t: number, m: string) => assert(a != null && Math.abs(a - b) <= t, `${m}: expected ${b} ± ${t}, got ${a}`);

let x0 = 0;
function part(ref: string, kind: ComponentKind, nets: string[], value = 0, pins: Record<string, string> = { '1': '1', '2': '2' }): Component {
  x0 += 12;
  return {
    id: ref, ref, kind, value, at: [x0, 15], rot: 0, side: 'F',
    pads: nets.map((n, i) => ({ name: String(i + 1), at: [i * 1.0 - 0.5, 0], size: [0.6, 0.5], shape: 'rect', layers: 'F', net: n })),
    pins, body: { shape: 'box', w: 1, h: 0.5, z: 0.5 }, state: { populated: true, reversed: false, burnt: false, cold: [] },
  };
}
const mk = (r2Ohms = 10e3): Board => (x0 = 0, {
  w: 80, h: 30, thickness: 1.0, traces: [], vias: [], blobs: [], jumpers: [], zones: [], silk: [], texts: [], nextId: 1,
  components: [part('J1', 'battery', ['P5V', 'GND'], 5, { '+': '1', '-': '2' }), part('R1', 'resistor', ['P5V', 'OUT'], 10e3), part('R2', 'resistor', ['OUT', 'GND'], r2Ohms)],
});
const vOut = (b: Board) => { const conn = buildConnectivity(b); const s = simulateSpice(b, conn); const k = s.nodeOfNet.get(conn.netNames.indexOf('OUT')); return k === undefined ? null : s.V[k]; };
const env = (temp: number, flex = 0): Environment => ({ partTemp: () => temp, flexAt: () => flex });

function run() {
  // ---- thermal-open with hysteresis ----
  {
    const b = mk();
    const r2 = b.components.find((c) => c.ref === 'R2')!;
    injectFault(r2, 'thermal-open-joint', rng(1), { pad: 1, severity: 50 });
    r2.state.intermittent![0].hysteresis = 8;
    near(vOut(b), 2.5, 1e-3, 'cold board works');
    assert(updateIntermittents(b, env(55)).includes('R2'), 'warm part: joint opens');
    near(vOut(b), 5, 1e-3, 'joint open: divider bottom lost');
    assert(updateIntermittents(b, env(45)).length === 0, 'inside hysteresis band: no change');
    assert(updateIntermittents(b, env(41)).includes('R2'), 'cooled below threshold − hysteresis: recloses');
    near(vOut(b), 2.5, 1e-3, 'works again when cool');
    // serialisation
    const nb = normalizeBoard(JSON.parse(JSON.stringify(b)));
    assert(nb.components.find((c) => c.ref === 'R2')!.state.intermittent?.[0].kind === 'thermal-open', 'intermittent spec survives save/load');
  }

  // ---- flex-close: only conducts while pressed ----
  {
    const b = mk();
    const r2 = b.components.find((c) => c.ref === 'R2')!;
    injectFault(r2, 'flex-close-joint', rng(2), { pad: 0, severity: 0.5 });
    settleIntermittents(b);
    near(vOut(b), 5, 1e-3, 'at rest the joint is open');
    const flex = new FlexField();
    flex.press(r2.at[0], r2.at[1], { duration: 1 });
    updateIntermittents(b, { partTemp: () => 25, flexAt: (x, y) => flex.at(x, y) });
    near(vOut(b), 2.5, 1e-3, 'pressing on the part makes contact');
    flex.advance(1.5);
    updateIntermittents(b, { partTemp: () => 25, flexAt: (x, y) => flex.at(x, y) });
    near(vOut(b), 5, 1e-3, 'released: open again');
    const far = new FlexField(); far.press(r2.at[0] + 60, r2.at[1], { radius: 8 });
    updateIntermittents(b, { partTemp: () => 25, flexAt: (x, y) => far.at(x, y) });
    near(vOut(b), 5, 1e-3, 'pressing far away does nothing (localisation)');
    toggleCold(r2, 0);
    settleIntermittents(b);
    near(vOut(b), 2.5, 1e-3, 'reflow repairs the cracked joint');
    assert(!r2.state.intermittent, 'reflow removes the intermittent fault');
  }

  // ---- full physical loop: self-heating opens a cracked joint, freeze spray restores it ----
  {
    const b = mk(25); // R2 = 25 Ω across ~5 V through R1 10k → small; give R2 its own heat via a stiff divider
    b.components.find((c) => c.ref === 'R1')!.value = 25; // 0.25 W in R2
    const r2 = b.components.find((c) => c.ref === 'R2')!;
    injectFault(r2, 'thermal-open-joint', rng(3), { pad: 1, severity: 45 });
    const th = new ThermalModel(b);
    let failedAt = -1, recovered = false;
    for (let k = 0; k < 600; k++) {
      const conn = buildConnectivity(b);
      const sim = simulateSpice(b, conn);
      th.setPower(new Map(b.components.map((c) => [c.id, c.kind === 'battery' ? 0 : sim.comps.get(c.id)?.p ?? 0])));
      th.step(0.1);
      updateIntermittents(b, { partTemp: (id) => th.partTemp(id), flexAt: () => 0 });
      if (failedAt < 0 && r2.state.intermittent![0].active) {
        failedAt = k * 0.1;
        th.freezeSpray(r2.at[0], r2.at[1], 6);
      } else if (failedAt >= 0 && !r2.state.intermittent![0].active) { recovered = true; break; }
    }
    assert(failedAt >= 0, 'self-heating opens the cracked joint (an 0402 reaches temperature in ~0.1 s)');
    assert(recovered, 'freeze spray brings the joint back');
    installPart(r2, { value: 25 });
    assert(!r2.state.intermittent && !r2.state.cold.length, 'replacement clears every fault on the part');
  }
  console.log('INTERMITTENT TESTS PASSED (thermal hysteresis, flex-open/close with localisation, self-heating failure + freeze-spray recovery, repairs)');
}

run();
