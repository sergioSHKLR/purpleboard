// Author Studio fault helpers (applicable classes, listing, removal) and the flag-lock tokens
// that make non-wiring faults mandatory to repair. Synthetic board: no board-specific data.
import type { Board, Component, ComponentKind } from '../src/types';
import { buildConnectivity } from '../src/connectivity';
import { applicableFaults, clearFault, injectFault, listFaults, rng, severityHint, type FaultClass } from '../src/faults';
import { settleIntermittents, updateIntermittents } from '../src/intermittent';
import { addJumper, installPart, toggleCold } from '../src/ops';
import { padWorld } from '../src/model';
import { cleanWithIpa, residueNear } from '../src/residue';
import { topology } from '../src/crypto';
import { simulateSpice } from '../src/spice/adapter';

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
const mk = (): Board => (x0 = 0, {
  w: 120, h: 30, thickness: 1.0, traces: [], vias: [], blobs: [], jumpers: [], zones: [], silk: [], texts: [], nextId: 1,
  components: [
    part('J1', 'battery', ['P5V', 'GND'], 5, { '+': '1', '-': '2' }),
    part('R1', 'resistor', ['P5V', 'OUT'], 10e3),
    part('R2', 'resistor', ['OUT', 'GND'], 10e3),
    part('C1', 'capacitor', ['OUT', 'GND'], 1e-6),
    part('U1', 'ic', ['P5V', 'OUT', 'GND', 'NC1']),
    part('TP1', 'testpoint', ['OUT'], 0, { '1': '1' }),
  ],
});
const get = (b: Board, ref: string) => b.components.find((c) => c.ref === ref)!;
const topo = (b: Board) => topology(b, buildConnectivity(b), 'test');
const vOut = (b: Board) => { const conn = buildConnectivity(b); const s = simulateSpice(b, conn); const k = s.nodeOfNet.get(conn.netNames.indexOf('OUT')); return k === undefined ? null : s.V[k]; };
const clean = (c: Component) => !c.state.leak && c.state.drift === undefined && !c.state.coldOhms && !c.state.intermittent && !c.state.cold.length && !c.state.burnt;

