// The hidden difficulty system (handoff: learning journey, workstream D). Like a game's hidden
// difficulty: the player never sees a rating, never gets "you levelled up" messages and never takes
// a placement test. The bench keeps one private estimate of the player's level on this device,
// updates it from their own repairs, and the Today picks aim at puzzles they solve about 70 % of
// the time. Nothing here leaves the device.
//
// Model: the player's level r and its uncertainty u, on the same 0–10 scale as the puzzles. The
// chance to fix a puzzle of level d is sigmoid(SLOPE · (r − d)). After an attempt the estimate
// moves toward what happened (an Elo / Glicko-style step): far while uncertain (a strong first
// solve jumps), less once many attempts are in. A fix with notes counts less than a clean fix, a
// fix after the solution video less again, and all of these more than giving up: asking for help
// must never cost more than failing.
//
// Puzzle levels: the fitted "real" level from the public stats when there is one
// (public/fitted-levels.json, refreshed by the site build), else the level the puzzle shows.

export interface Skill {
  /** Estimated player level, 0–10. */
  r: number;
  /** Uncertainty of r, in levels (shrinks with every counted attempt). */
  u: number;
  /** Attempts counted. */
  n: number;
}

export const NEW_PLAYER: Readonly<Skill> = { r: 1, u: 2, n: 0 };
/** Logits per level: one level above the player ≈ 3.3× worse odds. */
export const SLOPE = 1.2;
/** The success rate the picks aim at. */
export const TARGET = 0.7;
const MIN_U = 0.4;
const STORE_KEY = 'pcbfix_skill';

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Chance this player fixes a puzzle of level `d`. */
export function expected(s: Skill, d: number): number {
  return sigmoid(SLOPE * (s.r - d));
}

/** The puzzle level the picks aim at (success ≈ TARGET). */
export function targetLevel(s: Skill): number {
  return s.r - Math.log(TARGET / (1 - TARGET)) / SLOPE;
}

export interface AttemptEnd {
  fixed: boolean;
  /** Notes revealed during the attempt. */
  notes: number;
  /** The solution video was played. */
  solution: boolean;
  /** Tried for real (tests run, or minutes of work): a glance and move on counts for nothing. */
  engaged: boolean;
}

/** What an attempt says, 0–1, or null when it says nothing. Help costs less than failing. */
export function attemptScore(a: AttemptEnd): number | null {
  if (a.fixed) return a.solution ? 0.4 : a.notes > 0 ? Math.max(0.6, 0.85 - 0.1 * (a.notes - 1)) : 1;
  return a.engaged ? 0 : null;
}

/** The estimate after one attempt at a puzzle of level `d`. `weight` < 1 for guided lessons. */
export function update(s: Skill, d: number, score: number, weight = 1): Skill {
  const p = expected(s, d);
  // step size in levels: large while uncertain, never below a floor so the estimate can still move
  const k = (0.5 + 0.9 * s.u) * weight;
  const r = clamp(s.r + k * (score - p), 0, 10);
  const u = Math.max(MIN_U, s.u * (1 - 0.12 * weight));
  return { r: Math.round(r * 1000) / 1000, u: Math.round(u * 1000) / 1000, n: s.n + 1 };
}

export function loadSkill(store: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): Skill {
  try {
    const v = JSON.parse(store?.getItem(STORE_KEY) ?? 'null') as Skill | null;
    if (v && [v.r, v.u, v.n].every((x) => typeof x === 'number' && Number.isFinite(x))) return { r: clamp(v.r, 0, 10), u: clamp(v.u, MIN_U, 3), n: Math.max(0, Math.floor(v.n)) };
  } catch { /* storage unavailable or damaged: start over */ }
  return { ...NEW_PLAYER };
}

export function saveSkill(s: Skill, store: Pick<Storage, 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): void {
  try { store?.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* private mode */ }
}

// ---- fitted puzzle levels (from the public stats, shipped with the site build)

let fitted = new Map<string, number>();

/** Fitted levels by puzzle id ({ levels: { id: level } }, see scripts/fetch-levels.ts). Bad data is ignored. */
export function setFittedLevels(data: unknown): void {
  const levels = (data as { levels?: Record<string, unknown> } | null)?.levels;
  const next = new Map<string, number>();
  if (levels && typeof levels === 'object') {
    for (const [id, v] of Object.entries(levels)) if (/^(builtin|demo)-[a-z0-9-]+$/.test(id) && typeof v === 'number' && v >= 0 && v <= 10) next.set(id, v);
  }
  fitted = next;
}

/** A fitted level is known for this puzzle. */
export function hasFittedLevel(id: string): boolean {
  return fitted.has(id);
}

/** The level the hidden system uses for a puzzle: fitted when known, else the shown level. */
export function puzzleLevel(id: string, shown: number): number {
  return fitted.get(id) ?? shown;
}
