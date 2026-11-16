// Liquid-damage residue: the crust a technician sees under the microscope (white salts,
// green-blue copper corrosion) and, for ionic residue between pins, the leakage path it forms.
// Scrubbing with isopropyl alcohol dissolves it: each pass removes about half, the leakage
// resistance rises as the film thins, and once it is gone the leak is gone. Corroded copper
// (a broken trace) is not repaired by cleaning — the metal is already eaten away.
import type { Board, Component } from './types';

/** Fraction of residue left after one IPA scrub (estimate). */
export const IPA_PASS_REMAINING = 0.5;
/** Below this the board reads clean. */
export const RESIDUE_GONE = 0.1;

export function addResidue(c: Component, amount: number, leaky: boolean, pads?: number[]) {
  const prev = c.state.residue;
  c.state.residue = {
    amount: Math.min(1, Math.max(amount, prev?.amount ?? 0)),
    ...(leaky || prev?.leaky ? { leaky: true } : {}),
    ...(pads ? { pads: [...new Set([...(prev?.pads ?? []), ...pads])].sort((a, b) => a - b) } : prev?.pads ? { pads: prev.pads } : {}),
  };
}

const inReach = (c: Component, xmm: number, ymm: number, rmm: number) =>
  Math.hypot(c.at[0] - xmm, c.at[1] - ymm) <= rmm + Math.max(c.body.w, c.body.h) / 2;

/** Whether a scrub at this spot would touch any residue. */
export function residueNear(board: Board, xmm: number, ymm: number, rmm: number): boolean {
  return board.components.some((c) => c.state.residue && inReach(c, xmm, ymm, rmm));
}

/**
 * One IPA scrub over a disc (mm). Returns the refs whose residue was cleaned and those whose
 * residue (and its leak) is now gone — the caller re-solves when `cleared` is not empty or a
 * leak changed.
 */
export function cleanWithIpa(board: Board, xmm: number, ymm: number, rmm: number): { cleaned: string[]; cleared: string[] } {
  const cleaned: string[] = [], cleared: string[] = [];
  for (const c of board.components) {
    const res = c.state.residue;
    if (!res || !inReach(c, xmm, ymm, rmm)) continue;
    const left = res.amount * IPA_PASS_REMAINING;
    cleaned.push(c.ref);
    if (left < RESIDUE_GONE) {
      if (res.leaky) c.state.leak = undefined;
      c.state.residue = undefined;
      cleared.push(c.ref);
    } else {
      // a thinner ionic film conducts less
      if (res.leaky && c.state.leak) c.state.leak = { ...c.state.leak, ohms: +(c.state.leak.ohms * (res.amount / left)).toPrecision(3) };
      c.state.residue = { ...res, amount: left };
    }
  }
  return { cleaned, cleared };
}
