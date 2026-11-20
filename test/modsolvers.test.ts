// Mod platform, phase 3 (docs/MOD_PLATFORM.md): solver addresses, devices (added and patched, with
// honest "verified" handling), the device overlay in the solver, and the bench check (boards,
// puzzles, patches, knowledge, devices: which boards move), as the CLI runs it.
import { parseManifest, type ModSource, loadMod, type LoadedMod } from '../src/mods/mods';
import { solverOf } from '../src/mods/solvers';
import { buildDeviceOverlay, deviceItemId, parseDevice } from '../src/mods/devices';
import { findDevice, setDeviceOverlay, deviceOverlay } from '../src/spice/devicelib';
import { checkMods as runCheck, formatReport, shippedBoards, type BoardSource } from '../src/mods/benchrun';

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
function throws(fn: () => unknown, re: RegExp, m: string) {
  try { fn(); } catch (e) { const msg = e instanceof Error ? e.message : String(e); assert(re.test(msg), `${m}: wrong error "${msg}"`); return; }
  throw new Error(`${m}: did not throw`);
}
const te = new TextEncoder();
const memMod = (manifest: Record<string, unknown>): Promise<LoadedMod> => {
  const src: ModSource = { origin: 'test', name: String(manifest.id), files: ['mod.json'], read: async () => te.encode(JSON.stringify(manifest)) };
  return loadMod(src);
};
// node:fs through a dynamic import, as in the other suites (the app's tsconfig has no Node types)
interface Fs { readFileSync(p: string, enc?: string): Uint8Array & string; readdirSync(p: string, o: { withFileTypes: true }): { name: string; isDirectory(): boolean }[] }
let fs: Fs;
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
const modFrom = (dir: string) => loadMod(folderSource(dir));
let withDemos: BoardSource[] = [], noDemos: BoardSource[] = [];
const checkMods = (mods: LoadedMod[], o: { demos?: boolean } = {}) => runCheck(mods, o.demos === false ? noDemos : withDemos);
const v2 = (o: Record<string, unknown>) => ({ format: 'deadboard-mod/2', id: 'jane-x', name: 'X', version: '1.0.0', license: 'MIT', ...o });
const BSS = 'official-solvers/devices/bss138pw';
const nmos = (vth: number) => ({ kind: 'nmos', vth, rds: [[10, 0.9], [5, 1.0]], body: [0.75, 0.115], caps: [38e-12, 4e-12, 7e-12], pins: { G: '1', S: '2', D: '3' } });

