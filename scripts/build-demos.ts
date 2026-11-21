// Builds the open-hardware demo scenarios in public/demos/ from pinned upstream KiCad files.
//
//   npx tsx scripts/build-demos.ts --fetch            # sparse-clone the pinned commits into a temp dir
//   npx tsx scripts/build-demos.ts --src <dir>        # or use existing checkouts: <dir>/<demo id>/...
//   … --only <id>[,<id>]                             # rebuild just these; the others keep their JSON and index entry
//
// Each demo: import → lock the flag to the healthy board → plant faults → check that the faulted
// board fails its tests and that the intended repair passes them and unlocks the flag. The
// output JSON is a converted, modified form of the upstream design and keeps its licence.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Component, Objective, Scenario } from '../src/types';
import { importScenarioOrPcb } from '../src/io/kicad';
import { buildConnectivity } from '../src/connectivity';
import { lockFlag, topology } from '../src/crypto';
import { verifyScenario } from '../src/verify';
import { injectFault, rng, seedOf } from '../src/faults';
import { DEMO_REPAIRS } from '../src/scenarios/demoRepairs';
import { removePart, toggleCold } from '../src/ops';

interface Demo {
  id: string;
  repo: string;
  commit: string;
  file: string;
  license: string;
  licenseFile: string;
  /** The hardware licence text when the repository's own LICENSE file covers something else: a file in this repo + a note on top. */
  licenseText?: { file: string; note: string };
  credits: string;
  title: string;
  difficulty: number;
  description: string;
  hints: string[];
  flag: string;
  objectives: Objective[];
  plant: (sc: Scenario, part: (ref: string) => Component) => void;
  repair: (sc: Scenario, part: (ref: string) => Component) => void;
}

