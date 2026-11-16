import type { Board, Objective, Scenario, ScenarioMeta } from '../types';
import { buildConnectivity } from '../connectivity';
import { lockFlag, topology } from '../crypto';
import { addBlob, cutTrace } from '../ops';
import { Builder } from './builder';

async function finalize(id: string, meta: ScenarioMeta, b: Board, objectives: Objective[], flag: string, sabotage: (b: Board) => void): Promise<Scenario> {
  const lock = await lockFlag(flag, topology(b, buildConnectivity(b), id));
  sabotage(b);
  return { format: 'pcbfix/1', id, meta, board: b, objectives, lock };
}

function smokeTest() {
  const k = new Builder(70, 42);
  const j1 = k.header('J1', 5, [6, 21], 0, '5V DC');
  const f1 = k.fuse('F1', 0.5, [18, 13]);
  const dProt = k.diode('D1', [34, 13], 180); // pad 2 (A) on left (28.92), pad 1 (K) on right (39.08)
  const tp1 = k.testpoint('TP1', [45, 13], 'VRAIL');
  const r1 = k.resistor('R1', 220, [52, 24], 90);
  const led = k.led('D2', 'green', [52, 34], -90); // A=[52,32.73]? Wait: -90° rotates [1.27,0] to [0,-1.27] (pad 2=A at 35.27? No: rot([1.27,0], -90) = [0, -1.27] -> y=32.73!)
  const tp2 = k.testpoint('TP2', [18, 35], 'GND');

  // +5V -> F1 -> D1(A) -> D1(K) -> VRAIL -> TP1 -> R1 -> D2(A) -> D2(K) -> GND
  k.track('F', [k.pad(j1, '1'), [10, 19.73], [10, 13], k.pad(f1, '1')], 0.9, '+5V_IN');
  k.track('F', [k.pad(f1, '2'), k.pad(dProt, '2')], 0.9, 'FUSED');
  k.track('F', [k.pad(dProt, '1'), k.pad(tp1, '1'), [52, 13], k.pad(r1, '1')], 0.9, 'VRAIL');
  k.track('F', [k.pad(r1, '2'), k.pad(led, '2')], 0.7, 'LED_A');
  k.track('F', [k.pad(led, '1'), [52, 38], [18, 38], k.pad(tp2, '1')], 0.9, 'GND');
  k.track('F', [k.pad(j1, '2'), [10, 22.27], [10, 35], k.pad(tp2, '1')], 0.9, 'GND');
  // Close GND return path on back near TP1 so a solder blob can short VRAIL to GND cleanly
  k.track('B', [[45, 20.5], [45, 35], [18, 35]], 0.9, 'GND');
  k.via([45, 17.5], 'VRAIL');
  k.track('B', [[45, 13], [45, 17.8]], 0.8, 'VRAIL');

  k.text([35, 3.5], 'SMOKE TEST  REV B', 1.4);

  return finalize(
    'builtin-smoke-test',
    {
      title: 'Smoke Test',
      author: 'DEADBOARD Academy',
      difficulty: 3,
      description:
        'A 5V protected rail with a fuse (F1) and 1N4007 series diode (D1). The fuse is blown and the rail is dead. Use Bench OCP (100 mA) + Thermal IR or Multimeter Diode/Ω mode before replacing the fuse!',
      hints: [
        'Enable Current Limit (100 mA) or turn Power OFF and check Ω from TP1 (VRAIL) to TP2 (GND). Flip to the back to spot the short.',
        'Switch the multimeter to Diode Mode (•◄|) with Power OFF and probe across D1: a silicon diode should drop ~0.70 V from Anode to Cathode (band end).',
        'Wick the short blob on the back, flip D1 180° to match the silkscreen K bar, and solder a fresh 0.5 A fuse at F1.',
      ],
      par: 3,
    },
    k.b,
    [
      { type: 'led', ref: 'D2', on: true },
      { type: 'voltage', a: 'TP1', min: 3.9, max: 4.5 },
    ],
    'PCB{c0nst4nt_curr3nt_sm0k3_t3st}',
    (b) => {
      b.components.find((c) => c.ref === 'F1')!.state.burnt = true;
      b.components.find((c) => c.ref === 'D1')!.state.reversed = true;
      addBlob(b, [45, 19.1], 'B', 1.6); // bridges VRAIL trace [45,17.8] to GND trace [45,20.5] on Back
    },
  );
}

