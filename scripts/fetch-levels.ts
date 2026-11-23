// Before the site build (Pages workflow): the fitted "real" puzzle levels from the public stats
// summary (stats.deadboard.org/v1/summary) into public/fitted-levels.json, which the hidden
// difficulty system reads (src/scenarios/adaptive.ts). Only levels the summary has fitted (enough
// real attempts); never fails the build: on any problem the file stays as it is (empty in git).
//   npx tsx scripts/fetch-levels.ts [summary URL]
import { writeFileSync } from 'node:fs';
import type { PublicSummary } from '../src/attempts/summary';

const url = process.argv[2] ?? 'https://stats.deadboard.org/v1/summary';
try {
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const s = (await r.json()) as PublicSummary;
  if (s.v !== 1 || !Array.isArray(s.puzzles)) throw new Error('unknown format');
  const levels: Record<string, number> = {};
  for (const p of s.puzzles) {
    if (p.fitted === null || p.from || !/^(builtin|demo)-[a-z0-9-]+$/.test(p.puzzle)) continue;
    if (typeof p.fitted === 'number' && p.fitted >= 0 && p.fitted <= 10) levels[p.puzzle] = p.fitted;
  }
  writeFileSync(new URL('../public/fitted-levels.json', import.meta.url), `${JSON.stringify({ made: s.made, levels })}\n`);
  console.log(`fitted levels: ${Object.keys(levels).length} puzzle(s) (summary ${s.made})`);
} catch (e) {
  console.log(`fitted levels: kept as they are (${e instanceof Error ? e.message : String(e)})`);
}