const DEMOS: Demo[] = [
  {
    id: 'demo-mnt-reform2-mb30',
    repo: 'https://source.mnt.re/reform/reform.git',
    commit: 'c3b7fad440a3fab3d4b99aab0e06010fca1122a4',
    file: 'reform2-motherboard30-pcb/reform2-motherboard30.kicad_pcb',
    license: 'CERN-OHL-S-2.0',
    licenseFile: 'LICENSE',
    credits: 'MNT Reform 2 motherboard rev 3.0, designed by MNT Research GmbH. Converted and modified (planted faults) for DEADBOARD.',
    title: 'MNT Reform 2 · dead 3.3 V rail',
    difficulty: 4,
    description:
      'An open-hardware laptop mainboard (529 parts) that came back from a repair desk: it powers up, but the system never starts. ' +
      'The bench supply is clipped onto the gated input rail. Find out why the 3.3 V rail is missing, fix it, and leave the board clean.',
    hints: [
      'Power it up with Solver: SPICE + PWR. Compare the supply current with what a board at idle should draw, then measure +5V, +3V3 and +1V2.',
      'A rail sitting far below its target while its regulator is enabled usually means it is being pulled down. Thermal view, freeze spray or the rosin tool will show you the hot part.',
      'There is also something crusty next to a 5 V capacitor. Isopropyl takes a few scrubs.',
    ],
    flag: 'DEAD{r3f0rm_3v3_sh0rt_g0n3}',
    objectives: [
      { type: 'voltage', a: 'C29', min: 3.2, max: 3.4 },
      { type: 'voltage', a: 'C35', min: 4.85, max: 5.15 },
      { type: 'voltage', a: 'C37', min: 1.15, max: 1.25 },
    ],
    plant: (sc, part) => {
      injectFault(part('C173'), 'mlcc-dead-short', rng(seedOf(sc.id + 'C173')), { severity: 0.08 });
      injectFault(part('C97'), 'liquid-leakage', rng(seedOf(sc.id + 'C97')), { severity: 150 });
    },
    repair: DEMO_REPAIRS['demo-mnt-reform2-mb30'],
  },
  {
    id: 'demo-antmicro-jetson-nano-bb',
    repo: 'https://github.com/antmicro/jetson-nano-baseboard.git',
    commit: 'd8d0b2d71ab4cc4bcdb204a09f78be40d4c8cda3',
    file: 'jetson-nano-baseboard.kicad_pcb',
    license: 'Apache-2.0',
    licenseFile: 'LICENSE',
    credits: 'Jetson Nano / Xavier NX baseboard, Copyright (c) 2020-2024 Antmicro, Apache-2.0. Converted and modified (planted faults) for DEADBOARD. Jetson is a trademark of NVIDIA; no endorsement implied.',
    title: 'Antmicro baseboard · no 3.3 V, flaky 5 V',
    difficulty: 3,
    description:
      'An open-source carrier board for a compute module (392 parts), fed 12 V on VIN. The module will not start: 3.3 V is missing, ' +
      'and the customer says the 5 V rail "sometimes" drops out when the board is handled.',
    hints: [
      'With Solver: SPICE + PWR, measure 5V0_SYS and 3V3_SYS. Then follow 3.3 V back from its output to its input. Is the converter switching (scope, key O)?',
      'A converter with input and enable present and no output is a dead part: replace it with the parts bin.',
      'For the dropouts, press on the board (key B) near the 5 V input filter while watching the rail, then reflow what moves.',
    ],
    flag: 'DEAD{b4s3b0ard_3v3_b4ck}',
    objectives: [
      { type: 'voltage', a: 'C26', min: 3.2, max: 3.4 },
      { type: 'voltage', a: 'C32', min: 4.7, max: 5.2 },
    ],
    plant: (sc, part) => {
      injectFault(part('U2'), 'open-part', rng(seedOf(sc.id + 'U2')));
      injectFault(part('FB1'), 'flex-open-joint', rng(seedOf(sc.id + 'FB1')), { pad: 0, severity: 0.5 });
    },
    repair: DEMO_REPAIRS['demo-antmicro-jetson-nano-bb'],
  },
  {
    id: 'demo-olimex-esp32-devkit-lipo',
    repo: 'https://github.com/OLIMEX/ESP32-DevKit-LiPo.git',
    commit: '1ebbbb5ceaa84b1d67631d8d542d7f6128c19fc1',
    file: 'HARDWARE/ESP32-DevKit-LiPo-Rev.D/ESP32-DevKit-Lipo_Rev_D.kicad_pcb',
    license: 'Apache-2.0',
    licenseFile: 'LICENSE',
    credits: 'ESP32-DevKit-LiPo Rev. D, designed by OLIMEX Ltd, hardware Apache-2.0. Converted and modified (planted faults) for DEADBOARD. ESP32 is a trademark of Espressif Systems; no endorsement implied.',
    title: 'Olimex ESP32-DevKit-LiPo · dead on USB, won\'t charge',
    difficulty: 2,
    description:
      'A real, sold ESP32 board (57 parts) with a Li-ion charger. The owner says it stopped doing anything on USB after the cable got yanked, and before that ' +
      'the battery "never seemed to charge". No battery is plugged in on your bench.',
    hints: [
      'Follow the USB 5 V in: measure the USB rail, then +5V after D1. A diode with volts on one side and nothing on the other is open, or not soldered.',
      'With no battery fitted, a working charger holds its BAT pin near 4.2 V. If it reads 0 V, check the part that sets its charge current: the resistor on PROG (U1 pin 5).',
      'Reflow what is cracked; fit what is missing (its value is printed in the Inspector).',
    ],
    flag: 'DEAD{3sp32_l1p0_usb_4nd_pr0g}',
    objectives: [
      { type: 'voltage', a: 'C7', min: 3.2, max: 3.4 },
      { type: 'voltage', a: 'BAT1', min: 3.8, max: 4.3 },
    ],
    plant: (_sc, part) => {
      const d1 = part('D1');
      toggleCold(d1, d1.pads.findIndex((p) => p.name === d1.pins.K));
      removePart(part('R4'));
    },
    repair: DEMO_REPAIRS['demo-olimex-esp32-devkit-lipo'],
  },
  {
    id: 'demo-olimex-esp32-c3-devkit-lipo',
    repo: 'https://github.com/OLIMEX/ESP32-C3-DevKit-Lipo.git',
    commit: '5d93e79d46cf3b05782d9fe0f95a8a2e1ca6abbe',
    file: 'HARDWARE/ESP32-C3-DevKit-Lipo_Rev_D/ESP32-C3-DevKit-Lipo_Rev_D.kicad_pcb',
    license: 'CERN-OHL-S-2.0',
    licenseFile: 'README.md',
    licenseText: {
      file: 'public/demos/licenses/demo-mnt-reform2-mb30.LICENSE.txt',
      note: 'OLIMEX ESP32-C3-DevKit-Lipo: the upstream README releases the hardware under CERN-OHL-S-2.0 (its LICENSE file is the GPL-3.0 for the software). Licence text:',
    },
    credits: 'ESP32-C3-DevKit-Lipo Rev. D, designed by OLIMEX Ltd, hardware CERN-OHL-S-2.0. Converted and modified (planted faults) for DEADBOARD. ESP32 is a trademark of Espressif Systems; no endorsement implied.',
    title: 'Olimex ESP32-C3-DevKit-Lipo · hot board, wrong 3.3 V',
    difficulty: 3,
    description:
      'A real, sold ESP32-C3 board (62 parts) back from a small production run: on USB it gets warm and the chip never starts. ' +
      'The assembler says two reels were swapped somewhere on that batch. No battery is plugged in on your bench.',
    hints: [
      'Measure +3.3V with Solver: SPICE + PWR. Far below 3.3 V with the buck enabled means something pulls it down: the thermal camera shows what is hot.',
      'Once the rail is free, read it again. A buck sets its output with the two resistors on FB (U2 pin 5): V = 0.6 V × (1 + top / bottom). Compare what is fitted with the values printed on the board.',
      'Replace the shorted capacitor and the wrong resistor (the Inspector shows the intended value).',
    ],
    flag: 'DEAD{c3_buck_fb_r33l_sw4p}',
    objectives: [
      { type: 'voltage', a: 'C6', min: 3.15, max: 3.35 },
      { type: 'voltage', a: 'BAT1', min: 3.8, max: 4.3 },
    ],
    plant: (sc, part) => {
      injectFault(part('C5'), 'mlcc-dead-short', rng(seedOf(sc.id + 'C5')), { severity: 0.1 });
      part('R11').value = 22e3; // a 22 k reel where the 49.9 k one belongs: 0.6 V × (1 + 220/22) asks for 6.6 V
    },
    repair: DEMO_REPAIRS['demo-olimex-esp32-c3-devkit-lipo'],
  },
];

