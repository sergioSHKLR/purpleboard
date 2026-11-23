/**
 * The daily repair: one generated puzzle per UTC day, the same for every player, with no server.
 * The date picks a board from a small pool (hand-made challenge boards: they generate in well under
 * a second, also on old phones) and seeds the generator (src/scenarios/generate.ts), which is
 * deterministic for a seed as long as its time budget is never reached. So the daily always runs
 * the Fast DC solver (not the player's setting) with a budget no pool board comes near.
 *
 * Same everywhere, with one known limit: the fault checks are floating-point solves, so a check
 * that sits exactly on a pass/fail edge could in theory flip between JavaScript engines.
 */
import type { Board, Scenario } from '../types';
import { seedOf } from '../faults';
import { generateProblem, type Generated } from './generate';
import { shownLevel } from './catalog';

/** Hand-made challenge boards, in a fixed order (append only: reordering changes past dailies). */
export const DAILY_POOL: readonly string[] = [
  'builtin-bridge-troll',
  'builtin-backwards-day',
  'builtin-smoke-test',
  'builtin-ghost-short',
  'builtin-sagging-rail',
];

export interface DailyPlan {
  /** UTC date, YYYY-MM-DD. */
  key: string;
  boardId: string;
  /** Faults asked for (1–2); the generator may place fewer if fewer show on the bench. */
  faults: number;
  seed: number;
  /** Id of the generated scenario (the generator derives it from board and seed; the flag lock depends on it). */
  id: string;
}

/** Today's date in UTC, YYYY-MM-DD. */
export function dailyKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Milliseconds until the next daily (UTC midnight). */
export function msToNextDaily(now = new Date()): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime();
}

export function dailyPlan(key: string): DailyPlan {
  const day = Math.floor(Date.parse(`${key}T00:00:00Z`) / 86_400_000);
  // stepping by 2 through a pool of 5 visits every board once in 5 days, never the same one twice in a row
  const boardId = DAILY_POOL[(((day * 2) % DAILY_POOL.length) + DAILY_POOL.length) % DAILY_POOL.length];
  const seed = seedOf(`deadboard-daily:${key}`) >>> 0;
  const faults = 1 + (seed % 2);
  return { key, boardId, faults, seed, id: `gen-${boardId}-${seed.toString(36)}` };
}

/** Level estimate of a daily: its board's level, plus a little for a second fault. */
export function dailyLevel(plan: Pick<DailyPlan, 'boardId' | 'faults'>): number {
  return shownLevel({ id: '', meta: { par: plan.faults } as Scenario['meta'], generated: { from: plan.boardId, title: '' } });
}

/** Builds the day's puzzle on the pool board's known-good reference. Null if nothing could be placed. */
export async function makeDaily(plan: DailyPlan, parent: Scenario, good: Board, title: string, yieldFn?: () => Promise<void>): Promise<Generated | null> {
  const res = await generateProblem(parent, good, { solver: 'fast', faults: plan.faults, seed: plan.seed, budgetMs: 120_000, yieldFn });
  if (!res) return null;
  if (res.scenario.id !== plan.id) throw new Error(`daily id ${res.scenario.id}, expected ${plan.id}`);
  res.scenario.meta.title = title;
  return res;
}
