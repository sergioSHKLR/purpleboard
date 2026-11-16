// Builds the open-hardware demo scenarios in public/demos/ from pinned upstream KiCad files.
//
//   npx tsx scripts/build-demos.ts --fetch            # sparse-clone the pinned commits into a temp dir
//   npx tsx scripts/build-demos.ts --src <dir>        # or use existing checkouts: <dir>/<demo id>/...
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
import { installPart, toggleCold } from '../src/ops';
import { cleanWithIpa } from '../src/residue';

interface Demo {
  id: string;
  repo: string;
  commit: string;
  file: string;
  license: string;
  licenseFile: string;
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
    repair: (sc, part) => {
      installPart(part('C173'), { value: 22e-6 });
      const c97 = part('C97');
      for (let k = 0; k < 6 && c97.state.residue; k++) cleanWithIpa(sc.board, c97.at[0], c97.at[1], 2);
    },
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
    repair: (_sc, part) => {
      installPart(part('U2'), {});
      toggleCold(part('FB1'), 0);
    },
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
  if (args.includes('--fetch')) {
    src = mkdtempSync(join(tmpdir(), 'deadboard-demos-'));
    for (const d of DEMOS) {
      const dir = join(src, d.id);
      execFileSync('git', ['clone', '-q', '--filter=blob:none', '--no-checkout', d.repo, dir], { stdio: 'inherit' });
      execFileSync('git', ['-C', dir, 'sparse-checkout', 'set', '--no-cone', d.file, d.licenseFile], { stdio: 'inherit' });
      execFileSync('git', ['-C', dir, 'checkout', '-q', d.commit], { stdio: 'inherit' });
    }
  }
  if (!src) throw new Error('pass --fetch or --src <dir>');
  mkdirSync('public/demos/licenses', { recursive: true });
  const index = [];
  for (const d of DEMOS) {
    index.push(await build(d, src));
    writeFileSync(join('public/demos/licenses', `${d.id}.LICENSE.txt`), readFileSync(join(src, d.id, d.licenseFile)));
  }
  writeFileSync('public/demos/index.json', JSON.stringify(index, null, 2) + '\n');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
