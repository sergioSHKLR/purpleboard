// DEADBOARD's own puzzle statistics: the record's rules, the game-side tracker, and the collector
// (request handling + its real SQL on SQLite, the engine D1 runs).
import { AttemptTracker, attemptsEnabled, browserOptedOut, MIN_ACTIVE_SEC, type AttemptContext, type PuzzleInfo } from '../src/attempts/client';
import { checkRecord, FIELDS, inRange, ACTIVE_RANGES, COUNT_RANGES, shortHash, type AttemptRecord } from '../src/attempts/record';
import { d1Store, dayBefore, handle, KEEP_DAYS, type Store } from '../collector/core';
import { SITE_HOST } from '../src/analytics';
import { crossValidate, engaged, fitRasch, levelScale, type Obs } from '../src/attempts/difficulty';
import { buildSummary, SUMMARY_DAYS, type PublicSummary } from '../src/attempts/summary';

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

// Node modules through a variable (the project has no Node typings; see test/catalog.test.ts)
interface Sqlite { exec(sql: string): void; prepare(sql: string): { run(...a: never[]): unknown; get(...a: never[]): unknown; all(...a: never[]): unknown[] } }
const fsName = 'node:fs', sqliteName = 'node:sqlite';
const { readFileSync } = (await import(/* @vite-ignore */ fsName)) as { readFileSync(p: URL, enc: 'utf8'): string };
const { DatabaseSync } = (await import(/* @vite-ignore */ sqliteName)) as { DatabaseSync: new (p: string) => Sqlite };

// ---- ranges and hash
assert(inRange(ACTIVE_RANGES, 0) === '<1m' && inRange(ACTIVE_RANGES, 59.9) === '<1m' && inRange(ACTIVE_RANGES, 60) === '1-2m' && inRange(ACTIVE_RANGES, 1e6) === '40m+', 'active ranges');
assert(inRange(COUNT_RANGES, 0) === '0' && inRange(COUNT_RANGES, 5) === '3-5' && inRange(COUNT_RANGES, 21) === '21+' && inRange(COUNT_RANGES, NaN) === '0' && inRange(COUNT_RANGES, -3) === '0', 'count ranges');
assert(/^[0-9a-f]{8}$/.test(shortHash('board')) && shortHash('a') !== shortHash('b') && shortHash('x') === shortHash('x'), 'short hash');

// ---- the tracker builds records that pass the collector's check
const sent: { rec: AttemptRecord; final: boolean }[] = [];
let n = 0;
const count = (): number => sent.length;
const tracker = new AttemptTracker((rec, final) => sent.push({ rec, final }), '0.1.0+1b3e2ad', () => (++n).toString(16).padStart(32, '0'));
const firstLight: PuzzleInfo = { puzzle: 'builtin-first-light', kind: 'tutorial', from: '', pv: shortHash('fl'), level: 0.8, faults: 0 };
const ctx: AttemptContext = { layout: 'phone', lang: 'en', solvedBefore: 0, daysSinceFirst: 0 };

tracker.begin(firstLight, ctx);
tracker.active(MIN_ACTIVE_SEC - 1);
tracker.begin(firstLight, ctx); // browsing: nothing done, under the minimum → not sent
assert(count() === 0, 'a glance is not an attempt');

tracker.tool('dmm'); tracker.probe(); tracker.probe(); tracker.tool('inspect'); tracker.tool('jumper'); tracker.move();
tracker.tutStep(2); tracker.tutStep(1); tracker.active(75);
tracker.tests(false, false);
tracker.hidden(); // tab hidden: what we have, as "left"
assert(count() === 1 && !sent[0].final && sent[0].rec.outcome === 'left', 'hidden sends a provisional "left"');
tracker.note(); tracker.tests(true, true); // back, fixed it
assert(count() === 2 && sent[1].final && sent[1].rec.outcome === 'fixed', 'the fix is the final record');
assert(sent[0].rec.attempt === sent[1].rec.attempt, 'the final record replaces the provisional one (same token)');
const fixed = sent[1].rec;
assert(fixed.tools.join() === 'dmm,jumper' && fixed.probes === '2' && fixed.moves === '1' && fixed.tests === '2' && fixed.firstTest === 'fail', `counts: ${JSON.stringify(fixed)}`);
assert(fixed.tut === 2 && fixed.notes === 1 && fixed.active === '1-2m' && fixed.nth === '2' && fixed.days === '0' && fixed.solved === '0', `context: ${JSON.stringify(fixed)}`);
for (const { rec } of sent) { const r = checkRecord(rec); assert(typeof r !== 'string', `tracker record refused: ${r}`); }
tracker.begin(firstLight, ctx); // the fixed attempt is over: nothing more about it
assert(count() === 2, 'a fixed attempt is not sent again');
tracker.video('solution'); tracker.begin({ puzzle: 'daily', kind: 'daily', from: 'builtin-smoke-test', pv: shortHash('d'), level: 3.6, faults: 2 }, { ...ctx, layout: 'desktop', solvedBefore: 7, daysSinceFirst: 12 });
assert(count() === 3 && sent[2].rec.outcome === 'switched' && sent[2].rec.video === 'solution', 'switching boards ends the attempt');
tracker.probe(); tracker.hidden(); tracker.hidden();
const daily = sent[sent.length - 1].rec;
assert(daily.kind === 'daily' && daily.from === 'builtin-smoke-test' && daily.solved === '6-10' && daily.days === '8-30' && typeof checkRecord(daily) !== 'string', `daily record: ${JSON.stringify(daily)}`);

