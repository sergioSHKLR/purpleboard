// Builds the example mod's repair challenge and its download:
//
//   npx tsx scripts/build-example-mod.ts      (npm run example-mod)
//
// examples/mods/starter-kit/boards/night-light-repair.pcbfix.json: the KiCad night light + its BOM,
// flag locked to the healthy board, then one fault planted (the same steps as the Author tab).
// public/examples/starter-kit.zip: the whole mod folder, linked from the modding guide.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { importScenarioOrPcb } from '../src/io/kicad';
import { applyBom, parseBomCsv } from '../src/io/bom';
import { buildConnectivity } from '../src/connectivity';
import { lockFlag, topology } from '../src/crypto';
import { verifyScenario } from '../src/verify';
import { toggleCold } from '../src/ops';
import { serializeScenario } from '../src/io/format';
import { writeZip } from '../src/mods/zip';
import type { Scenario } from '../src/types';

const ROOT = new URL('..', import.meta.url).pathname;
const MOD = join(ROOT, 'examples/mods/starter-kit');
const FLAG = 'DEAD{n1ght_l1ght_c0ld_j01nt}';

export async function buildChallenge(): Promise<Scenario> {
  const sc = importScenarioOrPcb('night-light.kicad_pcb', readFileSync(join(MOD, 'boards/night-light.kicad_pcb'), 'utf8'));
  applyBom(sc.board, parseBomCsv(readFileSync(join(MOD, 'boards/night-light-bom.csv'), 'utf8')));
  sc.id = 'starter-kit-night-light-repair';
  sc.meta = {
    title: 'Night light · stays dark',
    author: 'DEADBOARD',
    difficulty: 1,
    description: 'A customer\'s night light stays dark when the button is pressed. The batteries are new. Find the fault, repair it and run the tests.',
    hints: [
      'Power it on, hold SW1 and follow the voltage from BT1 towards D1. Where does it stop?',
      'Flip the board (F): one solder joint looks dull and grainy.',
    ],
  };
  sc.objectives = [
    { type: 'led', ref: 'D1', on: true, switches: { SW1: true } },
    { type: 'led', ref: 'D1', on: false, switches: { SW1: false } },
  ];
  sc.lock = await lockFlag(FLAG, topology(sc.board, buildConnectivity(sc.board), sc.id));
  const r1 = sc.board.components.find((c) => c.ref === 'R1')!;
  toggleCold(r1, r1.pads.findIndex((p) => p.name === '2'));
  return sc;
}

async function main() {
  const sc = await buildChallenge();
  const broken = await verifyScenario(sc);
  if (broken.allPassed) throw new Error('the planted fault does not fail the tests');
  writeFileSync(join(MOD, 'boards/night-light-repair.pcbfix.json'), serializeScenario(sc));

  const files: [string, Uint8Array][] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith('.')) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.push([`starter-kit/${relative(MOD, p)}`, new Uint8Array(readFileSync(p))]);
    }
  };
  walk(MOD);
  mkdirSync(join(ROOT, 'public/examples'), { recursive: true });
  writeFileSync(join(ROOT, 'public/examples/starter-kit.zip'), await writeZip(files));
  console.log(`starter-kit: challenge written, zip with ${files.length} files`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) void main();
