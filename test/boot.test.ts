// Power-up on the bench supply: controller-driven power states, estimated rail loads, and the
// boot loop a shorted rail causes. Synthetic board, no board-specific knowledge.
import type { Board, Component, ComponentKind } from '../src/types';
import { buildConnectivity, type Conn } from '../src/connectivity';
import { BootController, BOOT_TIMING, requiredRails } from '../src/boot';
import { discoverPowerTree, type PowerTree } from '../src/spice/powertree';
import { estimateRailLoads, LOAD_W_PER_CAP } from '../src/spice/loads';
import { simulateSpice } from '../src/spice/adapter';
import { applicableFaults, injectFault, rng } from '../src/faults';
import type { PowerStateName } from '../src/spice/sequencer';
import type { Sim } from '../src/sim';

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

let x0 = 0;
function part(ref: string, kind: ComponentKind, nets: string[], value = 0, pins: Record<string, string> = {}): Component {
  x0 += 10;
  return {
    id: ref, ref, kind, value, at: [x0, 10], rot: 0, side: 'F',
    pads: nets.map((n, i) => ({ name: String(i + 1), at: [i * 1.5, 0], size: [0.6, 0.6], shape: 'rect', layers: 'F', net: n })),
    pins, body: { shape: 'box', w: 1, h: 1, z: 0.5 }, state: { populated: true, reversed: false, burnt: false, cold: [] },
  };
}
const two = { '1': '1', '2': '2' };

function mkBoard(): Board {
  x0 = 0;
  const comps: Component[] = [
    part('J1', 'battery', ['PP12V_G3H', 'GND'], 12, { '+': '1', '-': '2' }),
    // always-on LDO (enable pulled up to its input)
    part('U0', 'ic', ['PP12V_G3H', 'PP3V3_G3H', 'P3V3G3H_EN', 'GND']),
    part('R0', 'resistor', ['PP12V_G3H', 'P3V3G3H_EN'], 100e3, two),
    // S5 buck, enable from the controller
    part('U1', 'ic', ['PP12V_G3H', 'P5VS5_SW', 'P5VS5_EN', 'P5VS5_FB', 'GND']),
    part('L1', 'resistor', ['P5VS5_SW', 'PP5V_S5'], 0.02, two),
    // S0 LDO, enable from the controller
    part('U2', 'ic', ['PP5V_S5', 'PP1V8_S0', 'P1V8S0_EN', 'GND']),
  ];
  comps.find((c) => c.ref === 'L1')!.label = 'Inductor';
  // decoupling: a few caps per rail (the load estimate counts them)
  const caps: [string, number][] = [['PP3V3_G3H', 2], ['PP5V_S5', 6], ['PP1V8_S0', 20]];
  for (const [rail, n] of caps) for (let i = 0; i < n; i++) comps.push(part(`C_${rail}_${i}`, 'capacitor', [rail, 'GND'], 1e-6, two));
  return { w: 600, h: 30, thickness: 1.6, components: comps, traces: [], vias: [], blobs: [], jumpers: [], zones: [], silk: [], texts: [], nextId: 1 };
}

const amps = (b: Board, s: Sim) => b.components.filter((c) => c.kind === 'battery').reduce((a, c) => a + Math.max(0, s.comps.get(c.id)?.i ?? 0), 0);

/** Runs the controller against the solver the way the app does, for `seconds` of bench time. */
function powerUp(b: Board, seconds: number) {
  const conn: Conn = buildConnectivity(b);
  const tree: PowerTree = discoverPowerTree(b, conn);
  const ctl = new BootController();
  ctl.powerOn();
  let sim = simulateSpice(b, conn, { powerTree: true, powerState: ctl.state as PowerStateName });
  const seen: { state: string; amps: number }[] = [{ state: ctl.state, amps: amps(b, sim) }];
  const missing = (st: PowerStateName) => requiredRails(tree, st).filter((r) => {
    const k = sim.nodeOfNet.get(conn.netNames.indexOf(r.rail));
    return Math.abs((k === undefined ? 0 : sim.V[k]) - r.v) > 0.1 * r.v;
  }).map((r) => r.rail);
  for (let t = 0; t < seconds; t += 0.05) {
    if (ctl.tick(0.05, amps(b, sim), missing)) {
      sim = simulateSpice(b, conn, { powerTree: true, powerState: ctl.state as PowerStateName });
      seen.push({ state: ctl.state, amps: amps(b, sim) });
    }
  }
  return { ctl, seen, tree, conn };
}

