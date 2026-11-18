// Bug-report bench snapshot: board diff round trip, code survives an email (wrapped lines,
// surrounding text), imported boards are never described.
import { builtinScenarios } from '../src/scenarios/builtin';
import { addBlob, cutTrace } from '../src/ops';
import { applyBoardDiff, boardDiff, decodeSnapshot, encodeSnapshot, type BenchSnapshot } from '../src/snapshot';

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

async function run() {
  const sc = (await builtinScenarios()).find((s) => s.id === 'builtin-first-light')!;
  const orig = sc.board, cur = structuredClone(orig);
  cur.components.find((c) => c.ref === 'R1')!.value = 470;          // changed
  addBlob(cur, [62, 19], 'F', 0.8);                                  // added
  cutTrace(cur, cur.traces[0], cur.traces[0].a.map((v, i) => (v + cur.traces[0].b[i]) / 2) as [number, number], 0.5); // removed + added
  const d = boardDiff(orig, cur);
  assert(d.components?.set?.length === 1 && !d.components.del, `one part changed: ${JSON.stringify(d.components)}`);
  assert(d.blobs?.set?.length === 1, 'one blob added');
  assert((d.traces?.del?.length ?? 0) >= 1 && (d.traces?.set?.length ?? 0) >= 1, 'cut trace: removed and replaced');
  assert(!d.vias && !d.zones && !d.jumpers, 'untouched collections left out');
  const back = applyBoardDiff(orig, d);
  const key = (b: typeof orig) => JSON.stringify(['components', 'traces', 'vias', 'blobs', 'jumpers', 'zones'].map((k) => [...(b as any)[k]].sort((x: any, y: any) => x.id.localeCompare(y.id))));
  assert(key(back) === key(cur), 'diff applied to the original rebuilds the bench');
  assert(JSON.stringify(boardDiff(orig, structuredClone(orig))) === '{}', 'untouched board: empty diff');

  const snap: BenchSnapshot = {
    v: 1, build: 'test', at: '2026-11-18T00:00:00Z',
    scenario: { id: sc.id, title: sc.meta.title, shipped: true, parts: cur.components.length, traces: cur.traces.length, vias: 0 },
    diff: d,
    bench: { power: true, solver: 'fast', ocpAmps: 0, view: '3d, top, realistic', tool: 'inspect', dmm: { mode: 'V' } },
    seen: { volts: 3, amps: 0.004, cc: false, lit: ['D1'] }, toasts: ['danger: Short circuit'], errors: [], moves: 3,
  };
  const code = await encodeSnapshot(snap);
  assert(/^DBSNAP1:[A-Za-z0-9_-]+:END$/.test(code), 'one copy-pastable token');
  // as it may arrive: inside an email, wrapped every 76 characters
  const email = `Type: Bug report\nmessage: (no description: see the snapshot)\nsnapshot: ${code.replace(/(.{76})/g, '$1\r\n')}\n\n-- \nSent by FormSubmit`;
  const got = await decodeSnapshot(email);
  assert(JSON.stringify(got) === JSON.stringify(snap), 'decoded from a wrapped email unchanged');

  let msg = '';
  try { await decodeSnapshot('no code here'); } catch (e) { msg = String(e); }
  assert(/no DBSNAP1/.test(msg), 'missing code is a clear error');

  console.log('SNAPSHOT TESTS PASSED (board diff round trip, code through a wrapped email, missing code)');
}

run();
