// Rail load estimate. Netlists (and boardviews in particular) say nothing about how much
// current the chips on a rail draw, yet boot current is mostly load current. Designers place
// decoupling roughly in proportion to a rail's current, so the number of capacitors on a rail
// is a board-agnostic proxy for its load. The constants are ORDER-OF-MAGNITUDE ESTIMATES
// (a laptop board idling at ~5–10 W in S0) — calibrate them with real measurements.
import type { Board } from '../types';
import type { Conn } from '../connectivity';
import type { PowerStateName } from './sequencer';
import { railVoltage, type PowerTree } from './powertree';

/** Estimated active power per decoupling capacitor on a rail (W). Estimate, not a measurement. */
export const LOAD_W_PER_CAP = 0.02;
/** Fraction of a rail's active load drawn in each machine state (S0 = fully active). Estimates. */
export const STATE_ACTIVITY: Record<PowerStateName, number> = { G3H: 0.05, S5: 0.1, S4: 0.1, S3: 0.25, S0: 1, S0SW: 1 };

export interface RailLoad { rail: string; v: number; caps: number; watts: number }

/** One load per rail that has a known voltage and is produced by a converter in the tree. */
export function estimateRailLoads(board: Board, conn: Conn, tree: PowerTree): RailLoad[] {
  const produced = new Set(tree.sources.filter((s) => ['buck', 'boost', 'ldo', 'load-switch'].includes(s.kind)).map((s) => s.output));
  const caps = new Map<number, number>();
  for (const c of board.components) {
    if (c.kind !== 'capacitor' || !c.state.populated) continue;
    const idx = conn.padItem.get(c);
    if (!idx) continue;
    const nets = new Set(idx.map((i) => conn.net[i]).filter((n) => n >= 0));
    for (const n of nets) caps.set(n, (caps.get(n) ?? 0) + 1);
  }
  const out: RailLoad[] = [];
  const seen = new Set<string>();
  conn.netNames.forEach((name, net) => {
    if (seen.has(name) || !produced.has(name)) return;
    const v = tree.rails.get(name)?.v ?? railVoltage(name);
    const n = caps.get(net) ?? 0;
    if (!v || n === 0) return;
    seen.add(name);
    out.push({ rail: name, v, caps: n, watts: n * LOAD_W_PER_CAP });
  });
  return out;
}

/** Load power of a rail in a machine state (a rail that is not up draws nothing anyway). */
export function loadWatts(l: RailLoad, state: PowerStateName): number {
  return l.watts * STATE_ACTIVITY[state];
}
