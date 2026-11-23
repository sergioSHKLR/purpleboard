// Puzzle health report from DEADBOARD's own puzzle statistics (collector/, src/attempts/).
//   npm run attempts-report                 last 7 days, from the live database (needs `npx wrangler login`)
//   npm run attempts-report -- --days 30
//   npm run attempts-report -- --local      the local database of `wrangler dev` (collector/README.md)
// Groups with fewer than MIN_GROUP attempts are shown as "<10": small groups could point at a person.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MIN_GROUP = 10;
const args = process.argv.slice(2);
const days = Number(args[args.indexOf('--days') + 1]) || 7;
const where = args.includes('--local') ? '--local' : '--remote';
const collector = fileURLToPath(new URL('../collector/', import.meta.url));

function query<T>(sql: string): T[] {
  const out = execFileSync('npx', ['--yes', 'wrangler@4', 'd1', 'execute', 'deadboard-attempts', where, '--json', '--command', sql], { cwd: collector, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const res = JSON.parse(out) as { results: T[] }[];
  return res[0]?.results ?? [];
}

const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '-');
const small = (n: number) => n < MIN_GROUP;

interface Row { puzzle: string; src: string; level: number; n: number; fixed: number; lefts: number; switched: number; no_tests: number; first_pass: number; noted: number; looked: number; phone: number; phone_fixed: number; long: number }
const rows = query<Row>(`
  SELECT puzzle, src, MAX(level) level, COUNT(*) n,
    SUM(outcome = 'fixed') fixed, SUM(outcome = 'left') lefts, SUM(outcome = 'switched') switched,
    SUM(tests = '0') no_tests, SUM(first_test = 'pass') first_pass, SUM(notes > 0) noted, SUM(look <> '0') looked,
    SUM(layout = 'phone') phone, SUM(layout = 'phone' AND outcome = 'fixed') phone_fixed,
    SUM(active IN ('10-20m', '20-40m', '40m+')) long
  FROM attempts WHERE day >= '${since}' GROUP BY puzzle, src ORDER BY level, puzzle`);

console.log(`Puzzle health, ${since} → today (${where.slice(2)}), ${rows.reduce((a, r) => a + r.n, 0)} attempts\n`);
console.log(['puzzle'.padEnd(34), 'lvl', 'tries', 'fixed', 'left', 'no test', 'notes', 'look', 'phone fixed', 'flags'].join('  '));
for (const r of rows) {
  const name = (r.puzzle === 'daily' || r.puzzle === 'generated' ? `${r.puzzle}:${r.src.replace(/^builtin-/, '')}` : r.puzzle.replace(/^builtin-/, '')).slice(0, 34);
  if (small(r.n)) { console.log([name.padEnd(34), r.level.toFixed(1), '<10'].join('  ')); continue; }
  const flags: string[] = [];
  if (r.fixed / r.n < 0.3) flags.push('HARD (fix < 30%)');
  if (r.fixed / r.n > 0.95 && r.level >= 2) flags.push('easy for its level');
  if (r.no_tests / r.n > 0.5) flags.push('most leave before testing');
  if (r.noted / r.n > 0.5) flags.push('notes needed');
  if (r.phone >= MIN_GROUP && r.phone_fixed / r.phone < 0.5 * (r.fixed / r.n)) flags.push('phones struggle');
  if (r.long / r.n > 0.4) flags.push('long');
  console.log([name.padEnd(34), r.level.toFixed(1), String(r.n).padStart(5), pct(r.fixed, r.n).padStart(5), pct(r.lefts, r.n).padStart(4), pct(r.no_tests, r.n).padStart(7), pct(r.noted, r.n).padStart(5), pct(r.looked, r.n).padStart(4), (r.phone >= MIN_GROUP ? pct(r.phone_fixed, r.phone) : '<10').padStart(11), flags.join(', ')].join('  '));
}

// First Light: how far the guide got, for attempts that ended without a fix
const tut = query<{ tut: number; n: number }>(`SELECT tut, COUNT(*) n FROM attempts WHERE day >= '${since}' AND puzzle = 'builtin-first-light' AND outcome <> 'fixed' GROUP BY tut ORDER BY tut`);
if (tut.length) console.log(`\nFirst Light, not fixed, by furthest guide step: ${tut.map((t) => `${t.tut}: ${small(t.n) ? '<10' : t.n}`).join(' · ')}`);