async function run() {
  const modName = 'node:fs';
  fs = (await import(/* @vite-ignore */ modName)) as Fs;
  noDemos = await shippedBoards();
  withDemos = await shippedBoards(async (f) => fs.readFileSync(`public/demos/${f}`, 'utf8'));
  // ---- solver names and addresses ----
  {
    assert(solverOf('spice') === 'spice' && solverOf('official-solvers/solvers/spice-power') === 'spice-power' && solverOf('SPICE') === null && solverOf(3) === null, 'solver names and addresses');
    const mf = parseManifest(JSON.stringify(v2({ boards: [{ file: 'amp.brd', solver: 'official-solvers/solvers/spice-power' }] })));
    assert(mf.boards[0].solver === 'spice-power', 'a board names its solver by address');
    throws(() => parseManifest(JSON.stringify(v2({ boards: [{ file: 'amp.brd', solver: 'turbo' }] }))), /solver must be/, '/2: unknown solver is an error');
    const w: string[] = [];
    const m1 = parseManifest(JSON.stringify({ format: 'deadboard-mod/1', id: 'old', name: 'Old', license: 'MIT', boards: [{ file: 'amp.brd', solver: 'turbo' }] }), w);
    assert(!m1.boards[0].solver && /ignored/.test(w[0]), '/1: unknown solver ignored with a note, as before');
    const pm = parseManifest(JSON.stringify(v2({ requires: { 'official-boards': '^1' }, patches: [{ target: 'official-boards/boards/builtin-ghost-short', set: { solver: 'official-solvers/solvers/spice' } }] })));
    assert(pm.patches[0].set.solver === 'spice', 'patched solver address becomes the solver name');
  }

  // ---- devices: parsing ----
  {
    assert(deviceItemId('BSS138PW') === 'bss138pw' && deviceItemId('GREEN-56MCD-2MA-2.65V') === 'green-56mcd-2ma-2.65v' && deviceItemId('2N7002,215') === '2n7002-215', 'device item ids');
    const errs: string[] = [], warns: string[] = [];
    const d = parseDevice({ mpn: 'MY-FET1', description: 'N-MOSFET', pkg: 'SOT-23', units: [nmos(1.1)], colour: 'x' }, 'd', errs, warns);
    assert(d && !errs.length && d.verified === false && /unknown field "colour"/.test(warns[0]), 'a valid device; unverified by default');
    const bad = (u: unknown, re: RegExp, m: string) => { const e: string[] = []; parseDevice({ mpn: 'X1', units: [u] }, 'd', e, []); assert(e.some((x) => re.test(x)), `${m} (${e.join('; ')})`); };
    bad({ ...nmos(1), vth: -1 }, /vth must be/, 'negative Vth refused');
    bad({ ...nmos(1), pins: { G: '1', S: '2' } }, /pins must name the D, G and S/, 'missing pin');
    bad({ kind: 'triode' }, /kind must be/, 'unknown kind');
    bad({ kind: 'led', vf: [[2, 0.02], [-1, 0.01]], pins: { A: '2', K: '1' } }, /vf must list/, 'bad forward point');
    const e2: string[] = [];
    parseDevice({ mpn: 'X1', units: [nmos(1)], verified: true }, 'd', e2, []);
    assert(e2.some((x) => /needs a "source"/.test(x)), 'verified needs a source');
    throws(() => parseManifest(JSON.stringify(v2({ devices: [{ mpn: 'A1', units: [nmos(1)] }, { mpn: 'a1', units: [nmos(1)] }] }))), /listed twice/, 'same part twice');
  }

  // ---- devices: overlay (added, patched, verified honesty, conflicts, skipped) ----
  {
    const base = findDevice('BSS138PW')!;
    assert(base.verified && (base.units[0] as { vth: number }).vth === 1.2, 'library entry');
    const patcher = await memMod(v2({ id: 'high-vth', requires: { 'official-solvers': '^1' }, patches: [{ target: BSS, set: { units: [nmos(2.6)] }, why: 'worst case' }] }));
    const sourced = await memMod(v2({ id: 'sourced', requires: { 'official-solvers': '^1' }, patches: [{ target: BSS, set: { units: [nmos(1.3)], source: 'Nexperia BSS138PW Rev. 2' } }] }));
    const broken = await memMod(v2({ id: 'broken', requires: { 'official-solvers': '^1' }, patches: [{ target: BSS, set: { units: [{ kind: 'nmos', vth: 1 }] } }] }));
    const adder = await memMod(v2({ id: 'adder', devices: [{ mpn: 'MY-FET1', description: 'N-MOSFET', units: [nmos(1.1)] }] }));
    const adder2 = await memMod(v2({ id: 'adder-two', devices: [{ mpn: 'MY-FET1', description: 'other', units: [nmos(1.5)] }] }));

    let o = buildDeviceOverlay([patcher]);
    const p = o.overlay.find((d) => d.mpn === 'BSS138PW')!;
    assert((p.units[0] as { vth: number }).vth === 2.6 && !p.verified && /values changed by high-vth \(worst case\)/.test(p.note ?? ''), 'unsourced change: no longer verified, note says who');
    assert(o.log.get(BSS)!.res.changes[0].field === 'units', 'change logged');
    o = buildDeviceOverlay([sourced]);
    assert(o.overlay[0].verified && o.overlay[0].source === 'Nexperia BSS138PW Rev. 2', 'a patch with its own datasheet stays verified');
    o = buildDeviceOverlay([patcher, sourced]);
    assert((o.overlay[0].units[0] as { vth: number }).vth === 1.3 && o.log.get(BSS)!.res.conflicts[0].mods.join() === 'high-vth,sourced', 'later patch wins, conflict reported');
    o = buildDeviceOverlay([broken]);
    assert(o.overlay.length === 0 && /rds must list/.test(o.log.get(BSS)!.res.skipped[0].problems.join()), 'an invalid patch is skipped');
    o = buildDeviceOverlay([adder, adder2]);
    assert(o.overlay.length === 1 && o.overlay[0].description === 'other' && o.clashes[0].mpn === 'MY-FET1' && o.addresses.has('adder/devices/my-fet1'), 'two mods adding one part: later wins, clash reported');

    // the solver's lookup sees the overlay, and only while it is set
    assert(!findDevice('MY-FET1'), 'not in the library');
    setDeviceOverlay(buildDeviceOverlay([adder, patcher]).overlay);
    assert(findDevice('MY-FET1')?.description === 'N-MOSFET' && (findDevice('BSS138PW')!.units[0] as { vth: number }).vth === 2.6, 'overlay used by findDevice');
    assert(deviceOverlay().length === 2, 'overlay listed for the worker');
    setDeviceOverlay(null);
    assert(!findDevice('MY-FET1') && findDevice('BSS138PW') === base, 'cleared: library again');
  }

  // ---- bench check: the examples pass ----
  {
    const kit = await modFrom('examples/mods/starter-kit');
    const ex = await modFrom('examples/mods/night-light-extras');
    let r = await checkMods([kit], { demos: false });
    assert(r.findings.length === 2 && r.findings.every((f) => f.level === 'pass'), `starter kit passes:\n${formatReport(r)}`);
    r = await checkMods([ex, kit], { demos: false });
    assert(r.findings.length === 3 && r.findings.every((f) => f.level === 'pass'), `night-light-extras passes:\n${formatReport(r)}`);
    let threw = false;
    try { await checkMods([ex], { demos: false }); } catch (e) { threw = /needs starter-kit \^1\.0/.test(String(e)); }
    assert(threw, 'a missing dependency is named');
  }

  // ---- bench check: what it catches ----
  {
    const bad = await memMod(v2({
      requires: { 'official-boards': '^1' },
      patches: [{ target: 'official-boards/boards/builtin-ghost-short', set: { objectives: [{ type: 'voltage', a: 'TP1', min: 4.9, max: 5 }] } }],
      puzzles: [{ id: 'invisible', board: 'official-boards/boards/builtin-ghost-short', title: 'Invisible', faults: [{ ref: 'R1', fault: 'liquid-leakage', severity: 50000 }] }],
      knowledge: [{ id: 'kp', board: 'official-boards/boards/builtin-ghost-short', rails: [{ net: 'VCORE', checks: [{ at: 'U9', expect: '1 V' }] }] }],
    }));
    const r = await checkMods([bad], { demos: false });
    const f = (re: RegExp) => r.findings.find((x) => re.test(x.text));
    assert(f(/working board fails the patched tests/)?.level === 'fail', `impossible patched test caught:\n${formatReport(r)}`);
    assert(f(/working board fails the puzzle's tests|faults don't show/)?.level === 'fail', `puzzle that can't work caught:\n${formatReport(r)}`);
    assert(f(/names what the board doesn't have: U9, VCORE/)?.level === 'warn', 'stale knowledge caught');
  }

  // ---- bench check: a device patch moves the boards that use the part (done-when of phase 3) ----
  {
    const hv = await memMod(v2({ id: 'high-vth', requires: { 'official-solvers': '^1' }, patches: [{ target: BSS, set: { units: [nmos(2.6)] } }] }));
    const r = await checkMods([hv]);
    assert(r.moved.length === 1 && r.moved[0].address === 'official-boards/boards/demo-antmicro-jetson-nano-bb', `only the Jetson demo uses the BSS138PW:\n${formatReport(r)}`);
    const m = r.moved[0];
    assert(m.netsMoved > 0 && m.nets.every((n) => Math.abs(n.after - n.before) > 0.005) && m.testsBefore && m.testsAfter, 'nets that moved are listed; the working board still passes');
    assert(r.findings.some((x) => x.level === 'warn' && /T1/.test(x.text)), 'the parts that use it are named');
    assert(deviceOverlay().length === 0 || deviceOverlay().every((d) => d.mpn !== 'BSS138PW' || (d.units[0] as { vth: number }).vth === 2.6), 'overlay restored after the check');
  }

  console.log('MOD SOLVER TESTS PASSED (solver addresses, /1 unchanged; devices: parsing, overlay add / patch / verified honesty / conflicts / skipped, solver lookup; bench check: examples pass, bad patch / puzzle / knowledge caught, device patch → the boards that move)');
}

run().catch((e) => { console.error(e); (globalThis as unknown as { process: { exitCode: number } }).process.exitCode = 1; });