// ---- the record check refuses everything else
const good = JSON.parse(JSON.stringify(fixed)) as Record<string, unknown>;
const bad: [string, (r: Record<string, unknown>) => void][] = [
  ['extra field (an id)', (r) => { r.user = 'abc'; }],
  ['missing field', (r) => { delete r.layout; }],
  ['free text in puzzle', (r) => { r.puzzle = 'my board <b>'; }],
  ['custom board by name', (r) => { r.kind = 'custom'; r.puzzle = 'builtin-my-own'; }],
  ['exact time instead of a range', (r) => { r.active = 437; }],
  ['unknown tool', (r) => { r.tools = ['dmm', 'laser']; }],
  ['unsorted tools', (r) => { r.tools = ['jumper', 'dmm']; }],
  ['level with more digits', (r) => { r.level = 0.83; }],
  ['level out of range', (r) => { r.level = 11; }],
  ['fixed without tests', (r) => { r.tests = '0'; r.firstTest = 'none'; }],
  ['short token', (r) => { r.attempt = 'abc'; }],
  ['build with text', (r) => { r.build = '0.1.0 (my mac)'; }],
  ['ab with text', (r) => { r.ab = 'hello world'; }],
  ['generated without its board', (r) => { r.kind = 'generated'; r.puzzle = 'generated'; r.from = ''; r.faults = 1; }],
  ['array', () => {}],
];
assert(typeof checkRecord(good) !== 'string', 'the good record passes');
for (const [what, spoil] of bad) {
  const r = what === 'array' ? [] : JSON.parse(JSON.stringify(good));
  spoil(r);
  assert(typeof checkRecord(r) === 'string', `refused: ${what}`);
}

// ---- where it sends
assert(attemptsEnabled('https://stats.deadboard.org/v1/attempt', SITE_HOST), 'website + collector address: on');
assert(!attemptsEnabled('', SITE_HOST) && !attemptsEnabled('http://stats.deadboard.org/v1/attempt', SITE_HOST), 'no / plain-http address: off');
for (const host of ['localhost', '', 'tholtman1-del.github.io']) assert(!attemptsEnabled('https://stats.deadboard.org/v1/attempt', host), `${host || 'app'}: off`);
assert(browserOptedOut({ doNotTrack: '1' }) && browserOptedOut({ globalPrivacyControl: true }) && !browserOptedOut({}), 'Do Not Track / GPC respected');

// ---- the collector: requests
const ORIGIN = 'https://deadboard.org';
const cfg = { origin: ORIGIN, cap: 3 };
const mem = new Map<string, { rec: AttemptRecord; day: string }>();
let accepted = 0;
const fake: Store = { accepted: async () => accepted, put: async (rec, day) => { mem.set(rec.attempt, { rec, day }); accepted++; }, maintain: async () => {}, summary: async () => '{"v":1}', refreshSummary: async () => {} };
const post = (body: string, headers: Record<string, string> = { Origin: ORIGIN }, path = '/v1/attempt') =>
  handle(new Request(`https://stats.deadboard.org${path}`, { method: 'POST', body, headers }), fake, cfg, new Date('2026-11-23T10:00:00Z'));
const okBody = JSON.stringify(fixed);
assert((await post(okBody)).status === 204, 'a good record is stored');
assert(mem.get(fixed.attempt)?.day === '2026-11-23', 'stored with the UTC day');
assert((await post(okBody, { Origin: 'https://evil.example' })).status === 403, 'other sites refused');
assert((await post(okBody, {})).status === 403, 'no origin refused');
assert((await post('{"v":1')).status === 400, 'broken JSON refused');
assert((await post(JSON.stringify({ ...fixed, ip: '1.2.3.4' }))).status === 400, 'extra fields refused');
assert((await post('x'.repeat(5000))).status === 413, 'big bodies refused');
assert((await post(okBody, { Origin: ORIGIN }, '/admin')).status === 404, 'other paths: 404');
const pre = await handle(new Request('https://stats.deadboard.org/v1/attempt', { method: 'OPTIONS' }), fake, cfg);
assert(pre.status === 204 && pre.headers.get('Access-Control-Allow-Origin') === ORIGIN, 'CORS preflight');
await post(JSON.stringify(sent[2].rec)); await post(JSON.stringify(daily));
assert((await post(okBody)).status === 429, 'daily cap');

