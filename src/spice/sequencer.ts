// Power-state sequencing from design intent (ACPI-style state names in rail names).
// For each state the embedded controller's job is emulated generically: assert the enables
// of converters whose output belongs to that state (or an earlier one). Enables fed by an
// upstream PGOOD are left to the circuit, so PG→EN chains sequence by physics.
import { powerStateRank, type PowerTree } from './powertree';

export const POWER_STATES = [
  { name: 'G3H', rank: 0 }, { name: 'S5', rank: 1 }, { name: 'S4', rank: 2 },
  { name: 'S3', rank: 3 }, { name: 'S0', rank: 4 }, { name: 'S0SW', rank: 4.5 },
] as const;
export type PowerStateName = (typeof POWER_STATES)[number]['name'];

export interface EnableDrive { net: string; level: 'high' | 'low'; by: string[] }

const activeLow = (n: string) => /_L$|_N$/i.test(n);

/** Enables the controller would assert in `state`. Unranked converters count as S0 loads. */
export function enablesForState(tree: PowerTree, state: PowerStateName): EnableDrive[] {
  const rank = POWER_STATES.find((s) => s.name === state)!.rank;
  const pgNets = new Set(tree.sources.map((s) => s.pgood).filter((n): n is string => !!n));
  const out = new Map<string, EnableDrive>();
  for (const s of tree.sources) {
    if (!s.enable || pgNets.has(s.enable)) continue;
    if (!['buck', 'boost', 'ldo', 'load-switch'].includes(s.kind)) continue;
    const r = powerStateRank(s.output) ?? 4;
    if (r > rank) continue;
    const d = out.get(s.enable) ?? { net: s.enable, level: activeLow(s.enable) ? 'low' : 'high', by: [] };
    d.by.push(s.ref);
    out.set(s.enable, d);
  }
  return [...out.values()];
}

/** Whether a rail is expected up in `state` from its name (undefined: name carries no state). */
export function expectedUp(rail: string, state: PowerStateName): boolean | undefined {
  const r = powerStateRank(rail);
  if (r === undefined) return undefined;
  return r <= POWER_STATES.find((s) => s.name === state)!.rank;
}