function saggingRail() {
  const k = new Builder(68, 42);
  const j1 = k.header('J1', 5, [6, 21], 0, '5V USB');
  const r1 = k.resistor('R1', 10000, [22, 28]);
  const r2 = k.resistor('R2', 10000, [22, 13]);
  const tp1 = k.testpoint('TP1', [34, 21], 'VREF');
  const r3 = k.resistor('R3', 330, [48, 28]);
  const d1 = k.led('D1', 'blue', [58, 14], 90);
  const tp2 = k.testpoint('TP2', [40, 6], 'GND');

  k.track('F', [k.pad(j1, '1'), [12, 19.73], [12, 28], k.pad(r1, '1')], 0.8, '+5V');
  k.track('F', [[12, 28], [12, 34], [42.92, 34], k.pad(r3, '1')], 0.8, '+5V');
  k.track('F', [k.pad(r1, '2'), [27.08, 21], k.pad(tp1, '1')], 0.7, 'VREF');
  k.track('F', [k.pad(r2, '2'), [27.08, 21]], 0.7, 'VREF');
  k.track('F', [k.pad(r3, '2'), [58, 28], k.pad(d1, '2')], 0.7, 'LED_A');

  // Bottom return path through vias
  k.via([58, 10], 'GND');
  k.track('F', [k.pad(d1, '1'), [58, 10]], 0.8, 'GND');
  const backRet = k.track('B', [[58, 10], [40, 6], k.pad(tp2, '1')], 0.8, 'GND');
  k.track('F', [k.pad(tp2, '1'), [16.92, 6], k.pad(r2, '1')], 0.8, 'GND');
  k.track('F', [k.pad(j1, '2'), [3, 22.27], [3, 6], [16.92, 6]], 0.8, 'GND');

  k.text([35, 38], 'DUAL-LAYER REF  2.5V', 1.4);

  return finalize(
    'builtin-sagging-rail',
    {
      title: 'The Sagging Rail',
      author: 'DEADBOARD Academy',
      difficulty: 4,
      description:
        'A 5 V voltage divider (TP1 must read 2.50 V ± 0.2 V) and a blue 5 V indicator LED (D1). Currently VREF sags below 0.5 V and D1 stays dark. Decode the resistor bands and trace both copper layers!',
      hints: [
        'Read R1 (brown-black-orange = 10 kΩ) and R2 (brown-black-red = 1 kΩ!). By Ohm\'s Law, R1 = R2 = 10 kΩ is needed for 2.50 V.',
        'Flip the board (F) and follow D1\'s cathode via on the bottom copper layer toward TP2 (GND).',
        'Swap R2 to 10 kΩ and bridge the broken bottom trace with solder or a jumper wire.',
      ],
      par: 2,
    },
    k.b,
    [
      { type: 'voltage', a: 'TP1', min: 2.3, max: 2.7 },
      { type: 'led', ref: 'D1', on: true },
    ],
    'PCB{0hms_l4w_du4l_l4y3r_pr0}',
    (b) => {
      b.components.find((c) => c.ref === 'R2')!.value = 1000;
      cutTrace(b, b.traces.find((t) => t.id === backRet[0])!, [49, 8], 0.8);
    },
  );
}

export async function realisticScenarios(): Promise<Scenario[]> {
  return Promise.all([smokeTest(), saggingRail()]);
}
