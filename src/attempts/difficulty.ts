// Fitted puzzle difficulty from attempt records (checkpoint 2 of the analytics plan: does what
// players actually do predict a puzzle's solve rate better than the hand-set level?).
//
// Model (a Rasch / one-parameter logistic model, the standard first step of item response theory):
//   logit P(fixed) = ability[band] − difficulty[puzzle]
// There is no player id, so "ability" belongs to a band of players: how many boards they had solved
// before the attempt (the record's `solved` range). Band "0" is the anchor (ability 0). A small L2
// prior keeps puzzles with few attempts near the middle instead of at ±infinity (a puzzle nobody
// fixed is "hard", not "infinitely hard"). Fitted by Newton steps, one parameter at a time.
//
// Only engaged attempts count (see `engaged`): someone who opened a board in the picker and moved
// on after a few seconds did not fail it.

export interface Obs { puzzle: string; band: string; fixed: boolean }
export interface PuzzleFit { difficulty: number; se: number; n: number; fixed: number }
export interface Fit { puzzles: Map<string, PuzzleFit>; bands: Map<string, number>; iterations: number }

/** An attempt that really tried: ran the tests at least once, or played a minute or more. */
export function engaged(r: { tests: string; active: string }): boolean {
  return r.tests !== '0' || r.active !== '<1m';
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export function fitRasch(obs: readonly Obs[], opts: { l2?: number; maxIter?: number; anchor?: string } = {}): Fit {
  const cells = new Map<string, Cell>();
  for (const o of obs) {
    const k = `${o.puzzle}\u0000${o.band}`;
    const c = cells.get(k) ?? cells.set(k, { puzzle: o.puzzle, band: o.band, n: 0, fixed: 0 }).get(k)!;
    c.n++; if (o.fixed) c.fixed++;
  }
  return fitRaschCells([...cells.values()], opts);
}

/** Attempts of one puzzle by one player band: how many, and how many were fixed. */
export interface Cell { puzzle: string; band: string; n: number; fixed: number }

/**
 * The same fit from totals per puzzle × band (what the collector's nightly job has: a few dozen
 * cells instead of thousands of rows, well inside a Worker's CPU limit).
 */
export function fitRaschCells(cells: readonly Cell[], opts: { l2?: number; maxIter?: number; anchor?: string } = {}): Fit {
  const l2 = opts.l2 ?? 0.2, maxIter = opts.maxIter ?? 200, anchor = opts.anchor ?? '0';
  const use = cells.filter((c) => c.n > 0);
  const diff = new Map<string, number>(), ability = new Map<string, number>();
  const byPuzzle = new Map<string, Cell[]>(), byBand = new Map<string, Cell[]>();
  for (const c of use) {
    diff.set(c.puzzle, 0); ability.set(c.band, 0);
    (byPuzzle.get(c.puzzle) ?? byPuzzle.set(c.puzzle, []).get(c.puzzle)!).push(c);
    (byBand.get(c.band) ?? byBand.set(c.band, []).get(c.band)!).push(c);
  }
  // one Newton step on a parameter: gradient / curvature of the penalised log-likelihood
  const step = (list: Cell[], current: number, sign: 1 | -1, eta: (c: Cell) => number) => {
    let g = -l2 * current, h = l2;
    for (const c of list) {
      const p = sigmoid(eta(c));
      g += sign * (c.fixed - c.n * p);
      h += c.n * p * (1 - p);
    }
    return current + g / h;
  };
  let it = 0;
  for (; it < maxIter; it++) {
    let moved = 0;
    for (const [pz, list] of byPuzzle) {
      const old = diff.get(pz)!;
      const nu = step(list, old, -1, (c) => ability.get(c.band)! - old);
      diff.set(pz, nu); moved = Math.max(moved, Math.abs(nu - old));
    }
    for (const [band, list] of byBand) {
      if (band === anchor && byBand.size > 1) continue; // the anchor stays 0
      const old = ability.get(band)!;
      const nu = step(list, old, 1, (c) => old - diff.get(c.puzzle)!);
      ability.set(band, nu); moved = Math.max(moved, Math.abs(nu - old));
    }
    if (moved < 1e-6) break;
  }
  const puzzles = new Map<string, PuzzleFit>();
  for (const [pz, list] of byPuzzle) {
    const d = diff.get(pz)!;
    let info = l2, n = 0, fixed = 0;
    for (const c of list) { const p = sigmoid(ability.get(c.band)! - d); info += c.n * p * (1 - p); n += c.n; fixed += c.fixed; }
    puzzles.set(pz, { difficulty: d, se: 1 / Math.sqrt(info), n, fixed });
  }
  return { puzzles, bands: ability, iterations: it + 1 };
}

/**
 * The fitted difficulties on the 0.0–10.0 level scale: a straight line (weighted least squares,
 * weight = attempts) through the puzzles that have a hand-set level and enough attempts. Returns
 * null when fewer than 3 such puzzles exist or the fit runs the wrong way (harder ≠ higher level).
 */
export function levelScale(fit: Fit, levels: ReadonlyMap<string, number>, minN = 20): { a: number; b: number; used: number } | null {
  const pts = [...fit.puzzles].filter(([pz, f]) => levels.has(pz) && f.n >= minN).map(([pz, f]) => ({ x: f.difficulty, y: levels.get(pz)!, w: f.n }));
  if (pts.length < 3) return null;
  const W = pts.reduce((s, p) => s + p.w, 0);
  const mx = pts.reduce((s, p) => s + p.w * p.x, 0) / W, my = pts.reduce((s, p) => s + p.w * p.y, 0) / W;
  const sxx = pts.reduce((s, p) => s + p.w * (p.x - mx) ** 2, 0), sxy = pts.reduce((s, p) => s + p.w * (p.x - mx) * (p.y - my), 0);
  if (sxx <= 0 || sxy <= 0) return null;
  const b = sxy / sxx;
  return { a: my - b * mx, b, used: pts.length };
}

/**
 * How well a set of predicted solve probabilities matches what happened: mean log loss (lower is
 * better). Used to compare "the hand-set level predicts the solve rate" with the fitted model.
 */
export function logLoss(pairs: readonly { p: number; fixed: boolean }[]): number {
  if (!pairs.length) return NaN;
  const eps = 1e-6;
  return pairs.reduce((s, { p, fixed }) => s - Math.log(Math.min(1 - eps, Math.max(eps, fixed ? p : 1 - p))), 0) / pairs.length;
}

/**
 * The hand-set levels as a model, for comparison: logit P(fixed) = ability[band] − (a + b·level),
 * with only a, b and the band abilities fitted. If this predicts as well as `fitRasch`, the levels
 * are already right; if the fitted model predicts better on attempts it has not seen, the
 * difference per puzzle says which levels to move.
 */
export function fitLevelModel(obs: readonly Obs[], levels: ReadonlyMap<string, number>, maxIter = 300): { a: number; b: number; bands: Map<string, number> } {
  const use = obs.filter((o) => levels.has(o.puzzle));
  const bands = new Map<string, number>();
  for (const o of use) bands.set(o.band, 0);
  let a = 0, b = 0;
  for (let it = 0; it < maxIter; it++) {
    // Newton step on (a, b) together (2x2), then on each band ability
    let ga = 0, gb = 0, haa = 1e-6, hab = 0, hbb = 1e-6;
    for (const o of use) {
      const x = levels.get(o.puzzle)!, p = sigmoid(bands.get(o.band)! - (a + b * x)), r = (o.fixed ? 1 : 0) - p, w = p * (1 - p);
      ga -= r; gb -= r * x; haa += w; hab += w * x; hbb += w * x * x;
    }
    const det = haa * hbb - hab * hab;
    if (det <= 0) break;
    const da = (hbb * ga - hab * gb) / det, db = (haa * gb - hab * ga) / det;
    a -= da; b -= db;
    let moved = Math.max(Math.abs(da), Math.abs(db));
    for (const band of bands.keys()) {
      if (band === '0' && bands.size > 1) continue;
      let g = -0.2 * bands.get(band)!, h = 0.2;
      for (const o of use) if (o.band === band) { const p = sigmoid(bands.get(band)! - (a + b * levels.get(o.puzzle)!)); g += (o.fixed ? 1 : 0) - p; h += p * (1 - p); }
      bands.set(band, bands.get(band)! + g / h); moved = Math.max(moved, Math.abs(g / h));
    }
    if (moved < 1e-7) break;
  }
  return { a, b, bands };
}

/**
 * k-fold cross-validation: mean log loss on held-out attempts of the hand-set-level model and of
 * the fitted model (lower is better). Attempts are split by their position (pass them shuffled).
 */
export function crossValidate(obs: readonly Obs[], levels: ReadonlyMap<string, number>, k = 5): { level: number; fitted: number; n: number } {
  const use = obs.filter((o) => levels.has(o.puzzle));
  const lvl: { p: number; fixed: boolean }[] = [], fit: { p: number; fixed: boolean }[] = [];
  for (let f = 0; f < k; f++) {
    const train = use.filter((_, i) => i % k !== f), test = use.filter((_, i) => i % k === f);
    if (!train.length || !test.length) continue;
    const m = fitLevelModel(train, levels), r = fitRasch(train);
    for (const o of test) {
      lvl.push({ p: sigmoid((m.bands.get(o.band) ?? 0) - (m.a + m.b * levels.get(o.puzzle)!)), fixed: o.fixed });
      fit.push({ p: sigmoid((r.bands.get(o.band) ?? 0) - (r.puzzles.get(o.puzzle)?.difficulty ?? 0)), fixed: o.fixed });
    }
  }
  return { level: logLoss(lvl), fitted: logLoss(fit), n: lvl.length };
}
