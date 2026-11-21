// Off-main-thread «Where to look?» (rules-engine.ts): on a 500-part board, comparing with the
// working board takes seconds (a solve per switch setting, an ohms reading per powered net).
// Only plain data travels: the boards, the tests, the rules; the ranked parts come back.
import { observe, rankCandidates } from './rules-engine';
import type { RuleDef } from './rules';
import type { Solver } from '../verify';
import type { Board, Objective } from '../types';
import { setDeviceOverlay, type DeviceDef } from '../spice/devicelib';
import { setActiveDmm, type DmmProfile } from '../spice/dmm';

/** `devices` / `dmm`: the main thread's mod device models and meter, so both threads read alike. */
export interface LookRequest { id: number; board: Board; reference: Board; objectives: Objective[]; solver: Solver; rules: RuleDef[]; devices?: DeviceDef[]; dmm?: DmmProfile }

const ctx = self as unknown as { onmessage: ((e: MessageEvent<LookRequest>) => void) | null; postMessage(m: unknown): void };

ctx.onmessage = (e) => {
  const { id, board, reference, objectives, solver, rules, devices, dmm } = e.data;
  try {
    setDeviceOverlay(devices ?? null);
    setActiveDmm(dmm ?? null);
    ctx.postMessage({ id, candidates: rankCandidates(observe(board, reference, objectives, solver), board, rules) });
  } catch (err) {
    ctx.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
