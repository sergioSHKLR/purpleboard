// Oscilloscope signal synthesis from the solved board state (no board-specific knowledge).
import { FSW, nameFrequency, sampleSignal, signalOn } from '../src/scope';
import type { PowerTree } from '../src/spice/powertree';

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const near = (a: number, b: number, t: number, m: string) => assert(Math.abs(a - b) <= t, `${m}: expected ${b} ± ${t}, got ${a}`);

function run() {
  // ---- frequency from net names ----
  assert(nameFrequency('SMC_XTAL_32K') === 32768 && nameFrequency('RTC_X32K_OUT') === 32768, '32 kHz crystals');
  assert(nameFrequency('PCH_CLK24M_XTALIN') === 24e6 && nameFrequency('CLK_100MHZ_P') === 100e6, 'MHz clocks');
  assert(nameFrequency('SOC_19P2M_CLK') === 19.2e6, 'decimal point written as P');
  assert(nameFrequency('PP3V3_S0') === null && nameFrequency('SMC_RESET_L') === null, 'non-clock nets have no frequency');

  // ---- a buck's switch node: square wave while running, flat when it is not ----
  const tree = { rails: new Map(), roots: [], sources: [{ kind: 'buck', ref: 'U1', parts: [], input: 'PP12V_G3H', output: 'PP3V3_S5', switchNode: 'P3V3S5_SW', vTarget: 3.3, vSource: 'rail-name', confidence: 'high', why: '' }] } as unknown as PowerTree;
  const volts = (vin: number, vout: number) => (n: string) => (n === 'PP12V_G3H' ? vin : n === 'PP3V3_S5' ? vout : undefined);
  const sw = signalOn('P3V3S5_SW', 3.3, tree, volts(12, 3.3));
  assert(sw.kind === 'switch' && sw.freq === FSW, `running buck switches: ${sw.note}`);
  near(sw.duty, 3.3 / 12, 1e-6, 'buck duty = Vout/Vin');
  const ys = sampleSignal(sw, 0, 3 / sw.freq, 3000, 7);
  const hi = Math.max(...ys), lo = Math.min(...ys);
  assert(hi > 11.5 && lo < 0.2, `switch node swings 0 … Vin (${lo.toFixed(2)} … ${hi.toFixed(2)})`);
  const highFrac = [...ys].filter((v) => v > 6).length / ys.length;
  near(highFrac, sw.duty, 0.05, 'time spent high matches the duty cycle');
  const dead = signalOn('P3V3S5_SW', 0, tree, volts(12, 0));
  assert(dead.kind === 'dc' && /not switching/.test(dead.note), `dead converter: no switching (${dead.note})`);

  // ---- regulated output: DC + small ripple ----
  const out = signalOn('PP3V3_S5', 3.3, tree, volts(12, 3.3));
  assert(out.kind === 'switch' && out.pp < 0.05 && out.pp > 0, `output ripple ${out.pp} V p-p`);
  const oy = sampleSignal(out, 0, 3 / out.freq, 600, 3);
  near(oy.reduce((a, b) => a + b, 0) / oy.length, 3.3, 0.01, 'ripple averages to the rail');

  // ---- clocks run only while their driver chip has power ----
  const ck = signalOn('SMC_XTAL_32K', 0, null, () => undefined, 3.3);
  assert(ck.kind === 'clock' && ck.freq === 32768 && ck.pp > 1 && ck.pp < 3.3, `powered crystal oscillates: ${ck.note}`);
  const off = signalOn('SMC_XTAL_32K', 0, null, () => undefined, 0);
  assert(off.kind === 'dc' && /no oscillation/.test(off.note), 'unpowered crystal: flat line');

  // ---- plain nets: the simulated DC level ----
  const plain = signalOn('SMC_RESET_L', 3.1, null, () => undefined);
  assert(plain.kind === 'dc' && plain.dc === 3.1, 'DC level from the simulation');

  console.log('SCOPE TESTS PASSED (clock frequency from names, buck switch node duty/swing, ripple, dead converter / unpowered clock flat)');
}

run();
