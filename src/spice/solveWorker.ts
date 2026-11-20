// Off-main-thread board solve (power-up transitions on large boards take ~0.5 s each).
// Connectivity is rebuilt from the posted board; buildConnectivity is deterministic, so net
// numbers match the main thread's. Only the plain result travels back.
import { buildConnectivity } from '../connectivity';
import { runSolver, type Solver } from '../verify';
import type { Board } from '../types';
import { setDeviceOverlay, type DeviceDef } from './devicelib';
import { setActiveDmm, type DmmProfile } from './dmm';

/** `devices`: the main thread's device overlay (mods), so both threads solve with the same models. */
export interface SolveRequest { id: number; board: Board; solver: Solver; opts: Parameters<typeof runSolver>[3]; devices?: DeviceDef[]; dmm?: DmmProfile }

const ctx = self as unknown as { onmessage: ((e: MessageEvent<SolveRequest>) => void) | null; postMessage(m: unknown): void };

ctx.onmessage = (e) => {
  const { id, board, solver, opts, devices, dmm } = e.data;
  try {
    setDeviceOverlay(devices ?? null);
    setActiveDmm(dmm ?? null);
    const conn = buildConnectivity(board);
    const s = runSolver(solver, board, conn, opts) as ReturnType<typeof runSolver> & { injected?: unknown };
    ctx.postMessage({ id, sim: { nodeOfNet: s.nodeOfNet, V: s.V, ground: s.ground, comps: s.comps, source: s.source, ccLimited: s.ccLimited, injected: s.injected } });
  } catch (err) {
    ctx.postMessage({ id, error: String(err) });
  }
};
