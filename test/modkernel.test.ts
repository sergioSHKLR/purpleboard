// Mod platform, phase 1 (docs/MOD_PLATFORM.md): versions and ranges, deadboard-mod/2 manifests,
// dependency resolution (missing / wrong version / off / blocked / conflicts, order) and loadouts.
import { coerceVersion, compareVersions, parseVersion, satisfies, validRange } from '../src/mods/semver';
import { itemAddress, loadMod, parseAddress, parseManifest, type LoadedMod, type ModSource } from '../src/mods/mods';
import { resolveMods } from '../src/mods/resolve';
import { MY_MODS, OFFICIAL, bootBegin, bootDone, bootModsRunning, deleteLoadout, isModOn, newLoadout, readLoadouts, safeMode, setModOn, switchLoadout, writeLoadouts } from '../src/mods/loadouts';

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
function throws(fn: () => unknown, re: RegExp, m: string) {
  try { fn(); } catch (e) { const msg = e instanceof Error ? e.message : String(e); assert(re.test(msg), `${m}: wrong error "${msg}"`); return; }
  throw new Error(`${m}: did not throw`);
}
const te = new TextEncoder();
const v = (s: string) => parseVersion(s)!;

async function run() {
  // ---- versions and ranges ----
  {
    assert(parseVersion('1.2.3') && !parseVersion('1.2') && !parseVersion('v1.2.3') && !parseVersion('1.2.3.4'), 'strict versions');
    assert(v('1.2.3-beta.1').pre === 'beta.1' && v('1.2.3+build.5').pre === '', 'prerelease kept, build ignored');
    const c = coerceVersion('2')!;
    assert(c.major === 2 && c.minor === 0 && coerceVersion('v1.4')!.minor === 4 && !coerceVersion('latest'), 'lenient /1 versions');
    const order = ['0.9.9', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-beta', '1.0.0', '1.0.1', '1.10.0', '2.0.0'];
    for (let i = 1; i < order.length; i++) assert(compareVersions(v(order[i - 1]), v(order[i])) < 0, `${order[i - 1]} < ${order[i]}`);

    const cases: [string, string, boolean][] = [
      ['1.4.2', '^1.2', true], ['2.0.0', '^1.2', false], ['1.1.9', '^1.2', false], ['1.0.0', '^1', true],
      ['0.3.5', '^0.3', true], ['0.4.0', '^0.3', false], ['0.0.3', '^0.0.3', true], ['0.0.4', '^0.0.3', false],
      ['1.2.9', '~1.2.3', true], ['1.3.0', '~1.2.3', false], ['1.9.0', '~1', true],
      ['1.2.3', '1.2.3', true], ['1.2.4', '1.2.3', false], ['1.7.0', '1', true], ['1.2.5', '1.2', true], ['1.3.0', '1.2', false],
      ['5.0.0', '*', true], ['1.0.0', '>=1.0', true], ['0.9.0', '>=1.0', false], ['1.5.0', '>=1.0 <2', true], ['2.0.0', '>=1.0 <2', false],
      ['2.0.0-beta', '^1.0', false], ['2.0.0-beta', '^2.0.0-alpha', true], ['1.5.0-rc.1', '>=1.0', false],
    ];
    for (const [ver, range, ok] of cases) assert(satisfies(v(ver), range) === ok, `${ver} ${ok ? 'in' : 'not in'} ${range}`);
    assert(!validRange('') && !validRange('^abc') && !validRange('latest') && validRange('>=1 <3') && validRange('*'), 'range validation');
  }

  // ---- item addresses ----
  {
    assert(itemAddress('official-faults', 'faultTypes', 'mlcc-dead-short') === 'official-faults/faultTypes/mlcc-dead-short', 'address format');
    const a = parseAddress('jane.mods/boards/amp-1')!;
    assert(a.mod === 'jane.mods' && a.type === 'boards' && a.item === 'amp-1', 'address parsed');
    assert(!parseAddress('Jane/boards/x') && !parseAddress('jane/boards') && !parseAddress('jane/bo-ards/x'), 'bad addresses refused');
  }

  // ---- deadboard-mod/2 manifests ----
  const m2 = (o: Record<string, unknown>) => JSON.stringify({ format: 'deadboard-mod/2', id: 'jane-pack', name: 'Pack', version: '1.0.0', license: 'MIT', boards: [{ file: 'amp.kicad_pcb' }], ...o });
  {
    const w: string[] = [];
    const mf = parseManifest(m2({ requires: { 'official-faults': '^1.0', 'other.mod': '>=2 <3' }, conflicts: { 'old-pack': '*' }, panels: [], languages: [], colour: 'red' }), w);
    assert(mf.format === 'deadboard-mod/2' && mf.requires['official-faults'] === '^1.0' && mf.conflicts['old-pack'] === '*', 'requires + conflicts read');
    assert(w.some((x) => /"panels" needs a newer version/.test(x)) && w.some((x) => /"languages" needs a newer version/.test(x)) && w.some((x) => /unknown field "colour"/.test(x)), 'future and unknown fields are warnings');

    throws(() => parseManifest(m2({ version: '1.0' })), /"version" must look like 1\.2\.0/, '/2 needs a full semver');
    throws(() => parseManifest(m2({ requires: ['a'] })), /"requires" must be an object/, 'requires shape');
    throws(() => parseManifest(m2({ requires: { 'Bad Id': '^1' } })), /is not a mod id/, 'requires ids checked');
    throws(() => parseManifest(m2({ requires: { other: 'latest' } })), /must be a version range/, 'ranges checked');
    throws(() => parseManifest(m2({ requires: { 'jane-pack': '*' } })), /can't list itself/, 'no self-dependency');
    throws(() => parseManifest(m2({ requires: { x1: '*' }, conflicts: { x1: '*' } })), /both required and a conflict/, 'require + conflict');
    throws(() => parseManifest(m2({ format: 'deadboard-mod/3' })), /"format" must be/, 'unknown format');

    // a loadout mod: only `requires`, no boards
    const lo = parseManifest(m2({ boards: undefined, requires: { 'a-mod': '^1' } }));
    assert(lo.boards.length === 0 && lo.requires['a-mod'] === '^1', 'mod with only requires');
    throws(() => parseManifest(m2({ boards: undefined })), /leave "boards" out and list mods in "requires"/, 'no boards and no requires');

    // /1 stays as it was: loose version, no boards = error, requires ignored with a note
    const w1: string[] = [];
    const v1 = parseManifest(JSON.stringify({ format: 'deadboard-mod/1', id: 'old-mod', name: 'Old', version: '2', license: 'MIT', boards: [{ file: 'amp.brd' }], requires: { x1: '*' }, extra: 1 }), w1);
    assert(v1.format === 'deadboard-mod/1' && v1.version === '2' && Object.keys(v1.requires).length === 0, '/1: version as written, requires ignored');
    assert(w1.length === 1 && /needs "format": "deadboard-mod\/2"/.test(w1[0]), '/1: only the requires note, unknown fields silent as before');
    throws(() => parseManifest(JSON.stringify({ format: 'deadboard-mod/1', id: 'old-mod', name: 'Old', license: 'MIT', requires: { x1: '*' } })), /"boards" must list at least one board$/, '/1 still needs boards');

    // a loadout mod loads (no boards to load is fine for it)
    const src: ModSource = { origin: 'test', name: 'lo', files: ['mod.json'], read: async () => te.encode(m2({ boards: undefined, requires: { 'a-mod': '^1' } })) };
    const loaded = await loadMod(src);
    assert(loaded.boards.length === 0 && loaded.manifest.id === 'jane-pack', 'loadout mod loads with no boards');
  }

  // ---- dependency resolution ----
  {
    const mk = (id: string, version: string, requires: Record<string, string> = {}, conflicts: Record<string, string> = {}): LoadedMod => ({
      manifest: parseManifest(JSON.stringify({ format: 'deadboard-mod/2', id, name: id, version, license: 'MIT', requires, conflicts, ...(Object.keys(requires).length ? {} : { boards: [{ file: 'amp.brd' }] }) })),
      source: { origin: 'test', name: id, files: [], read: async () => new Uint8Array() },
      boards: [], warnings: [],
    });
    const on = (...offIds: string[]) => (id: string) => !offIds.includes(id);
    const ids = (ms: LoadedMod[]) => ms.map((m) => m.manifest.id).join(',');

    // order: dependencies first, otherwise install order
    let r = resolveMods([mk('app-a', '1.0.0', { 'lib-b': '^1' }), mk('lib-b', '1.3.0', { 'lib-c': '>=2' }), mk('lib-c', '2.1.0'), mk('solo', '1.0.0')], on());
    assert(ids(r.active) === 'lib-c,lib-b,app-a,solo', `dependency order (${ids(r.active)})`);
    assert([...r.status.values()].every((s) => s.state === 'active'), 'all active');

    // missing, wrong version, turned off, and a chain that blocks its users
    r = resolveMods([
      mk('needs-missing', '1.0.0', { ghost: '^1' }),
      mk('needs-new', '1.0.0', { 'lib-b': '^2' }),
      mk('lib-b', '1.3.0'),
      mk('needs-off', '1.0.0', { 'off-lib': '*' }),
      mk('off-lib', '1.0.0'),
      mk('top', '1.0.0', { 'needs-missing': '*' }),
    ], on('off-lib'));
    const st = (id: string) => r.status.get(id)!;
    const need = (id: string) => { const s = st(id); return s.state === 'blocked' ? s.needs[0] : null; };
    assert(need('needs-missing')?.why === 'missing' && need('needs-missing')?.id === 'ghost', 'missing dependency named');
    assert(need('needs-new')?.why === 'version' && need('needs-new')?.have === '1.3.0', 'wrong version: says what you have');
    assert(need('needs-off')?.why === 'off', 'dependency turned off');
    assert(need('top')?.why === 'blocked', 'blocked dependency blocks its users');
    assert(st('off-lib').state === 'off' && st('lib-b').state === 'active', 'others unaffected');
    assert(ids(r.active) === 'lib-b', 'only lib-b runs');

    // conflicts: the mod that declares it steps aside; an inactive or other-version mod doesn't count
    r = resolveMods([mk('base', '1.0.0'), mk('rival', '1.0.0', {}, { base: '*' }), mk('picky', '1.0.0', {}, { base: '^2' })], on());
    const rv = r.status.get('rival')!;
    assert(rv.state === 'blocked' && rv.conflicts[0] === 'base' && r.status.get('picky')!.state === 'active', 'conflict blocks the declaring mod only, version-aware');
    r = resolveMods([mk('base', '1.0.0'), mk('rival', '1.0.0', {}, { base: '*' })], on('base'));
    assert(r.status.get('rival')!.state === 'active', 'no conflict with a mod that is off');

    // a /1 mod with a loose version can still satisfy a range
    const old = { ...mk('legacy', '1.0.0'), manifest: { ...mk('legacy', '1.0.0').manifest, format: 'deadboard-mod/1' as const, version: '2' } };
    r = resolveMods([old, mk('uses-legacy', '1.0.0', { legacy: '^2' })], on());
    assert(r.status.get('uses-legacy')!.state === 'active', '/1 version "2" satisfies ^2');

    // dependency cycle: no hang, both run (each needs the other, both present)
    r = resolveMods([mk('cyc-a', '1.0.0', { 'cyc-b': '*' }), mk('cyc-b', '1.0.0', { 'cyc-a': '*' })], on());
    assert(r.active.length === 2, 'cycle resolved');
  }

  // ---- loadouts ----
  {
    const mem = new Map<string, string>();
    const kv = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, val: string) => void mem.set(k, val) };
    let s = readLoadouts(kv);
    assert(s.active === MY_MODS && s.custom.length === 1 && isModOn(s, 'anything'), 'default: My mods, everything on');

    s = setModOn(s, 'noisy', false);
    assert(!isModOn(s, 'noisy') && isModOn(s, 'other'), 'turned one off');
    s = switchLoadout(s, OFFICIAL);
    assert(!isModOn(s, 'other'), 'Official: no community mods');
    s = setModOn(s, 'other', true);
    assert(s.active === MY_MODS && isModOn(s, 'other') && !isModOn(s, 'noisy'), 'turning a mod on in Official switches to My mods');

    s = switchLoadout(s, OFFICIAL);
    s = newLoadout(s, 'Hard mode!', ['noisy', 'other']);
    assert(s.active === 'hard-mode' && !isModOn(s, 'noisy') && !isModOn(s, 'other') && isModOn(s, 'brand-new'), 'new loadout from Official: installed mods off, new installs on');
    s = setModOn(s, 'noisy', true);
    s = newLoadout(s, 'Hard mode!', []);
    assert(s.active === 'hard-mode-2' && isModOn(s, 'noisy'), 'new loadout copies the active one; unique id');
    assert(switchLoadout(s, 'nope') === s, 'unknown loadout ignored');

    writeLoadouts(s, kv);
    const back = readLoadouts(kv);
    assert(back.active === 'hard-mode-2' && back.custom.length === 3, 'round trip');
    let d = deleteLoadout(back, 'hard-mode-2');
    assert(d.active === MY_MODS && d.custom.length === 2, 'deleting the active one falls back to My mods');
    d = deleteLoadout(d, MY_MODS);
    assert(d.custom.some((l) => l.id === MY_MODS), 'My mods cannot be deleted');

    mem.set('deadboard_loadouts', '{"active":"gone","custom":[{"id":"official","name":"x","off":[]},{"id":7}]}');
    const repaired = readLoadouts(kv);
    assert(repaired.active === MY_MODS && repaired.custom.length === 1 && repaired.custom[0].id === MY_MODS, 'damaged storage repaired');
    mem.set('deadboard_loadouts', 'not json');
    assert(readLoadouts(kv).active === MY_MODS, 'unreadable storage: defaults');
    assert(readLoadouts(null).active === MY_MODS, 'no storage: defaults');

    assert(safeMode('?safe') && safeMode('?boards&safe=1') && !safeMode('?boards') && !safeMode(''), 'safe mode from the address');

    // safe mode after a failed start: only when the last start ran mods and didn't finish
    const boot = new Map<string, string>();
    const bkv = { getItem: (k: string) => boot.get(k) ?? null, setItem: (k: string, val: string) => void boot.set(k, val), removeItem: (k: string) => void boot.delete(k) };
    assert(!bootBegin(bkv), 'first start: fine');
    bootModsRunning(bkv); bootDone(bkv);
    assert(!bootBegin(bkv), 'finished start with mods: fine');
    bootModsRunning(bkv); // ...and this start never finishes
    assert(bootBegin(bkv), 'unfinished start with mods: safe mode next');
    assert(!bootBegin(bkv), 'the safe start (no mods) did not finish either: mods not to blame, normal next');
    bootDone(bkv);
    assert(!bootBegin(bkv) && !bootBegin(null), 'no storage: never safe mode');
  }

  console.log('MOD KERNEL TESTS PASSED (versions + ranges, item addresses, deadboard-mod/2 manifests + /1 unchanged, loadout mods, dependency resolution: order, missing, version, off, blocked chains, conflicts, cycles; loadouts + safe mode, also after a failed start)');
}

run().catch((e) => { console.error(e); (globalThis as unknown as { process: { exitCode: number } }).process.exitCode = 1; });
