// Mods: ZIP reader/writer (incl. hostile archives), mod.json validation, loading the example mod
// (KiCad + BOM + schematic, and a locked repair challenge), id rules and the published download.
import { cleanPath, readZip, writeZip, ZIP_LIMITS } from '../src/mods/zip';
import { loadMod, parseManifest, zipSource, type ModSource } from '../src/mods/mods';
import { verifyScenario } from '../src/verify';
import { toggleCold } from '../src/ops';

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
async function rejects(p: Promise<unknown> | (() => unknown), re: RegExp, m: string) {
  try { await (typeof p === 'function' ? p() : p); } catch (e) {
    assert(re.test(String(e instanceof Error ? e.message : e)), `${m}: wrong error "${e instanceof Error ? e.message : e}"`);
    return;
  }
  throw new Error(`${m}: did not throw`);
}

// node:fs through a dynamic import, as in the other suites (the app's tsconfig has no Node types)
interface Fs {
  readFileSync(p: string): Uint8Array;
  readdirSync(p: string, o: { withFileTypes: true }): { name: string; isDirectory(): boolean }[];
}
let fs: Fs;
const MOD = 'examples/mods/starter-kit';
const ZIP = 'public/examples/starter-kit.zip';
const te = new TextEncoder();
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

function folderSource(dir: string): ModSource {
  const files: string[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(rel ? `${dir}/${rel}` : dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r); else files.push(r);
    }
  };
  walk('');
  return { origin: 'test', name: dir, files, read: async (p) => new Uint8Array(fs.readFileSync(`${dir}/${p}`)) };
}

