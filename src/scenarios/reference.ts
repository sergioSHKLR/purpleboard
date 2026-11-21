// Known-good boards of shipped challenges: the board as designed, before the sabotage that makes
// it a challenge. Puzzles (src/mods/puzzles.ts) plant their faults on these. Kept beside the
// scenario (not in it), so saving or exporting a scenario never includes the answer.
import type { Board, Scenario } from '../types';
import { repairedDemo } from './demoRepairs';

const refs = new WeakMap<Scenario, Board>();

export function setReference(sc: Scenario, good: Board) { refs.set(sc, good); }

/**
 * The working board behind a scenario: a shipped challenge's pre-sabotage board, a shipped demo's
 * repaired board, or the board itself when it has no flag (a sandbox or imported design).
 * Null for a challenge whose repair isn't known (e.g. a community .pcbfix.json).
 */
export function referenceBoard(sc: Scenario): Board | null {
  const r = refs.get(sc);
  if (r) return r;
  const demo = repairedDemo(sc); // a clone of the whole demo: kept, the panel asks on every render
  if (demo) { refs.set(sc, demo.board); return demo.board; }
  return sc.lock ? null : sc.board;
}