// ---- the collector: its SQL on SQLite (D1 is SQLite)
const db = new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('../collector/schema.sql', import.meta.url), 'utf8'));
const stmt = (sql: string, args: unknown[] = []) => ({
  sql, args,
  bind: (...a: unknown[]) => stmt(sql, a),
  run: async () => db.prepare(sql).run(...(args as never[])),
  first: async <T>() => (db.prepare(sql).get(...(args as never[])) ?? null) as T | null,
  all: async <T>() => ({ results: db.prepare(sql).all(...(args as never[])) as T[] }),
});
const d1 = { prepare: (sql: string) => stmt(sql), batch: async (s: ReturnType<typeof stmt>[]) => { db.exec('BEGIN'); try { for (const x of s) await x.run(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } } };
const store = d1Store(d1 as never);
const today = '2026-11-23';
await store.put(sent[0].rec, today); // provisional "left"
await store.put(sent[1].rec, today); // final "fixed", same token
const rows = db.prepare('SELECT * FROM attempts').all() as Record<string, unknown>[];
assert(rows.length === 1 && rows[0].outcome === 'fixed' && rows[0].tools === 'dmm,jumper' && rows[0].src === '' && rows[0].first_test === 'fail', `upsert by token: ${JSON.stringify(rows)}`);
assert(Object.keys(rows[0]).length === FIELDS.length + 1, 'one column per field + day');
assert(await store.accepted(today) === 2, 'daily count');
await store.put(sent[2].rec, dayBefore(today, 1));
await store.put(daily, dayBefore(today, 2));
const old = { ...fixed, attempt: 'f'.repeat(32) };
await store.put(old, dayBefore(today, KEEP_DAYS + 1));
await store.maintain(today);
const after = db.prepare('SELECT day, attempt, puzzle, outcome FROM attempts ORDER BY day').all() as { day: string; attempt: string | null }[];
assert(after.length === 3, `rows older than ${KEEP_DAYS} days deleted: ${JSON.stringify(after)}`);
assert(after.find((r) => r.day === dayBefore(today, 2))?.attempt === null, 'tokens older than a day erased');
assert(after.find((r) => r.day === dayBefore(today, 1))?.attempt && after.find((r) => r.day === today)?.attempt, 'recent tokens kept (a returning player can still finish)');
const totals = db.prepare('SELECT * FROM totals').all() as Record<string, unknown>[];
assert(totals.length === 1 && totals[0].n === 1 && totals[0].puzzle === 'builtin-first-light' && totals[0].outcome === 'fixed', `expired rows folded into totals: ${JSON.stringify(totals)}`);
await store.maintain(today); // running twice changes nothing
assert((db.prepare('SELECT SUM(n) s FROM totals').get() as { s: number }).s === 1, 'maintenance is idempotent');

// ---- the public summary: built from the database, small groups left out
const sumReq = await handle(new Request('https://stats.deadboard.org/v1/summary'), fake, cfg);
assert(sumReq.status === 200 && sumReq.headers.get('Access-Control-Allow-Origin') === '*' && (await sumReq.text()) === '{"v":1}', 'GET /v1/summary is public');
for (let i = 0; i < 12; i++) await store.put({ ...fixed, attempt: (i + 100).toString(16).padStart(32, 'a'), outcome: i < 9 ? 'fixed' : 'left', layout: i < 4 ? 'phone' : 'desktop' }, today);
await store.refreshSummary(new Date(`${today}T12:00:00Z`));
const pub = JSON.parse((await store.summary())!) as PublicSummary;
const fl = pub.puzzles.find((p) => p.puzzle === 'builtin-first-light')!;
assert(pub.v === 1 && pub.days === SUMMARY_DAYS && fl.attempts === 14 && fl.fixed === 10 && fl.noTests === 1, `summary totals: ${JSON.stringify(fl)}`);
assert(fl.phoneAttempts === null && fl.phoneFixed === null, 'phone group under 10: left out');
const smallP = pub.puzzles.find((p) => p.puzzle === 'builtin-tut-polarity');
assert(!smallP || (smallP.attempts === null && smallP.fixed === null && smallP.typicalTime === null), 'puzzle under 10: no numbers');
assert(fl.typicalTime === '1-2m' && fl.fitted === null, `typical time, no fit without enough data: ${JSON.stringify(fl)}`);
// with enough data the summary carries fitted levels on the shown scale
const big = buildSummary({
  puzzles: [['a', 1, 0.8], ['b', 2, 0.5], ['c', 4, 0.2]].map(([p, level, rate]) => ({ puzzle: `builtin-${p}`, src: '', kind: 'challenge', level: level as number, n: 200, fixed: Math.round(200 * (rate as number)), phone: 80, phone_fixed: 30, noted: 20, looked: 10, no_tests: 30, engaged: 200 })),
  active: [{ puzzle: 'builtin-a', src: '', active: '2-5m', n: 200 }],
  cells: [['a', 0.8], ['b', 0.5], ['c', 0.2]].map(([p, rate]) => ({ puzzle: `builtin-${p}`, src: '', solved: '0', n: 200, fixed: Math.round(200 * (rate as number)) })),
  days: [{ day: today, n: 600, fixed: 300 }],
  first: [{ layout: 'phone', n: 50, tool: 30, tested: 20, fixed: 10 }, { layout: 'desktop', n: 4, tool: 4, tested: 4, fixed: 4 }],
}, new Date(), today);
const fa = big.puzzles.find((p) => p.puzzle === 'builtin-a')!, fc = big.puzzles.find((p) => p.puzzle === 'builtin-c')!;
assert(fa.fitted !== null && fc.fitted !== null && fa.fitted < fc.fitted && fa.fittedPm! > 0, `fitted levels: ${fa.fitted} < ${fc.fitted}`);
assert(big.firstVisit.length === 1 && big.firstVisit[0].layout === 'phone', 'first-visit group under 10 left out');

// ---- fitted difficulty (src/attempts/difficulty.ts) on synthetic players with known truth
{
  let seed = 7;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
  const truth: Record<string, number> = { easy: -1.5, mid: 0, hard: 1.5, harder: 2.5 };
  const bandAbility: Record<string, number> = { '0': 0, '3-5': 1, '11+': 2 };
  const obs: Obs[] = [];
  for (let i = 0; i < 6000; i++) {
    const puzzle = Object.keys(truth)[i % 4], band = Object.keys(bandAbility)[Math.floor(rnd() * 3)];
    obs.push({ puzzle, band, fixed: rnd() < 1 / (1 + Math.exp(-(bandAbility[band] - truth[puzzle]))) });
  }
  const fit = fitRasch(obs, { l2: 0.01 });
  const d = (p: string) => fit.puzzles.get(p)!.difficulty;
  assert(d('easy') < d('mid') && d('mid') < d('hard') && d('hard') < d('harder'), 'difficulty order recovered');
  for (const p of Object.keys(truth)) assert(Math.abs(d(p) - truth[p]) < 0.25, `${p}: fitted ${d(p).toFixed(2)} vs true ${truth[p]}`);
  assert(Math.abs(fit.bands.get('11+')! - 2) < 0.25 && fit.bands.get('0') === 0, `band abilities: ${[...fit.bands].join(' ')}`);
  // a puzzle nobody fixed is hard, not infinite
  const none = fitRasch([...obs.slice(0, 200), ...Array.from({ length: 5 }, () => ({ puzzle: 'wall', band: '0', fixed: false }))]);
  assert(Number.isFinite(none.puzzles.get('wall')!.difficulty) && none.puzzles.get('wall')!.difficulty > 1, 'unsolved puzzle: finite and hard');
  assert(engaged({ tests: '1', active: '<1m' }) && engaged({ tests: '0', active: '1-2m' }) && !engaged({ tests: '0', active: '<1m' }), 'engaged attempts');
  // hand-set levels: right order → the level model is as good; one level wrong → the fitted model predicts better
  const right = new Map([['easy', 1], ['mid', 2.5], ['hard', 4], ['harder', 5]]);
  const scale = levelScale(fit, right);
  assert(scale && scale.b > 0 && scale.used === 4, `level scale: ${JSON.stringify(scale)}`);
  const cvRight = crossValidate(obs, right), cvWrong = crossValidate(obs, new Map([...right, ['harder', 1]]));
  assert(cvRight.fitted - cvRight.level < 0.01, `levels right: no real gain (${cvRight.level.toFixed(3)} vs ${cvRight.fitted.toFixed(3)})`);
  assert(cvWrong.level - cvWrong.fitted > 0.03, `a wrong level shows (${cvWrong.level.toFixed(3)} vs ${cvWrong.fitted.toFixed(3)})`);
}

console.log('attempts: ok (record rules, tracker, collector requests + SQL, fitted difficulty, public summary)');
