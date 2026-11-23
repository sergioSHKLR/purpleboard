// Fitted puzzle difficulty (src/attempts/difficulty.ts) from DEADBOARD's puzzle statistics, next
// to the level each puzzle shows. Checkpoint 2 of the analytics plan: does the fitted model predict
// solve rates better than the hand-set levels (cross-validated)? If so, the table says which
// levels to move.
//   npm run attempts-difficulty                  last 30 days, live database
//   npm run attempts-difficulty -- --days 60 --min 30
//   npm run attempts-difficulty -- --local
import { crossValidate, engaged, fitRasch, levelScale, type Obs } from '../src/attempts/difficulty';
import { d1Query, MIN_GROUP, sinceArg } from './attempts-db';

const { since } = sinceArg(30);
const minAt = process.argv.indexOf('--min');
const minN = Math.max(MIN_GROUP, (minAt >= 0 && Number(process.argv[minAt + 1])) || 20);

interface Row { puzzle: string; src: string; solved: string; outcome: string; tests: string; active: string; level: number }
const rows = d1Query<Row>(`SELECT puzzle, src, solved, outcome, tests, active, level FROM attempts WHERE day >= '${since}' AND kind <> 'custom'`);
const key = (r: Row) => (r.src ? `${r.puzzle}:${r.src.replace(/^builtin-/, '')}` : r.puzzle.replace(/^builtin-/, ''));
const use = rows.filter(engaged);
// shuffled once (fixed seed) so the cross-validation folds mix days
let seed = 1;
const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
const obs: Obs[] = use.map((r) => ({ puzzle: key(r), band: r.solved, fixed: r.outcome === 'fixed' })).map((o) => ({ o, k: rnd() })).sort((a, b) => a.k - b.k).map(({ o }) => o);
const levels = new Map<string, number>();
for (const r of use) levels.set(key(r), Math.max(levels.get(key(r)) ?? 0, r.level));

console.log(`Fitted difficulty, ${since} → today: ${rows.length} attempts, ${use.length} engaged (tests run or ≥ 1 min active)`);
if (obs.length < 3 * minN) { console.log(`Too few engaged attempts for a fit yet (need about ${3 * minN}).`); process.exit(0); }

const fit = fitRasch(obs);
const scale = levelScale(fit, levels, minN);
console.log(`Player bands (boards solved before) → ability: ${[...fit.bands].sort((a, b) => a[1] - b[1]).map(([b, a]) => `${b}: ${a.toFixed(2)}`).join(' · ')}`);
if (!scale) console.log('Not enough puzzles with ≥ ' + minN + ' attempts to map onto the level scale yet.');
console.log(`\n${'puzzle'.padEnd(32)}  tries  fixed  shown  fitted     note`);
const list = [...fit.puzzles].filter(([, f]) => f.n >= minN).sort((a, b) => a[1].difficulty - b[1].difficulty);
for (const [pz, f] of list) {
  const shown = levels.get(pz) ?? NaN;
  let fitted = '', note = '';
  if (scale) {
    const lv = scale.a + scale.b * f.difficulty, pm = 1.96 * f.se * scale.b;
    fitted = `${Math.max(0, Math.min(10, lv)).toFixed(1)} ±${pm.toFixed(1)}`;
    if (Math.abs(lv - shown) > Math.max(0.5, pm)) note = lv > shown ? 'harder than shown' : 'easier than shown';
  }
  console.log(`${pz.slice(0, 32).padEnd(32)}  ${String(f.n).padStart(5)}  ${`${Math.round((100 * f.fixed) / f.n)}%`.padStart(5)}  ${shown.toFixed(1).padStart(5)}  ${fitted.padEnd(9)}  ${note}`);
}
const hidden = [...fit.puzzles].filter(([, f]) => f.n < minN).length;
if (hidden) console.log(`(${hidden} puzzle${hidden === 1 ? '' : 's'} with fewer than ${minN} engaged attempts not shown)`);
const cv = crossValidate(obs, levels);
const gain = cv.level - cv.fitted;
console.log(`\nPrediction on held-out attempts (5-fold, log loss, lower is better): shown levels ${cv.level.toFixed(3)} · fitted ${cv.fitted.toFixed(3)} (${cv.n} attempts)`);
console.log(gain > 0.01 ? '→ The fitted difficulties predict better: move the flagged levels.' : gain < -0.01 ? '→ The shown levels predict better (the fit needs more data).' : '→ About the same: the shown levels are fine for now.');
