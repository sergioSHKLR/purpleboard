// The shipped open-hardware demos (public/demos, built by scripts/build-demos.ts): every board in
// the index loads, carries its attribution and licence, and arrives broken (the build script
// already proved that the intended repair passes and unlocks the flag).
import { parseScenario } from '../src/io/format';
import { verifyScenario } from '../src/verify';

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

interface Fs { readFileSync(p: string, enc: 'utf8'): string; existsSync(p: string): boolean }

async function run() {
  const modName = 'node:fs';
  const { readFileSync, existsSync } = (await import(/* @vite-ignore */ modName)) as Fs;
  const index = JSON.parse(readFileSync('public/demos/index.json', 'utf8')) as { id: string; file: string; license: string; credits: string }[];
  assert(index.length >= 2, 'demo index lists the boards');
  for (const d of index) {
    const sc = parseScenario(readFileSync(`public/demos/${d.file}`, 'utf8'));
    assert(sc.id === d.id, `${d.id}: id matches the index`);
    assert(sc.meta.credits && sc.meta.license === d.license && sc.meta.source?.startsWith('https://'), `${d.id}: attribution, licence and source`);
    assert(existsSync(`public/demos/licenses/${d.id}.LICENSE.txt`), `${d.id}: licence text shipped`);
    assert(sc.solver === 'spice-power' && sc.lock, `${d.id}: needs the regulator models and has a flag`);
    assert(sc.board.components.some((c) => c.ref === 'J_BENCH'), `${d.id}: bench supply placed`);
    const res = await verifyScenario(sc, sc.board, 'spice-power');
    assert(!res.allPassed && res.flag === null, `${d.id}: arrives broken`);
  }
  console.log(`DEMOS TESTS PASSED (${index.map((d) => d.id).join(', ')}: attribution, licence, solver, broken on arrival)`);
}

run().catch((e) => { console.error(e); (globalThis as unknown as { process: { exitCode: number } }).process.exitCode = 1; });
