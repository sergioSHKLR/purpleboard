// Bench check from the command line: tests a mod the way the app's Mods window does
// (src/mods/benchcheck.ts), against the shipped boards and demos and the mods it needs.
//
//   npm run bench-check -- <mod folder or .zip> [more mods it needs…] [--no-demos] [--run-code]
//   npm run bench-check -- examples/mods/night-light-extras examples/mods/starter-kit
//
// The first mod is checked; the others are loaded so its dependencies are met. Exit code 1 when
// a check fails. --run-code runs code mods in this process, WITHOUT the app's sandbox: only for
// your own mods (the app's Mods window runs the same check sandboxed).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadMod, zipSource, type LoadedMod, type ModSource } from '../src/mods/mods';
import { checkMods, formatReport, shippedBoards } from '../src/mods/benchrun';
import { CodeModHost, inProcessTransport } from '../src/mods/api/host';

const ROOT = new URL('..', import.meta.url).pathname;

function folderSource(dir: string): ModSource {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p); else files.push(relative(dir, p).split('\\').join('/'));
    }
  };
  walk(dir);
  return { origin: 'folder', name: dir, files, read: async (p) => new Uint8Array(readFileSync(join(dir, p))) };
}

async function modFrom(path: string): Promise<LoadedMod> {
  const src = statSync(path).isDirectory() ? folderSource(path) : await zipSource(new Uint8Array(readFileSync(path)), path, 'zip');
  return loadMod(src);
}

async function main() {
  const paths = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!paths.length) { console.error('usage: npm run bench-check -- <mod folder or .zip> [mods it needs…] [--no-demos]'); process.exit(2); }
  const mods = await Promise.all(paths.map(modFrom));
  for (const m of mods) for (const w of m.warnings) console.warn(`  ! ${m.manifest.id}: ${w}`);
  const demos = process.argv.includes('--no-demos') ? undefined : async (f: string) => readFileSync(join(ROOT, 'public/demos', f), 'utf8');
  let host: CodeModHost | undefined;
  if (process.argv.includes('--run-code') && mods.some((m) => m.manifest.code)) {
    console.warn('  ! running code mods in this process without the sandbox: do this only with your own mods');
    host = new CodeModHost(inProcessTransport((code) => import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)), { onLog: (id, text) => console.log(`  [${id}] ${text}`) });
    for (const m of mods) if (m.manifest.code) await host.start(m);
  }
  const r = await checkMods(mods, await shippedBoards(demos), (s) => console.log(s), host);
  host?.stopAll();
  console.log(formatReport(r));
  if (r.findings.some((f) => f.level === 'fail')) process.exitCode = 1;
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