async function run() {
  const modName = 'node:fs';
  fs = (await import(/* @vite-ignore */ modName)) as Fs;

  // ---- zip round trip: deflated text, stored (incompressible) bytes, UTF-8 names ----
  {
    const noise = new Uint8Array(4096).map((_, i) => (i * 2654435761) >>> 24);
    const files = new Map<string, Uint8Array>([
      ['mod.json', te.encode('{"a":' + '1,'.repeat(2000) + '1}')],
      ['boards/schéma.bin', noise],
      ['empty.txt', new Uint8Array(0)],
    ]);
    const back = await readZip(await writeZip(files));
    assert(back.size === 3, 'three entries back');
    for (const [k, v] of files) assert(same(back.get(k)!, v), `${k} round-trips`);
  }

  // ---- hostile archives ----
  {
    assert(cleanPath('a/./b//c') === 'a/b/c' && cleanPath('\\win\\path') === 'win/path', 'paths normalised');
    assert(cleanPath('../evil') === null && cleanPath('a/../../b') === null && cleanPath('C:/x') === null, 'escaping paths rejected');
    await rejects(readZip(await writeZip([['../evil.txt', te.encode('x')]])), /Unsafe path/, 'zip-slip entry');
    // a header claiming a huge unpacked size is refused before inflating anything
    const z = await writeZip([['big.bin', te.encode('x')]]);
    const cd = z.length - 22 - (46 + 'big.bin'.length);
    new DataView(z.buffer).setUint32(cd + 24, ZIP_LIMITS.file + 1, true);
    await rejects(readZip(z), /too large/, 'oversized entry');
    // a lying size (bomb that inflates past its header) is caught while inflating
    const lie = await writeZip([['a.txt', te.encode('a'.repeat(10000))]]);
    const cd2 = lie.length - 22 - (46 + 'a.txt'.length);
    new DataView(lie.buffer).setUint32(cd2 + 24, 100, true);
    await rejects(readZip(lie), /larger than its header/, 'size lie');
    await rejects(readZip(te.encode('not a zip at all, definitely not')), /Not a ZIP/, 'garbage');
  }

  // ---- mod.json validation: every problem in one message ----
  {
    await rejects(() => parseManifest('{nope'), /not valid JSON/, 'bad JSON');
    await rejects(() => parseManifest(JSON.stringify({
      format: 'deadboard-mod/1', id: 'Bad Id!', name: 'x', homepage: 'http://insecure',
      boards: [{ file: 'a.exe' }, { file: 'b.kicad_pcb' }, { file: 'x/b.kicad_pcb' }, { file: 'c.brd', schematic: 'c.docx' }],
    })), /"id".*"license".*"homepage".*boards\[0\]\.file.*boards\[2\]\.id "b" is used twice.*boards\[3\]\.schematic/, 'all errors listed');
    const m = parseManifest(JSON.stringify({ format: 'deadboard-mod/1', id: 'ok-mod', name: 'OK', license: 'MIT', boards: [{ file: './Boards/My Board.kicad_pcb', difficulty: 3.6 }] }));
    assert(m.boards[0].id === 'my-board' && m.boards[0].file === 'Boards/My Board.kicad_pcb' && m.boards[0].difficulty === 4, 'defaults: id from file name, path cleaned, difficulty rounded');
    assert(m.version === '1.0.0' && m.author === 'anonymous', 'defaults: version and author');
  }

  // ---- the example mod, from its folder ----
  const FLAG = 'DEAD{n1ght_l1ght_c0ld_j01nt}';
  {
    const mod = await loadMod(folderSource(MOD));
    assert(mod.warnings.length === 0, `no warnings (${mod.warnings.join('; ')})`);
    assert(mod.boards.length === 2, 'two boards');
    const [sandbox, challenge] = mod.boards;

    // listed before parsing (title in mod.json): the stub is empty until opened
    assert(sandbox.stub.id === 'mod-starter-kit-night-light' && sandbox.stub.board.components.length === 0, 'sandbox listed lazily, namespaced id');
    const sb = await sandbox.load();
    assert(sb.id === 'mod-starter-kit-night-light' && sb.meta.title === 'Night light (sandbox)', 'id + title');
    const part = (ref: string) => sb.board.components.find((c) => c.ref === ref)!;
    assert(part('R1').value === 68 && !part('R1').valueGuessed, 'BOM set R1 = 68 Ω (the KiCad file has "~")');
    assert(part('R2').state.populated === false, 'BOM DNP: R2 not fitted');
    assert(part('D1').kind === 'led' && part('BT1').kind === 'battery' && part('SW1').kind === 'switch', 'part kinds');
    assert(sb.meta.license === 'CC0-1.0' && sb.meta.author === 'DEADBOARD' && /Starter kit/.test(sb.meta.credits ?? ''), 'attribution from the mod');
    assert(sb.objectives.length === 2, 'objectives from mod.json');
    assert((await verifyScenario(sb)).allPassed, 'the sandbox board works: D1 on with SW1, off without');
    assert(sandbox.schematic?.mime === 'image/svg+xml' && (await sandbox.schematic.read()).length > 500, 'schematic attached');
    assert((await sandbox.load()) === sb, 'loaded once, then cached');

    // the challenge keeps its own id (its flag lock depends on it), fails until repaired, then unlocks
    const ch = challenge.stub;
    assert(ch.id === 'starter-kit-night-light-repair' && ch.board.components.length === 5, 'challenge parsed eagerly with its own id');
    assert(!(await verifyScenario(ch)).allPassed, 'challenge starts broken');
    const r1 = ch.board.components.find((c) => c.ref === 'R1')!;
    toggleCold(r1, r1.pads.findIndex((p) => p.name === '2'));
    const fixed = await verifyScenario(ch);
    assert(fixed.allPassed && fixed.flag === FLAG, 'reflowing the joint passes and unlocks the flag');
  }

  // ---- ids: a board whose id is taken is skipped with a warning; missing files are named ----
  {
    const src = folderSource(MOD);
    const mod = await loadMod(src, (id) => id === 'starter-kit-night-light-repair');
    assert(mod.boards.length === 1 && /already loaded/.test(mod.warnings[0]), 'id clash skipped');
    const broken: ModSource = {
      ...src,
      read: async (p) => p === 'mod.json'
        ? te.encode(new TextDecoder().decode(await src.read(p)).replace('boards/night-light-bom.csv', 'boards/Night-Light-BOM.csv'))
        : src.read(p),
    };
    const m2 = await loadMod(broken);
    assert(m2.warnings.some((w) => /Night-Light-BOM\.csv not found \(did you mean boards\/night-light-bom\.csv/.test(w)), 'case-sensitivity hint');
  }

  // ---- the download on the website is the current example (rebuild: npm run example-mod) ----
  {
    const zipped = await readZip(new Uint8Array(fs.readFileSync(ZIP)));
    const folder = folderSource(MOD);
    assert(zipped.size === folder.files.length, `zip has ${zipped.size} files, folder ${folder.files.length}: run npm run example-mod`);
    for (const f of folder.files) {
      const z = zipped.get(`starter-kit/${f}`);
      assert(z && same(z, await folder.read(f)), `${f} in the zip is stale: run npm run example-mod`);
    }
    // a zip with the mod in one top-level folder loads like the folder itself
    const mod = await loadMod(await zipSource(new Uint8Array(fs.readFileSync(ZIP)), 'starter-kit.zip', 'test'));
    assert(mod.manifest.id === 'starter-kit' && mod.boards.length === 2, 'zip with a top-level folder loads');
  }

  console.log('MODS TESTS PASSED (zip round trip + hostile archives, mod.json errors, example mod: BOM values/DNP, schematic, lazy listing, locked challenge unlocks, id clashes, published zip current)');
}

run().catch((e) => { console.error(e); (globalThis as unknown as { process: { exitCode: number } }).process.exitCode = 1; });
