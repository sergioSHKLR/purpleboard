// Walkthrough videos (public/videos, rendered by scripts/videos/record.ts): every entry in the
// index points at existing files, for a scene that exists, with both takes.
import { builtinScenarios } from '../src/scenarios/builtin';

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
interface Fs { readFileSync(p: string, enc: 'utf8'): string; existsSync(p: string): boolean }

async function run() {
  const modName = 'node:fs';
  const { readFileSync, existsSync } = (await import(/* @vite-ignore */ modName)) as Fs;
  const index = JSON.parse(readFileSync('public/videos/index.json', 'utf8')) as Record<string, Record<'approach' | 'solution', { file: string; captions: string; poster: string; seconds: number }>>;
  const demos = (JSON.parse(readFileSync('public/demos/index.json', 'utf8')) as { id: string }[]).map((d) => d.id);
  const known = new Set([...(await builtinScenarios()).map((s) => s.id), ...demos]);
  for (const [id, takes] of Object.entries(index)) {
    assert(known.has(id), `${id}: video for an unknown scene`);
    for (const kind of ['approach', 'solution'] as const) {
      const v = takes[kind];
      assert(v && v.seconds > 5, `${id}: ${kind} take present`);
      for (const f of [v.file, v.captions, v.poster]) assert(existsSync(`public/videos/${f}`), `${id}: ${f} exists`);
      assert(readFileSync(`public/videos/${v.captions}`, 'utf8').startsWith('WEBVTT'), `${id}: ${kind} captions are WebVTT`);
    }
  }
  console.log(`VIDEOS TESTS PASSED (${Object.keys(index).length} scenes × approach + solution, files and captions present)`);
}

run().catch((e) => { console.error(e); (globalThis as unknown as { process: { exitCode: number } }).process.exitCode = 1; });
