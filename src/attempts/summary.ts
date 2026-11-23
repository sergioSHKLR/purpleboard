// The public puzzle-statistics summary (deadboard.org/stats.html): built by the collector every
// few hours from the last 30 days of attempt records (collector/core.ts), read by the page
// (src/home/stats.ts). Only totals; every count of a group smaller than MIN_PUBLIC is left out
// (null), so no number on the page can point at one player.

import { ACTIVE_RANGES } from './record';
import { fitRaschCells, levelScale, type Cell } from './difficulty';

export const MIN_PUBLIC = 10;
export const SUMMARY_DAYS = 30;

/** Rows the collector's SQL returns (collector/core.ts `SUMMARY_SQL`). */
export interface PuzzleRow { puzzle: string; src: string; kind: string; level: number; n: number; fixed: number; phone: number; phone_fixed: number; noted: number; looked: number; no_tests: number; engaged: number }
export interface ActiveRow { puzzle: string; src: string; active: string; n: number }
export interface CellRow { puzzle: string; src: string; solved: string; n: number; fixed: number }
export interface DayRow { day: string; n: number; fixed: number }
export interface FirstRow { layout: string; n: number; tool: number; tested: number; fixed: number }

export interface PublicPuzzle {
  puzzle: string;
  /** Daily / generated puzzles: the board they were made from. */
  from: string;
  kind: string;
  /** The level the puzzle shows. */
  level: number;
  /** Counts; null when the group is under MIN_PUBLIC. */
  attempts: number | null;
  fixed: number | null;
  phoneAttempts: number | null;
  phoneFixed: number | null;
  /** Attempts that revealed a note / asked «Where to look?» / left before any test run. */
  notes: number | null;
  look: number | null;
  noTests: number | null;
  /** The middle active-time range of the attempts (e.g. "2-5m"). */
  typicalTime: string | null;
  /** Fitted level on the 0–10 scale (needs ≥ 20 engaged attempts and enough puzzles), ± its 95 % range. */
  fitted: number | null;
  fittedPm: number | null;
}

export interface PublicSummary {
  v: 1;
  made: string;
  since: string;
  days: number;
  minGroup: number;
  attempts: number;
  fixed: number;
  perDay: { day: string; attempts: number | null; fixed: number | null }[];
  puzzles: PublicPuzzle[];
  firstVisit: { layout: string; attempts: number; tool: number | null; tested: number | null; fixed: number | null }[];
  /** Player bands (boards solved before) → fitted ability; empty until there is enough data. */
  bands: { band: string; ability: number }[];
}

const keep = (n: number) => (n >= MIN_PUBLIC ? n : null);
/** A part of a group: shown only when the group and the part's complement are both large enough to hide a person. */
const part = (k: number, of: number) => (of >= MIN_PUBLIC ? k : null);
const key = (puzzle: string, src: string) => `${puzzle}|${src}`;

export function buildSummary(rows: { puzzles: PuzzleRow[]; active: ActiveRow[]; cells: CellRow[]; days: DayRow[]; first: FirstRow[] }, made: Date, since: string): PublicSummary {
  // typical time: the range holding the middle attempt
  const order = ACTIVE_RANGES.map(([l]) => l as string);
  const times = new Map<string, ActiveRow[]>();
  for (const a of rows.active) (times.get(key(a.puzzle, a.src)) ?? times.set(key(a.puzzle, a.src), []).get(key(a.puzzle, a.src))!).push(a);
  const typical = (k: string): string | null => {
    const list = (times.get(k) ?? []).sort((x, y) => order.indexOf(x.active) - order.indexOf(y.active));
    const total = list.reduce((s, a) => s + a.n, 0);
    let seen = 0;
    for (const a of list) { seen += a.n; if (seen * 2 >= total) return a.active; }
    return null;
  };
  // fitted difficulty from engaged attempts per puzzle × band
  const cells: Cell[] = rows.cells.map((c) => ({ puzzle: key(c.puzzle, c.src), band: c.solved, n: c.n, fixed: c.fixed }));
  const fit = fitRaschCells(cells);
  const levels = new Map(rows.puzzles.map((p) => [key(p.puzzle, p.src), p.level]));
  const scale = levelScale(fit, levels, 20);

  const puzzles: PublicPuzzle[] = rows.puzzles.map((p) => {
    const k = key(p.puzzle, p.src), f = fit.puzzles.get(k), big = p.n >= MIN_PUBLIC;
    const fitted = scale && f && f.n >= 20 ? Math.round(Math.max(0, Math.min(10, scale.a + scale.b * f.difficulty)) * 10) / 10 : null;
    return {
      puzzle: p.puzzle, from: p.src, kind: p.kind, level: p.level,
      attempts: keep(p.n),
      fixed: big ? part(p.fixed, p.n) : null,
      phoneAttempts: big ? keep(p.phone) : null,
      phoneFixed: big ? part(p.phone_fixed, p.phone) : null,
      notes: big ? p.noted : null,
      look: big ? p.looked : null,
      noTests: big ? p.no_tests : null,
      typicalTime: big ? typical(k) : null,
      fitted,
      fittedPm: fitted !== null && scale && f ? Math.round(1.96 * f.se * scale.b * 10) / 10 : null,
    };
  }).sort((a, b) => a.level - b.level || a.puzzle.localeCompare(b.puzzle));

  return {
    v: 1,
    made: made.toISOString(),
    since,
    days: SUMMARY_DAYS,
    minGroup: MIN_PUBLIC,
    attempts: rows.days.reduce((s, d) => s + d.n, 0),
    fixed: rows.days.reduce((s, d) => s + d.fixed, 0),
    perDay: rows.days.map((d) => ({ day: d.day, attempts: keep(d.n), fixed: d.n >= MIN_PUBLIC ? d.fixed : null })).sort((a, b) => a.day.localeCompare(b.day)),
    puzzles,
    firstVisit: rows.first.filter((f) => f.n >= MIN_PUBLIC).map((f) => ({ layout: f.layout, attempts: f.n, tool: f.tool, tested: f.tested, fixed: f.fixed })),
    bands: scale ? [...fit.bands].map(([band, ability]) => ({ band, ability: Math.round(ability * 100) / 100 })) : [],
  };
}