function run() {
  // ---- load estimate: from decoupling count, only on produced rails with a known voltage ----
  {
    const b = mkBoard();
    const conn = buildConnectivity(b);
    const loads = estimateRailLoads(b, conn, discoverPowerTree(b, conn));
    const by = (r: string) => loads.find((l) => l.rail === r);
    assert(by('PP1V8_S0')?.caps === 20 && Math.abs(by('PP1V8_S0')!.watts - 20 * LOAD_W_PER_CAP) < 1e-9, `S0 rail load from 20 caps: ${JSON.stringify(by('PP1V8_S0'))}`);
    assert(!by('PP12V_G3H'), 'the input rail (no producer on the board) carries no estimated load');
  }

  // ---- healthy board: standby, then each state in order, current rising with each step ----
  {
    const b = mkBoard();
    const { ctl, seen, tree } = powerUp(b, 4);
    assert(requiredRails(tree, 'S0').some((r) => r.rail === 'PP1V8_S0'), 'S0 waits for PP1V8_S0');
    assert(ctl.state === 'S0SW' && ctl.failures === 0, `boots to S0 without retries: ${ctl.state}, ${ctl.failures} failures, ${JSON.stringify(seen)}`);
    const order = seen.map((s) => s.state).join('>');
    assert(order === 'G3H>S5>S4>S3>S0>S0SW', `state order ${order}`);
    const a = (st: string) => seen.find((s) => s.state === st)!.amps;
    assert(a('G3H') < a('S5') && a('S5') < a('S0'), `supply current steps up: ${JSON.stringify(seen)}`);
    assert(a('G3H') > 0 && a('G3H') < 0.01, `standby draw is milliamps: ${(a('G3H') * 1e3).toFixed(2)} mA`);
    // the displayed (averaged) current tracks the solved one
    assert(Math.abs(ctl.amps - a('S0SW')) / a('S0SW') < 0.05, `meter settles: ${ctl.amps} vs ${a('S0SW')}`);
  }

  // ---- shorted cap on the S0 rail: controller gives up in S0 and retries (boot loop) ----
  {
    const b = mkBoard();
    injectFault(b.components.find((c) => c.ref === 'C_PP1V8_S0_3')!, 'mlcc-dead-short', rng(1), { severity: 0.05 });
    const T = BOOT_TIMING;
    const firstFail = T.standby + T.dwell.S5 + T.dwell.S4 + T.dwell.S3 + T.dwell.S0 + T.timeout;
    const { ctl, seen } = powerUp(b, firstFail + T.retry + 1.5);
    assert(ctl.failures >= 1, `boot loop: ${ctl.failures} failed attempts`);
    assert(ctl.blockedBy.includes('PP1V8_S0'), `blocked by the shorted rail: ${ctl.blockedBy}`);
    assert(!seen.some((s) => s.state === 'S0SW'), 'never reaches S0SW');
    const back = seen.findIndex((s, i) => i > 0 && s.state === 'G3H');
    assert(back > 0 && seen.slice(back + 1).some((s) => s.state === 'S5'), `drops to standby, then retries: ${seen.map((s) => s.state).join('>')}`);
    const s0 = seen.find((s) => s.state === 'S0')!.amps, g3 = seen[back].amps;
    assert(s0 > 3 * g3, `current climbs into the short, falls back in standby: ${s0} vs ${g3}`);
  }

  // ---- damaged regulator: its rail never comes up, the controller loops in that state ----
  {
    const b = mkBoard();
    b.components.find((c) => c.ref === 'U2')!.state.burnt = true;
    const { ctl } = powerUp(b, 6);
    assert(ctl.failures >= 1 && ctl.blockedBy.includes('PP1V8_S0'), `dead LDO blocks S0: ${ctl.failures}, ${ctl.blockedBy}`);
  }

  // ---- chip shorted inside, power pin to ground: the S5 rail is held at the buck's current limit ----
  {
    const b = mkBoard();
    const u2 = b.components.find((c) => c.ref === 'U2')!;
    assert(applicableFaults(u2).includes('ic-rail-short'), 'a regulator chip can short inside');
    const f = injectFault(u2, 'ic-rail-short', rng(2), { pad: 0, severity: 0.05 });
    assert(u2.state.leak?.a === '1' && u2.state.leak.b === '4', `short from the PP5V_S5 pin to the GND pin: ${f.describe}`);
    const { ctl, seen } = powerUp(b, 4);
    assert(ctl.failures >= 1 && ctl.blockedBy.includes('PP5V_S5'), `stuck in S5: ${ctl.blockedBy}`);
    const s5 = seen.find((s) => s.state === 'S5')!.amps;
    // 8 A out at ~0.4 V into 0.05 Ω reflected to 12 V through a 90 %-efficient buck: well under 8 A in
    assert(s5 > 0.05 && s5 < 8, `supply current limited by the converter, not unbounded: ${s5.toFixed(3)} A`);
  }

  // ---- a chip with a datasheet supply current replaces the estimate on its rail ----
  {
    x0 = 0;
    const cs: Component[] = [
      part('J1', 'battery', ['+5V', 'GND'], 5, { '+': '1', '-': '2' }),
      part('U3', 'ic', ['+5V', 'GND', '+5V', 'NC1', '+3.3V']),                          // LDO, EN tied to VIN
      part('C7', 'capacitor', ['+3.3V', 'GND'], 4.7e-6, two),
      part('C8', 'capacitor', ['+3.3V', 'GND'], 1e-7, two),
      part('C9', 'capacitor', ['+5V', 'GND'], 1e-6, two),
      part('R12', 'resistor', ['+3.3V', 'EN_MOD'], 10e3, two),
      // ESP32-C3-MINI-1: pin 3 = 3V3, pin 8 = EN (datasheet), the rest is not connected here
      part('U4', 'ic', ['GND', 'GND', '+3.3V', 'NC2', 'NC3', 'NC4', 'NC5', 'EN_MOD']),
    ];
    cs.find((c) => c.ref === 'U3')!.label = 'HX6211A332MR';
    cs.find((c) => c.ref === 'U4')!.label = 'ESP32-C3-MINI-1-N4';
    const b: Board = { w: 200, h: 30, thickness: 1.6, components: cs, traces: [], vias: [], blobs: [], jumpers: [], zones: [], silk: [], texts: [], nextId: 1 };
    const amps = (bd: Board) => simulateSpice(bd, buildConnectivity(bd), { powerTree: true, powerState: 'S0SW' }).comps.get('J1')!.i;
    const conn = buildConnectivity(b);
    assert(!estimateRailLoads(b, conn, discoverPowerTree(b, conn)).some((l) => l.rail === '+3.3V'), 'no decoupling estimate on a rail whose chip has datasheet data');
    const on = amps(b);
    assert(Math.abs(on - 0.082) < 0.004, `ESP32-C3-MINI-1 running: the LDO passes its 82 mA (RX, datasheet) → ${(on * 1e3).toFixed(1)} mA`);
    const reset = structuredClone(b);
    reset.components.push(part('C10', 'capacitor', ['EN_MOD', 'GND'], 1e-6, two));
    reset.components.find((c) => c.ref === 'C10')!.state.leak = { ohms: 1, a: '1', b: '2' }; // EN shorted to ground
    assert(amps(reset) < 0.005, `EN held low: the module stays in reset (${(amps(reset) * 1e3).toFixed(2)} mA)`);
    const dead = structuredClone(b);
    dead.components.find((c) => c.ref === 'U4')!.state.burnt = true;
    assert(amps(dead) < 0.005, 'a dead module draws nothing');
  }

  console.log('BOOT TESTS PASSED (rail loads from decoupling, state stepping, rising supply current, boot loop on a shorted S0 rail, datasheet chip loads)');
}

run();