const round = (_k: string, v: unknown) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);

async function build(d: Demo, srcDir: string) {
  const path = join(srcDir, d.id, d.file);
  const sc = importScenarioOrPcb(d.file.split('/').pop()!, readFileSync(path, 'utf8'));
  sc.id = d.id;
  sc.solver = 'spice-power';
  sc.meta = {
    ...sc.meta,
    title: d.title, author: 'DEADBOARD', difficulty: d.difficulty, description: `${d.description} ${sc.meta.description.match(/Bench supply:[^.]*\(.*?\)\./)?.[0] ?? ''}`.trim(),
    hints: d.hints, credits: d.credits, license: d.license, source: `${d.repo.replace(/\.git$/, '')} @ ${d.commit.slice(0, 7)}`,
  };
  sc.objectives = d.objectives;
  const part = (ref: string) => { const c = sc.board.components.find((x) => x.ref === ref); if (!c) throw new Error(`${d.id}: no part ${ref}`); return c; };

  // lock to the healthy board, then break it
  const healthy = await verifyScenario(sc, sc.board, 'spice-power');
  if (!healthy.allPassed) throw new Error(`${d.id}: the healthy board fails its own tests: ${JSON.stringify(healthy.results.map((r) => r.detail))} overloads ${JSON.stringify(healthy.overloads)}`);
  sc.lock = await lockFlag(d.flag, topology(sc.board, buildConnectivity(sc.board), sc.id));
  d.plant(sc, part);
  const faulted = await verifyScenario(sc, sc.board, 'spice-power');
  if (faulted.allPassed || faulted.flag) throw new Error(`${d.id}: the faulted board passes`);

  const fixed: Scenario = structuredClone(sc);
  const fixedPart = (ref: string) => fixed.board.components.find((x) => x.ref === ref)!;
  d.repair(fixed, fixedPart);
  const repaired = await verifyScenario(fixed, fixed.board, 'spice-power');
  if (!repaired.allPassed || repaired.flag !== d.flag) throw new Error(`${d.id}: the intended repair does not unlock the flag: ${JSON.stringify(repaired.results.map((r) => r.detail))}, flag ${repaired.flag}`);

  const out = JSON.stringify(sc, round);
  writeFileSync(join('public/demos', `${d.id}.pcbfix.json`), out);
  console.log(`${d.id}: ${sc.board.components.length} parts, ${(out.length / 1e6).toFixed(2)} MB — faulted: ${faulted.results.filter((r) => !r.passed).length} failing check(s); repaired: pass + flag`);
  return { id: d.id, file: `${d.id}.pcbfix.json`, title: d.title, difficulty: d.difficulty, description: d.description, credits: d.credits, license: d.license, source: sc.meta.source };
}

async function main() {
  const args = process.argv.slice(2);
  let src = args.includes('--src') ? args[args.indexOf('--src') + 1] : '';
  const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;
  if (args.includes('--fetch')) {
    src = mkdtempSync(join(tmpdir(), 'deadboard-demos-'));
    for (const d of DEMOS) {
      if (only && !only.has(d.id)) continue;
      const dir = join(src, d.id);
      execFileSync('git', ['clone', '-q', '--filter=blob:none', '--no-checkout', d.repo, dir], { stdio: 'inherit' });
      execFileSync('git', ['-C', dir, 'sparse-checkout', 'set', '--no-cone', d.file, d.licenseFile], { stdio: 'inherit' });
      execFileSync('git', ['-C', dir, 'checkout', '-q', d.commit], { stdio: 'inherit' });
    }
  }
  if (!src) throw new Error('pass --fetch or --src <dir>');
  mkdirSync('public/demos/licenses', { recursive: true });
  const previous = new Map<string, unknown>((JSON.parse(readFileSync('public/demos/index.json', 'utf8')) as { id: string }[]).map((e) => [e.id, e]));
  const index = [];
  for (const d of DEMOS) {
    if (only && !only.has(d.id)) { if (previous.has(d.id)) index.push(previous.get(d.id)); continue; }
    index.push(await build(d, src));
    const text = d.licenseText ? `${d.licenseText.note}\n\n${readFileSync(d.licenseText.file, 'utf8')}` : readFileSync(join(src, d.id, d.licenseFile));
    writeFileSync(join('public/demos/licenses', `${d.id}.LICENSE.txt`), text);
  }
  writeFileSync('public/demos/index.json', JSON.stringify(index, null, 2) + '\n');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
