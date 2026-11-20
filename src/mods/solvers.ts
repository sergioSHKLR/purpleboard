// The circuit solvers as items of the official-solvers mod. A board names its solver by address
// ("official-solvers/solvers/spice-power") or by the short names boards have always used
// ("fast", "spice", "spice-power"). Running one stays in src/verify.ts (runSolver).
// Community solvers are code, so they arrive with code mods (docs/MOD_PLATFORM.md, phase 4).
import { tk } from '../i18n';
import type { Solver } from '../verify';

export const OFFICIAL_SOLVERS_MOD = 'official-solvers';

export interface SolverInfo { id: Solver; address: string; name: string; description: string }

export const SOLVERS: readonly SolverInfo[] = [
  { id: 'fast', address: `${OFFICIAL_SOLVERS_MOD}/solvers/fast`, name: tk('Fast DC'), description: tk('Piecewise-linear DC solver: instant, parts are open or closed.') },
  { id: 'spice', address: `${OFFICIAL_SOLVERS_MOD}/solvers/spice`, name: tk('SPICE'), description: tk('Device physics and a realistic meter; uses the device library.') },
  { id: 'spice-power', address: `${OFFICIAL_SOLVERS_MOD}/solvers/spice-power`, name: tk('SPICE + PWR'), description: tk("SPICE plus the board's regulators and power sequencing from its power tree.") },
];

/** A solver name or address → the solver, or null when there is no such solver. */
export function solverOf(x: unknown): Solver | null {
  if (typeof x !== 'string') return null;
  const s = SOLVERS.find((v) => v.id === x || v.address === x);
  return s ? s.id : null;
}
