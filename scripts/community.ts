// The community mod catalogue on deadboard.org (src/mods/community.ts):
//
//   npm run community                        rebuild public/community/index.json from the zips
//   npm run community -- --add <mod.zip>     check a reviewed submission, add it, rebuild
//   npm run community -- --add <zip> --force   …even when its bench check fails
//
// Lists every example mod (public/examples/*.zip) and every added mod (public/community/*.zip).
// Each one is loaded and bench-checked against the shipped boards (with the catalogue mods it
// needs); its counts go into the listing. Code is never run here: a code mod's solvers are checked
// in the app. Review a submission before adding it: read its mod.json (and code, if any), open it in
// the app, and only then add it. Commit the zip and the index; the next deploy publishes them.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadMod, zipSource, type LoadedMod } from '../src/mods/mods';
import { checkMods, formatReport, shippedBoards } from '../src/mods/benchrun';
import { COMMUNITY_FORMAT, contentsOf, sha256Hex, type CommunityIndex, type CommunityMod } from '../src/mods/community';
import { compareVersions, parseVersion } from '../src/mods/semver';
import { isOfficialId } from '../src/mods/official';

const ROOT = new URL('..', import.meta.url).pathname;
const PUB = join(ROOT, 'public');
const DIRS = ['examples', 'community'] as const;

interface Found { file: string; bytes: Uint8Array; mod: LoadedMod }

async function scan(): Promise<Found[]> {
  const out: Found[] = [];
  for (const d of DIRS) {
    const dir = join(PUB, d);
    if (!existsSync(dir)) continue;
    for (const n of readdirSync(dir).filter((x) => x.endsWith('.zip')).sort()) {
      const bytes = new Uint8Array(readFileSync(join(dir, n)));
      out.push({ file: `${d}/${n}`, bytes, mod: await loadMod(await zipSource(bytes, n, d)) });
    }
  }
  const seen = new Map<string, string>();
  for (const f of out) {
    const prev = seen.get(f.mod.manifest.id);
    if (prev) throw new Error(`mod id ${f.mod.manifest.id} is in both ${prev} and ${f.file}`);
    seen.set(f.mod.manifest.id, f.file);
  }
  return out;
}

/** The catalogue mods `m` needs, depth first (so a bench check has its dependencies). */
function needs(m: LoadedMod, all: Found[], acc: LoadedMod[] = []): LoadedMod[] {
  for (const id of Object.keys(m.manifest.requires ?? {})) {
    const dep = all.find((f) => f.mod.manifest.id === id)?.mod;
    if (dep && !acc.includes(dep)) { acc.push(dep); needs(dep, all, acc); }
  }
  return acc;
}

async function build(all: Found[]): Promise<CommunityIndex> {
  const demos = async (f: string) => readFileSync(join(PUB, 'demos', f), 'utf8');
  const shipped = await shippedBoards(demos);
  const mods: CommunityMod[] = [];
  for (const f of all) {
    const mf = f.mod.manifest;
    const report = await checkMods([f.mod, ...needs(f.mod, all)], shipped);
    const n = (l: string) => report.findings.filter((x) => x.level === l).length;
    console.log(formatReport(report));
    mods.push({
      id: mf.id,
      name: mf.name,
      version: mf.version,
      author: mf.author,
      description: mf.description ?? '',
      license: mf.license,
      file: f.file,
      size: f.bytes.length,
      sha256: await sha256Hex(f.bytes),
      requires: { ...(mf.requires ?? {}) },
      contents: contentsOf(mf, f.mod.boards.length),
      code: !!mf.code,
      example: f.file.startsWith('examples/'),
      bench: { pass: n('pass'), warn: n('warn'), fail: n('fail') },
    });
  }
  // players' mods first, then the examples; by name within each
  mods.sort((a, b) => Number(a.example) - Number(b.example) || a.name.localeCompare(b.name));
  return { format: COMMUNITY_FORMAT, mods };
}

async function add(path: string, force: boolean, all: Found[]) {
  const bytes = new Uint8Array(readFileSync(path));
  const mod = await loadMod(await zipSource(bytes, basename(path), 'submission'));
  const mf = mod.manifest;
  for (const w of mod.warnings) console.warn(`  ! ${w}`);
  if (isOfficialId(mf.id)) throw new Error(`"${mf.id}" is reserved for official mods`);
  const prev = all.find((f) => f.mod.manifest.id === mf.id);
  if (prev?.file.startsWith('examples/')) throw new Error(`"${mf.id}" is an example mod's id: the submission needs its own id`);
  if (prev) {
    const a = parseVersion(mf.version), b = parseVersion(prev.mod.manifest.version);
    if (!a || !b || compareVersions(a, b) <= 0) throw new Error(`${mf.id} v${mf.version} isn't newer than the listed v${prev.mod.manifest.version}`);
    console.log(`updating ${mf.id}: v${prev.mod.manifest.version} → v${mf.version}`);
  }
  const report = await checkMods([mod, ...needs(mod, all)], await shippedBoards(async (f) => readFileSync(join(PUB, 'demos', f), 'utf8')));
  console.log(formatReport(report));
  if (report.findings.some((f) => f.level === 'fail') && !force) throw new Error('the bench check fails: fix the mod (or pass --force to add it anyway)');
  mkdirSync(join(PUB, 'community'), { recursive: true });
  copyFileSync(path, join(PUB, 'community', `${mf.id}.zip`));
  console.log(`added public/community/${mf.id}.zip`);
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--add');
  if (at >= 0) {
    const path = args[at + 1];
    if (!path) throw new Error('usage: npm run community -- --add <mod.zip> [--force]');
    await add(path, args.includes('--force'), await scan());
  }
  const index = await build(await scan());
  mkdirSync(join(PUB, 'community'), { recursive: true });
  writeFileSync(join(PUB, 'community/index.json'), JSON.stringify(index, null, 2) + '\n');
  console.log(`\npublic/community/index.json: ${index.mods.length} mods (${index.mods.filter((m) => !m.example).length} from players)`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