function run() {
  // ---- applicable classes follow part kind and pad count ----
  {
    const b = mk();
    const cap = applicableFaults(get(b, 'C1')), res = applicableFaults(get(b, 'R2')), ic = applicableFaults(get(b, 'U1')), tp = applicableFaults(get(b, 'TP1'));
    assert(cap.includes('mlcc-dead-short') && cap.includes('cap-capacitance-loss') && !cap.includes('resistor-drift'), 'capacitor classes');
    assert(res.includes('resistor-drift') && !res.includes('mlcc-dead-short'), 'resistor classes');
    assert(ic.includes('liquid-leakage') && ic.includes('thermal-open-joint') && !ic.includes('resistor-drift'), 'IC classes');
    assert(!tp.includes('liquid-leakage') && !tp.includes('thermal-leak') && tp.includes('cold-joint'), 'single-pad part: no two-terminal leaks');
    for (const cls of [...cap, ...res, ...ic]) { const h = severityHint(cls); assert(cls === 'net-break' ? h === null : !!h && h.min < h.max, `${cls}: severity hint range`); }
  }

  // ---- every applicable class: inject → listed → cleared back to the reference ----
  for (const ref of ['R2', 'C1', 'U1', 'TP1']) {
    for (const cls of applicableFaults(get(mk(), ref))) {
      for (const flex of [0, 1]) {
        const b = mk();
        const ref0 = topo(b);
        const c = get(b, ref);
        const f = injectFault(c, cls as FaultClass, rng(11), {});
        updateIntermittents(b, { partTemp: () => 80, flexAt: () => flex }); // hot, flexed or not: exercise active states
        const listed = listFaults(c);
        assert(listed.length >= 1, `${ref} ${cls}: fault listed (${f.describe})`);
        assert(topo(b) !== ref0, `${ref} ${cls}: fault blocks the flag topology`);
        for (const e of [...listed].reverse()) clearFault(c, e.key); // reverse: int:<i> indices stay valid
        assert(listFaults(c).length === 0, `${ref} ${cls}: all faults removed`);
        assert(clean(c), `${ref} ${cls}: state clean after removal (${JSON.stringify(c.state)})`);
        assert(topo(b) === ref0, `${ref} ${cls}: topology back to reference`);
      }
    }
  }

  // ---- active intermittent: listed once, removal restores the circuit ----
  {
    const b = mk();
    const r2 = get(b, 'R2');
    injectFault(r2, 'flex-close-joint', rng(1), { pad: 1, severity: 0.5 });
    settleIntermittents(b); // at rest the joint is open
    assert(r2.state.cold.includes(1), 'flex-close starts open');
    const l = listFaults(r2);
    assert(l.length === 1 && l[0].key === 'int:0' && /now active/.test(l[0].label), `one entry for the active intermittent: ${JSON.stringify(l)}`);
    near(vOut(b), 5, 1e-3, 'open bottom leg');
    clearFault(r2, 'int:0');
    near(vOut(b), 2.5, 1e-3, 'removing the intermittent recloses the joint');
  }

  // ---- flag lock: dormant / value faults must be repaired the way a player would ----
  {
    const b = mk(); const ref0 = topo(b);
    injectFault(get(b, 'R2'), 'resistor-drift', rng(1), { severity: 1.05 }); // objectives may not notice 5 %
    assert(topo(b) !== ref0, 'drift blocks the flag');
    installPart(get(b, 'R2'), { value: 10e3 });
    assert(topo(b) === ref0, 'replacing the part restores it');
  }
  {
    const b = mk(); const ref0 = topo(b);
    injectFault(get(b, 'R2'), 'thermal-open-joint', rng(1), { pad: 0, severity: 60 });
    settleIntermittents(b); // dormant at 25 °C: circuit works, verification would pass
    near(vOut(b), 2.5, 1e-3, 'dormant joint conducts');
    assert(topo(b) !== ref0, 'dormant cracked joint still blocks the flag');
    toggleCold(get(b, 'R2'), 0); // reflow
    assert(topo(b) === ref0, 'reflowing the joint repairs it');
  }
  {
    const b = mk(); const ref0 = topo(b);
    injectFault(get(b, 'C1'), 'thermal-leak', rng(1), { severity: 50 });
    settleIntermittents(b);
    assert(topo(b) !== ref0, 'dormant thermal leak blocks the flag');
    installPart(get(b, 'C1'), { value: 1e-6 });
    assert(topo(b) === ref0, 'replacing the cap repairs it');
  }
  {
    const b = mk(); const ref0 = topo(b);
    injectFault(get(b, 'C1'), 'mlcc-dead-short', rng(1));
    assert(topo(b) !== ref0, 'leak blocks the flag');
    installPart(get(b, 'C1'), { value: 1e-6 });
    assert(topo(b) === ref0, 'replacing the cap clears the leak');
  }

  // ---- broken copper on a name-connected net: splits it; reflow does not help, a jumper does ----
  {
    const b = mk(); const ref0 = topo(b);
    const r2 = get(b, 'R2'), tp1 = get(b, 'TP1');
    const net = (c: Component, pi: number) => { const cn = buildConnectivity(b); return cn.net[cn.padItem.get(c)![pi]]; };
    assert(net(r2, 0) === net(tp1, 0), 'OUT connects R2 and TP1');
    const f = injectFault(r2, 'net-break', rng(1), { pad: 0 });
    assert(net(r2, 0) !== net(tp1, 0), `break cuts R2's branch off the rest of OUT (${f.describe})`);
    assert(net(r2, 0) === net(get(b, 'R1'), 1), "R2's local branch (R1.2, its nearest pin) stays together");
    assert(topo(b) !== ref0, 'broken copper blocks the flag');
    assert(listFaults(r2).some((e) => e.key === 'break:0'), 'listed for the author');
    toggleCold(r2, 0); toggleCold(r2, 0); // reflow twice (open, then good again)
    assert(net(r2, 0) !== net(tp1, 0), 'reflowing the joint does not repair copper');
    installPart(r2, { value: 10e3 });
    assert(net(r2, 0) !== net(tp1, 0) && r2.state.netBreak?.length === 1, 'a new part does not repair copper either');
    const pr = padWorld(r2, r2.pads[0]).at, pt = padWorld(tp1, tp1.pads[0]).at;
    addJumper(b, pr, 'F', pt, 'F');
    assert(net(r2, 0) === net(tp1, 0), 'a jumper wire bridges the break');
    assert(topo(b) === ref0, 'jumpered board matches the reference: flag unlocks');
  }

  // ---- liquid residue: visible, thins with each IPA scrub, the leak goes with it ----
  {
    const b = mk(); const ref0 = topo(b);
    const c1 = get(b, 'C1');
    injectFault(c1, 'liquid-leakage', rng(4), { severity: 1000 });
    assert(c1.state.residue?.amount === 1 && c1.state.residue.leaky, 'liquid leak leaves visible ionic residue');
    const v0 = vOut(b)!;
    assert(!residueNear(b, c1.at[0] + 30, c1.at[1], 2), 'scrubbing elsewhere touches nothing');
    let passes = 0;
    while (c1.state.residue && passes < 10) {
      const ohms = c1.state.leak!.ohms;
      cleanWithIpa(b, c1.at[0], c1.at[1], 2); passes++;
      if (c1.state.residue) assert(c1.state.leak!.ohms > ohms, 'thinner film, higher leakage resistance');
    }
    assert(passes >= 3 && passes <= 5 && !c1.state.leak, `a few passes clean it (${passes})`);
    assert(vOut(b)! > v0 + 0.5, `the divider recovers once clean (${v0.toFixed(2)} → ${vOut(b)!.toFixed(2)} V)`);
    assert(topo(b) === ref0, 'clean board unlocks the flag');
    // corroded copper: cleaning removes the crust, not the break
    const r2 = get(b, 'R2');
    injectFault(r2, 'net-break', rng(1), { pad: 0 });
    assert(!!r2.state.residue && !r2.state.residue.leaky, 'corrosion visible at the broken pin');
    for (let k = 0; k < 5; k++) cleanWithIpa(b, r2.at[0], r2.at[1], 2);
    assert(!r2.state.residue && r2.state.netBreak?.length === 1, 'cleaned, but the copper is still broken');
  }

  console.log('AUTHORING TESTS PASSED (applicable classes, inject → list → remove for every class, flag lock needs dormant/value faults repaired)');
}

run();
