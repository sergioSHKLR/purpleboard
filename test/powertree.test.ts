// Power-tree discovery + behavioral converter simulation. The synthetic board uses no
// MacBook knowledge at all: it checks that the method is universal.
import { macbookFixture } from './fixtures';
import type { Board, Component, ComponentKind } from '../src/types';
import { buildConnectivity } from '../src/connectivity';
import { boardToCircuit } from '../src/spice/board';
import { Engine } from '../src/spice/engine';
import { discoverPowerTree, netRole, powerStateRank, railVoltage } from '../src/spice/powertree';
import { powerTreeElements } from '../src/spice/powermodels';
import { parseBrd } from '../src/io/brd';
import { enablesForState, expectedUp } from '../src/spice/sequencer';
import { verifyScenario } from '../src/verify';
import { installPart, toggleCold } from '../src/ops';

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const near = (a: number | undefined, b: number, t: number, m: string) => assert(a !== undefined && Math.abs(a - b) <= t, `${m}: expected ${b} ± ${t}, got ${a}`);

let x0 = 0;
function part(ref: string, kind: ComponentKind, nets: string[], value = 0, pins: Record<string, string> = {}): Component {
  x0 += 10;
  return {
    id: ref, ref, kind, value, at: [x0, 10], rot: 0, side: 'F',
    pads: nets.map((n, i) => ({ name: String(i + 1), at: [i * 1.5, 0], size: [0.6, 0.6], shape: 'rect', layers: 'F', net: n })),
    pins, body: { shape: 'box', w: 1, h: 1, z: 0.5 }, state: { populated: true, reversed: false, burnt: false, cold: [] },
  };
}

