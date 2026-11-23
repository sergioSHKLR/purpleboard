// The parallel run: DEADBOARD's own puzzle statistics next to Umami for the same window, on the
// numbers both can see. When they agree (roughly a constant ratio: blockers and Do Not Track /
// GPC differ between the two), the overlapping Umami events can be cut (handoff: "Analytics
// direction").
//   npm run attempts-compare                 since the collector went live (or the last 7 days)
//   npm run attempts-compare -- --days 3
// Needs `npx wrangler login` and a logged-in Umami browser (scripts/umami.ts).
import { d1Query, MIN_GROUP } from './attempts-db';
import { eventCounts, eventValues } from './umami';

/** When the website started sending attempt records (Pages deploy with ATTEMPTS_URL). */
const GO_LIVE = Date.parse('2026-11-23T08:10:00Z');
const d = process.argv.indexOf('--days');
const days = (d >= 0 && Number(process.argv[d + 1])) || 7;
const now = Date.now();
// whole UTC days (the collector keeps only the day), never before go-live
const dayStart = new Date(now - days * 86_400_000); dayStart.setUTCHours(0, 0, 0, 0);
const startAt = Math.max(GO_LIVE, dayStart.getTime());
const since = new Date(startAt).toISOString().slice(0, 10);

const umamiId = (puzzle: string) => (puzzle === 'daily' ? 'generated' : puzzle);
const short = (id: string) => id.replace(/^builtin-/, '').replace(/^demo-/, 'demo:');

const [fixedU, testsU, stepU, counts] = await Promise.all([
  eventValues('board fixed', 'board', startAt, now),
  eventValues('tests run', 'board', startAt, now),
  eventValues('tutorial step', 'step', startAt, now),
  eventCounts(startAt, now),
]);
const ours = d1Query<{ puzzle: string; fixed: number; tested: number; tut1: number; n: number }>(`
  SELECT puzzle, SUM(outcome = 'fixed') fixed, SUM(tests <> '0') tested, SUM(tut >= 1) tut1, COUNT(*) n
  FROM attempts WHERE day >= '${since}' GROUP BY puzzle`);
const mine = new Map<string, { fixed: number; tested: number; tut1: number; n: number }>();
for (const r of ours) {
  const k = umamiId(r.puzzle), m = mine.get(k) ?? { fixed: 0, tested: 0, tut1: 0, n: 0 };
  m.fixed += r.fixed; m.tested += r.tested; m.tut1 += r.tut1; m.n += r.n;
  mine.set(k, m);
}

const ratio = (a: number, b: number) => (b ? (a / b).toFixed(2) : '-');
const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
console.log(`Parallel run since ${new Date(startAt).toISOString().slice(0, 16).replace('T', ' ')} UTC (collector days ≥ ${since})\n`);

const totalFixedOurs = [...mine.values()].reduce((a, m) => a + m.fixed, 0), totalTestedOurs = [...mine.values()].reduce((a, m) => a + m.tested, 0);
console.log(`${'metric'.padEnd(34)} ${'Umami'.padStart(7)} ${'ours'.padStart(7)}  ours/Umami`);
const line = (name: string, u: number, o: number) => console.log(`${name.padEnd(34)} ${String(u).padStart(7)} ${String(o).padStart(7)}  ${ratio(o, u)}`);
line('boards fixed', sum(fixedU), totalFixedOurs);
line('boards with a test run', sum(testsU), totalTestedOurs);
line('First Light guide shown (step 1)', stepU.get('1') ?? 0, mine.get('builtin-first-light')?.tut1 ?? 0);
line('bench ready (Umami) / attempts (ours)', counts.get('bench ready') ?? 0, [...mine.values()].reduce((a, m) => a + m.n, 0));

console.log(`\nFixes per board (boards with ≥ ${MIN_GROUP} in either):`);
const boards = new Set([...fixedU.keys(), ...mine.keys()]);
const rows = [...boards].map((b) => ({ b, u: fixedU.get(b) ?? 0, o: mine.get(b)?.fixed ?? 0 })).filter((r) => Math.max(r.u, r.o) >= MIN_GROUP).sort((a, b) => b.u - a.u);
for (const r of rows) line(`  ${short(r.b)}`, r.u, r.o);
const ratios = rows.filter((r) => r.u >= MIN_GROUP && r.o >= MIN_GROUP).map((r) => r.o / r.u);
if (ratios.length >= 3) {
  const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const spread = Math.sqrt(ratios.reduce((a, b) => a + (b - mean) ** 2, 0) / ratios.length);
  console.log(`\nPer-board ratio ${mean.toFixed(2)} ± ${spread.toFixed(2)} over ${ratios.length} boards: ${spread / mean < 0.2 ? 'consistent: the collector sees the same pattern as Umami.' : 'not consistent yet: look at the boards that stand out.'}`);
} else {
  console.log('\nToo few boards with enough fixes on both sides for a verdict yet.');
}
