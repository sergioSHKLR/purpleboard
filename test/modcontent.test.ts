// Mod platform, phase 2 (docs/MOD_PLATFORM.md): patches (JSON merge patch, board fields, order,
// conflicts, invalid patches skipped, undo), knowledge packs, puzzles built on known-good boards,
// official mods as dependencies, and the night-light-extras example mod end to end.
import { loadMod, parseManifest, type ModSource } from '../src/mods/mods';
import { applyBoardPatches, boardView, mergePatch, writeBoardView, type PatchEntry } from '../src/mods/patches';
import { parseKnowledge, staleEntries } from '../src/mods/knowledge';
import { buildPuzzle, parsePuzzle } from '../src/mods/puzzles';
import { resolveMods } from '../src/mods/resolve';
import { officialBoardAddress, officialVersions } from '../src/mods/official';
import { builtinScenarios } from '../src/scenarios/builtin';
import { referenceBoard } from '../src/scenarios/reference';
import { verifyScenario } from '../src/verify';
import { installPart } from '../src/ops';
import { readZip } from '../src/mods/zip';

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
function throws(fn: () => unknown, re: RegExp, m: string) {
  try { fn(); } catch (e) { const msg = e instanceof Error ? e.message : String(e); assert(re.test(msg), `${m}: wrong error "${msg}"`); return; }
  throw new Error(`${m}: did not throw`);
}
async function rejects(p: Promise<unknown>, re: RegExp, m: string) {
  try { await p; } catch (e) { const msg = e instanceof Error ? e.message : String(e); assert(re.test(msg), `${m}: wrong error "${msg}"`); return; }
  throw new Error(`${m}: did not throw`);
}

interface Fs { readFileSync(p: string): Uint8Array; readdirSync(p: string, o: { withFileTypes: true }): { name: string; isDirectory(): boolean }[] }
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
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