async function run() {
  // ---- net semantics ----
  assert(railVoltage('PP3V3_S0') === 3.3 && railVoltage('PP1V05_SUS') === 1.05 && railVoltage('+5V') === 5 && railVoltage('VCC_1V8') === 1.8, 'rail voltages');
  assert(railVoltage('PPVIN_G3H_P3V42G3H') === null, "a regulator's input named after its consumer carries no voltage");
  assert(netRole('P3V3S0_EN') === 'enable' && netRole('P3V42G3H_SW') === 'switch' && netRole('BUCK1_PGOOD') === 'pgood', 'role tokens beat voltage prefixes');
  assert(netRole('PPBUS_S5_HS_ISNS') === 'rail' && netRole('P5V_S4RS3_VFB1') === 'feedback', 'PP rails and channel-suffixed roles');
  assert(powerStateRank('PP3V3_S5')! < powerStateRank('PP3V3_S0')! && powerStateRank('PP3V3_S0')! < powerStateRank('PP3V3_S0SW_SSD')!, 'power-state availability ranking');

  // ---- synthetic, non-MacBook board ----
  const comps: Component[] = [
    part('J1', 'battery', ['VIN_12V', 'GND'], 12, { '+': '1', '-': '2' }),
    part('U1', 'ic', ['VIN_12V', 'BUCK_SW', 'BUCK_EN', 'BUCK_FB', 'GND']),            // buck controller with integrated FETs
    part('L1', 'resistor', ['BUCK_SW', 'PP5V_S5'], 0.02, { '1': '1', '2': '2' }),
    part('C1', 'capacitor', ['PP5V_S5', 'GND'], 22e-6, { '1': '1', '2': '2' }),
    part('R1', 'resistor', ['VIN_12V', 'BUCK_EN'], 100e3, { '1': '1', '2': '2' }),     // EN pulled up to input
    part('U2', 'ic', ['PP5V_S5', 'PP3V3_S5', 'LDO_EN', 'LDO_PGOOD', 'GND']),           // LDO with power-good
    part('C2', 'capacitor', ['PP3V3_S5', 'GND'], 10e-6, { '1': '1', '2': '2' }),
    part('R2', 'resistor', ['PP5V_S5', 'LDO_EN'], 10e3, { '1': '1', '2': '2' }),
    part('R3', 'resistor', ['PP3V3_S5', 'LDO_PGOOD'], 10e3, { '1': '1', '2': '2' }),   // PG pull-up
    part('U3', 'ic', ['PP3V3_S5', 'PP3V3_S0', 'LDO_PGOOD', 'GND']),                    // load switch enabled by PG
    part('C3', 'capacitor', ['PP3V3_S0', 'GND'], 10e-6, { '1': '1', '2': '2' }),
    part('R4', 'resistor', ['PP3V3_S0', 'LED_A'], 1000, { '1': '1', '2': '2' }),
    part('D1', 'led', ['LED_A', 'GND'], 0, { A: '1', K: '2' }),
  ];
  comps.find((c) => c.ref === 'L1')!.label = 'Inductor';
  comps.find((c) => c.ref === 'D1')!.color = 'green';
  const board: Board = { w: 200, h: 30, thickness: 1.6, components: comps, traces: [], vias: [], blobs: [], jumpers: [], zones: [], silk: [], texts: [], nextId: 1 };
  const conn = buildConnectivity(board);
  const tree = discoverPowerTree(board, conn);
  const by = (out: string) => tree.sources.find((s) => s.output === out);
  assert(by('PP5V_S5')?.kind === 'buck' && by('PP5V_S5')!.ref === 'U1' && by('PP5V_S5')!.input === 'VIN_12V', `buck found: ${JSON.stringify(by('PP5V_S5'))}`);
  assert(by('PP3V3_S5')?.kind === 'ldo' && by('PP3V3_S5')!.pgood === 'LDO_PGOOD', `LDO with PG found: ${JSON.stringify(by('PP3V3_S5'))}`);
  assert(by('PP3V3_S0')?.kind === 'load-switch' && by('PP3V3_S0')!.input === 'PP3V3_S5', `load switch S5→S0 found: ${JSON.stringify(by('PP3V3_S0'))}`);

  const nl = boardToCircuit(board, conn, { unmodeled: 'omit' });
  const nameToNode = new Map<string, string>();
  for (const [net, node] of nl.netNode) nameToNode.set(conn.netNames[net], node);
  const pm = powerTreeElements(tree, (n) => nameToNode.get(n));
  assert(pm.report.filter((r) => r.modelled).length === 3, `3 converters modelled: ${JSON.stringify(pm.report)}`);
  nl.circuit.elements.push(...pm.elements);
  const e = new Engine(nl.circuit, { gshunt: 1e-12 });
  const op = e.op();
  assert(op.converged, `synthetic board converges (${op.strategy})`);
  const v = (n: string) => e.voltage(op.x, nameToNode.get(n)!);
  near(v('PP5V_S5'), 5, 0.05, 'buck output'); near(v('PP3V3_S5'), 3.3, 0.05, 'LDO output');
  assert(v('LDO_PGOOD')! > 3, 'PGOOD released once the LDO is in regulation');
  near(v('PP3V3_S0'), 3.3, 0.06, 'load switch enabled by PGOOD (sequencing emerges)');
  const led = op.devices.get('D1')!;
  assert(led.i > 1e-3, `LED on switched rail lights (${(led.i * 1e3).toFixed(2)} mA)`);
  // input power ≥ output power (efficiency model): source current × 12 V vs loads
  const pin = -op.branches.get('i(VJ1)')! * 12;
  assert(pin > 0 && pin < 0.1, `input power plausible: ${pin.toFixed(4)} W`);

  // disable the buck: everything downstream goes down, nothing is forced to 0 V by disabled models
  const nl2 = boardToCircuit(board, conn, { unmodeled: 'omit' });
  nl2.circuit.elements.push(...pm.elements, { kind: 'V', name: 'VKILL', n: [nameToNode.get('BUCK_EN')!, '0'], wave: { type: 'dc', v: 0 } });
  const e2 = new Engine(nl2.circuit, { gshunt: 1e-12 });
  const op2 = e2.op();
  assert(op2.converged, 'disabled case converges');
  assert(e2.voltage(op2.x, nameToNode.get('PP3V3_S0')!)! < 0.2, 'rails collapse when the root converter is disabled');

  // ---- power-state sequencing (design intent from state names) ----
  assert(expectedUp('PP3V3_S0', 'S5') === false && expectedUp('PP3V3_S0', 'S0') === true && expectedUp('PP3V42_G3H', 'G3H') === true, 'expected-up from state names');
  const s5 = enablesForState(tree, 'S5').map((d) => d.net), s0 = enablesForState(tree, 'S0').map((d) => d.net);
  assert(s5.includes('BUCK_EN') && s5.includes('LDO_EN'), `S5 asserts the standby converters: ${s5}`);
  assert(!s0.includes('LDO_PGOOD'), 'PG-driven enables are left to the circuit');

  // ---- game integration: puzzles keep their verdicts with behavioral regulators ----
  const mac = await macbookFixture();
  if (mac) {
    const sc = await mac.loadMacbookAirScenario();
    const f = (r: string) => sc.board.components.find((c) => c.ref === r)!;
    assert(!(await verifyScenario(sc, sc.board, 'spice-power')).allPassed, 'faulted MacBook fails with power-tree solver');
    installPart(f('F7700'), { value: 3 }); installPart(f('R7788'), { value: 330000 }); toggleCold(f('XW7720'), 0);
    const v = await verifyScenario(sc, sc.board, 'spice-power');
    assert(v.allPassed && v.flag === 'PCB{m4cb00k_820_00165_b4ckl1ght_f1x}', `repaired MacBook passes with power-tree solver: ${JSON.stringify(v.results.map((r) => r.detail))}`);
  }

  // ---- 820-00165 regression: power tree from the boardview, powered from the battery connector ----
  const modName = 'node:fs';
  const fs = (await import(/* @vite-ignore */ modName)) as { readFileSync(p: URL): Uint8Array; existsSync(p: URL): boolean };
  const brdUrl = new URL('../board_schemas/J113  820-00165.brd', import.meta.url);
  if (fs.existsSync(brdUrl)) {
    const brd = parseBrd(fs.readFileSync(brdUrl));
    brd.board.components = brd.board.components.filter((c) => !c.ref.startsWith('J_'));
    const t = discoverPowerTree(brd.board, buildConnectivity(brd.board));
    for (const [out, kind] of [['PP3V42_G3H', 'buck'], ['PP5V_S4RS3', 'buck'], ['PP3V3_S5_REG_R', 'buck'], ['PPHV_S0SW_LCDBKLT', 'boost']] as const) {
      assert(t.sources.some((s) => s.output === out && s.kind === kind), `820-00165: ${kind} → ${out} discovered from topology`);
    }
    assert(t.sources.filter((s) => s.kind === 'load-switch').length >= 10, 'load switches discovered');
  }
  console.log(`POWER-TREE TESTS PASSED (synthetic board: buck→LDO→PG-enabled switch sequenced; 820-00165 converters discovered)`);
}

run().catch((e) => { console.error(e); (globalThis as unknown as { process: { exitCode: number } }).process.exitCode = 1; });