async function run() {
  const modName = 'node:fs';
  fs = (await import(/* @vite-ignore */ modName)) as Fs;

  // ---- JSON merge patch (RFC 7396 examples) ----
  {
    const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    assert(eq(mergePatch({ a: 'b' }, { a: 'c' }), { a: 'c' }), 'replace');
    assert(eq(mergePatch({ a: 'b' }, { b: 'c' }), { a: 'b', b: 'c' }), 'add');
    assert(eq(mergePatch({ a: 'b' }, { a: null }), {}), 'delete');
    assert(eq(mergePatch({ a: ['b'] }, { a: 'c' }), { a: 'c' }) && eq(mergePatch({ a: 'c' }, { a: ['b'] }), { a: ['b'] }), 'arrays replace');
    assert(eq(mergePatch({ a: { b: 'c' } }, { a: { b: 'd', c: null } }), { a: { b: 'd' } }), 'nested merge');
    assert(eq(mergePatch({ e: null }, { a: 1 }), { e: null, a: 1 }) && eq(mergePatch([1, 2], { a: 'b', c: null }), { a: 'b' }), 'non-object target');
    const t = { a: { b: 1 } };
    mergePatch(t, { a: { b: 2 } });
    assert(t.a.b === 1, 'target not modified');
  }

  const scenarios = await builtinScenarios();
  const byId = (id: string) => scenarios.find((s) => s.id === id)!;

  // ---- known-good references: every shipped challenge's pre-sabotage board passes and unlocks ----
  {
    for (const sc of scenarios) {
      const ref = referenceBoard(sc);
      assert(ref && ref !== sc.board, `${sc.id}: has a reference board`);
      const v = await verifyScenario(sc, structuredClone(ref), sc.solver ?? 'fast');
      assert(v.allPassed && (!sc.lock || v.flag), `${sc.id}: reference passes${sc.lock ? ' and unlocks the flag' : ''}`);
    }
  }

  // ---- board patches: order, conflicts, invalid ones skipped, undo ----
  {
    const sc = structuredClone(byId('builtin-ghost-short'));
    const pristine = boardView(sc);
    const e = (modId: string, set: Record<string, unknown>, why?: string): PatchEntry => ({ modId, modName: modId, patch: { target: officialBoardAddress(sc.id), set, ...(why && { why }) } });
    const res = applyBoardPatches(sc, [
      e('more-notes', { hints: [...pristine.hints, 'Fourth note'] }, 'more help'),
      e('harder', { difficulty: 5, description: 'Harder.' }),
      e('broken', { difficulty: 9 }),
      e('easier', { difficulty: 3 }),
      e('no-tests', { objectives: [{ type: 'led', ref: 'D1' }] }),
    ]);
    assert(sc.meta.hints.length === 4 && sc.meta.hints[3] === 'Fourth note', 'hints patched');
    assert(sc.meta.difficulty === 3 && sc.meta.description === 'Harder.', 'later mod wins');
    assert(res.conflicts.length === 1 && res.conflicts[0].field === 'difficulty' && res.conflicts[0].mods.join() === 'harder,easier', 'conflict reported (skipped mod not counted)');
    assert(res.skipped.map((s) => s.modId).join() === 'broken,no-tests' && /difficulty/.test(res.skipped[0].problems[0]) && /"led" objective/.test(res.skipped[1].problems[0]), 'invalid patches skipped with the reason');
    assert(res.changes.some((c) => c.modId === 'more-notes' && c.field === 'hints' && c.why === 'more help'), 'change recorded with why');
    assert(sc.objectives.length === pristine.objectives.length && sc.board.components.length > 0 && sc.lock, 'board, flag and tests untouched');
    writeBoardView(sc, pristine);
    assert(JSON.stringify(boardView(sc)) === JSON.stringify(pristine), 'undo restores the board as shipped');
    // null deletes; required fields can't be deleted
    const r2 = applyBoardPatches(sc, [e('wipe', { hints: null }), e('untitled', { title: null })]);
    assert((sc.meta.hints.length as number) === 0 && sc.meta.title === pristine.title && r2.skipped[0].modId === 'untitled', 'null clears hints; deleting the title is refused');
  }

  // ---- manifest rules for patches, knowledge, puzzles ----
  {
    const m2 = (o: Record<string, unknown>, w: string[] = []) => parseManifest(JSON.stringify({ format: 'deadboard-mod/2', id: 'jane-x', name: 'X', version: '1.0.0', license: 'MIT', requires: { 'official-boards': '^1' }, ...o }), w);
    const target = officialBoardAddress('builtin-ghost-short');
    throws(() => m2({ requires: { other: '^1' }, patches: [{ target, set: { difficulty: 3 } }] }), /"official-boards" must be listed in "requires"/, 'patch target must be required');
    throws(() => m2({ patches: [{ target: 'jane-x/boards/a', set: {} }] }), /doesn't patch its own items/, 'no self patches');
    throws(() => m2({ patches: [{ target: 'nope', set: {} }] }), /must be an item address/, 'bad address');
    const w: string[] = [];
    const mf = m2({ patches: [{ target, set: { difficulty: 3, board: { components: [] }, flag: 'x' } }, { target: 'official-boards/panels/x', set: { a: 1 } }] }, w);
    assert(mf.patches.length === 1 && Object.keys(mf.patches[0].set).join() === 'difficulty', 'only board fields kept');
    assert(w.some((x) => /can't change "board"/.test(x)) && w.some((x) => /can't change "flag"/.test(x)) && w.some((x) => /patching "panels" needs a newer version/.test(x)), 'refused fields and types are warnings');
    assert(mf.boards.length === 0, 'a mod with only patches needs no boards');
    throws(() => parseManifest(JSON.stringify({ format: 'deadboard-mod/2', id: 'official-mine', name: 'X', version: '1.0.0', license: 'MIT', boards: [{ file: 'amp.brd' }] })), /reserved/, 'official- ids reserved');
    throws(() => m2({ boards: [{ id: 'amp', file: 'amp.brd' }], puzzles: [{ id: 'amp', board: 'jane-x/boards/amp', title: 'T', faults: [{ ref: 'R1', fault: 'open-part' }] }] }), /also a board id/, 'puzzle id ≠ board id');

    const errs: string[] = [], warns: string[] = [];
    assert(!parsePuzzle({ id: 'p1', board: 'a-b/boards/c', title: 'T', faults: [{ ref: 'R1', fault: 'gremlins' }] }, 'p', errs, warns)?.faults.length && /must be one of/.test(errs[0]), 'unknown fault class');
    errs.length = 0;
    parsePuzzle({ id: 'p1', board: 'a-b/boards/c', title: 'T', faults: [{ ref: 'R1', fault: 'resistor-drift', severity: 500 }] }, 'p', errs, warns);
    assert(/severity must be a number from 1\.5 to 30/.test(errs[0]), 'severity range from the catalogue');
    errs.length = 0;
    parsePuzzle({ id: 'p1', board: 'a-b/boards/c', title: 'T', faults: [{ ref: 'R1', fault: 'open-part', severity: 2 }] }, 'p', errs, warns);
    assert(/has no severity/.test(errs[0]), 'open-part has no severity');
    errs.length = 0;
    parseKnowledge({ id: 'k1', board: 'a-b/boards/c', rails: [{ net: 'V', provenance: { confidence: 'sure' } }, { nominal: 3 }] }, 'k', errs, warns);
    assert(errs.some((e) => /confidence must be/.test(e)) && errs.some((e) => /net is required/.test(e)), 'knowledge checks');
  }

  // ---- official mods count as installed for dependencies ----
  {
    const mk = (id: string, requires: Record<string, string>) => ({ manifest: parseManifest(JSON.stringify({ format: 'deadboard-mod/2', id, name: id, version: '1.0.0', license: 'MIT', requires })), source: { origin: 't', name: id, files: [], read: async () => new Uint8Array() }, boards: [], warnings: [] });
    const r = resolveMods([mk('uses-official', { 'official-boards': '^1.0' }), mk('wants-v2', { 'official-boards': '^2.0' })], () => true, officialVersions());
    const st = r.status.get('wants-v2')!;
    assert(r.status.get('uses-official')!.state === 'active', 'official dependency met');
    assert(st.state === 'blocked' && st.needs[0].why === 'version' && st.needs[0].have === '1.0.0', 'wrong official version explained');
  }

  // ---- the example: night-light-extras on top of the starter kit ----
  {
    const kit = await loadMod(folderSource('examples/mods/starter-kit'));
    const ex = await loadMod(folderSource('examples/mods/night-light-extras'));
    const mf = ex.manifest;
    assert(ex.warnings.length === 0, `example loads cleanly (${ex.warnings.join('; ')})`);
    assert(mf.patches.length === 1 && mf.knowledge.length === 1 && mf.puzzles.length === 1 && mf.boards.length === 0, 'example: 1 patch, 1 pack, 1 puzzle, no boards');
    const r = resolveMods([kit, ex], () => true, officialVersions());
    assert(r.active.map((m) => m.manifest.id).join() === 'starter-kit,night-light-extras', 'runs after the starter kit');

    // the patch: a fourth Ghost Short note, the original three kept
    const gs = structuredClone(byId('builtin-ghost-short'));
    const orig = [...gs.meta.hints];
    const pr = applyBoardPatches(gs, [{ modId: mf.id, modName: mf.name, patch: mf.patches[0] }]);
    assert(gs.meta.hints.length === 4 && orig.every((h, i) => gs.meta.hints[i] === h) && pr.skipped.length === 0, 'example patch adds a fourth note');

    // knowledge: every part and net it names is on the board; a pack for another revision is flagged
    const sandbox = kit.boards.find((b) => b.address === 'starter-kit/boards/night-light')!;
    const nl = await sandbox.load();
    const pack = mf.knowledge[0];
    const st = staleEntries(pack, nl.board);
    assert(st.refs.length === 0 && st.nets.length === 0, 'example pack matches the board');
    assert(pack.rails[1].provenance.confidence === 'estimated' && pack.rails[0].provenance.confidence === 'documented', 'rail confidence, inherited from the pack unless set');
    const other = { ...pack, rails: [...pack.rails, { net: 'VCORE', checks: [{ at: 'U9', expect: '1 V' }], provenance: pack.provenance }] };
    const st2 = staleEntries(other, nl.board);
    assert(st2.nets.join() === 'VCORE' && st2.refs.join() === 'U9', 'parts and nets not on the board are listed');

    // the puzzle: R1 drifted ×25, D1 barely glows; replacing R1 passes and unlocks the flag
    const ref = referenceBoard(nl);
    assert(ref === nl.board, 'a board without a flag is its own reference');
    const pz = await buildPuzzle(mf.puzzles[0], mf, nl, ref!);
    assert(pz.id === 'mod-night-light-extras-barely-glows' && pz.solver === 'spice' && pz.objectives.length === 2, 'puzzle scenario: id, SPICE for a drift fault, the board\'s tests');
    assert(nl.board.components.find((c) => c.ref === 'R1')!.state.drift === undefined, 'the reference board is untouched');
    assert(!(await verifyScenario(pz, pz.board, 'spice')).allPassed, 'the planted fault fails the tests');
    const r1 = pz.board.components.find((c) => c.ref === 'R1')!;
    assert(r1.state.drift === 25, 'R1 drifted ×25');
    installPart(r1, {});
    const fixed = await verifyScenario(pz, pz.board, 'spice');
    assert(fixed.allPassed && fixed.flag === 'DEAD{dr1ft3d_r3s1st0r}', 'replacing R1 passes and unlocks the flag');

    // faults that don't fit are explained
    const bad = (faults: unknown[]) => buildPuzzle({ ...mf.puzzles[0], faults: faults as never }, mf, nl, ref!);
    await rejects(bad([{ ref: 'U7', fault: 'open-part' }]), /no part U7/, 'missing part');
    await rejects(bad([{ ref: 'D1', fault: 'resistor-drift', severity: 5 }]), /doesn't fit D1/, 'class must fit the part');
    await rejects(bad([{ ref: 'R1', fault: 'cold-joint', pad: '7' }]), /has no pad "7"/, 'pad must exist');
    // a challenge whose repair isn't known can't be a puzzle base
    const ch = kit.boards.find((b) => b.spec.file.endsWith('.pcbfix.json'))!.stub;
    assert(referenceBoard(ch) === null, 'community challenge: no reference');

    // the published download is current (npm run example-mod)
    const zipped = await readZip(new Uint8Array(fs.readFileSync('public/examples/night-light-extras.zip')));
    const folder = folderSource('examples/mods/night-light-extras');
    assert(zipped.size === folder.files.length, 'night-light-extras.zip is stale: run npm run example-mod');
    for (const f of folder.files) assert(same(zipped.get(`night-light-extras/${f}`)!, await folder.read(f)), `${f} in night-light-extras.zip is stale: run npm run example-mod`);
  }

  // ---- a puzzle on an official board: Ghost Short's working board, D1 opened ----
  {
    const gs = byId('builtin-ghost-short');
    const mf = parseManifest(JSON.stringify({ format: 'deadboard-mod/2', id: 'jane-x', name: 'X', version: '1.0.0', license: 'MIT', requires: { 'official-boards': '^1' }, puzzles: [{ id: 'dark', board: officialBoardAddress(gs.id), title: 'Dark', faults: [{ ref: 'D1', fault: 'open-part' }] }] }));
    const pz = await buildPuzzle(mf.puzzles[0], mf, gs, referenceBoard(gs)!);
    assert(!pz.lock && pz.meta.license === (gs.meta.license ?? 'MIT') && /Puzzle from the mod "X"/.test(pz.meta.credits ?? ''), 'no flag, licence and credit from the board');
    assert(!(await verifyScenario(pz, pz.board)).allPassed, 'D1 open fails');
    installPart(pz.board.components.find((c) => c.ref === 'D1')!, {});
    assert((await verifyScenario(pz, pz.board)).allPassed, 'replacing D1 passes');
  }

  console.log('MOD CONTENT TESTS PASSED (merge patch, shipped references pass + unlock, board patches: order, conflicts, skipped, undo; manifest rules, official dependencies, example mod: patch, knowledge + stale entries, puzzle fails → repair unlocks, misfit faults explained, download current; puzzle on an official board)');
}

run().catch((e) => { console.error(e); (globalThis as unknown as { process: { exitCode: number } }).process.exitCode = 1; });
