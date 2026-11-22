// The fault-candidate engine (the coach RFC's piece 3): deterministic and offline. It compares the
// board on the bench with its known-good version (what the simulator measures, pin by pin), turns
// the differences into observations — a net reads dead / low / high, a rail is shorted to ground,
// a part runs hot, an LED stays dark — and ranks the parts that could cause them with **rules**,
// which are data (official-rules, and mods can add or reweight rules):
//
//   { "id": "short-cap", "when": "short", "suspect": { "where": "on-net", "kinds": ["capacitor"] },
//     "weight": 8, "confirm": "Power off: measure each capacitor on {net} to ground…" }
//
// Every candidate is a part of this board, with the rules and observations that point at it, and
// the measurement that would confirm it. "No candidate" is an answer too.
// The engine itself (observe, rank, recall test) is in rules-engine.ts, loaded only when used.
import type { ComponentKind } from '../types';
import { itemAddress } from './address';
import type { LoadedMod } from './mods';
import { applyPatches, type PatchEntry, type PatchResult } from './patches';

export type When = 'dead' | 'low' | 'high' | 'short' | 'hot' | 'dark' | 'tested';
export type Where = 'on-net' | 'series' | 'feeds-net' | 'the-part';
export interface RuleDef {
  id: string;
  when: When;
  suspect: { where: Where; kinds?: ComponentKind[] };
  /** 1–10, default 5. */
  weight?: number;
  /** What to measure to confirm; {net} and {ref} are filled in. */
  confirm: string;
  why?: string;
}

export const OFFICIAL_RULES_MOD = 'official-rules';
const WHENS: When[] = ['dead', 'low', 'high', 'short', 'hot', 'dark', 'tested'];
const WHERES: Where[] = ['on-net', 'series', 'feeds-net', 'the-part'];
const KINDS: ComponentKind[] = ['resistor', 'capacitor', 'led', 'diode', 'battery', 'switch', 'fuse', 'testpoint', 'ic', 'connector', 'generic'];
const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
type Raw = Record<string, unknown>;
const isObj = (x: unknown): x is Raw => !!x && typeof x === 'object' && !Array.isArray(x);

export function ruleProblems(r: Raw): string[] {
  const p: string[] = [];
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) p.push('"id" must be 2-64 lowercase letters, digits, ".", "-" or "_"');
  if (!WHENS.includes(r.when as When)) p.push(`"when" must be one of: ${WHENS.join(', ')}`);
  const s = r.suspect;
  if (!isObj(s) || !WHERES.includes(s.where as Where)) p.push(`"suspect.where" must be one of: ${WHERES.join(', ')}`);
  else if (s.kinds !== undefined && !(Array.isArray(s.kinds) && s.kinds.length && s.kinds.every((k) => KINDS.includes(k as ComponentKind)))) p.push(`"suspect.kinds" must list part kinds: ${KINDS.join(', ')}`);
  const partObs = r.when === 'hot' || r.when === 'dark' || r.when === 'tested';
  if (isObj(s) && s.where === 'the-part' && !partObs) p.push('"the-part" only goes with "hot", "dark" or "tested" (an observation about a part)');
  if (isObj(s) && s.where === 'feeds-net' && partObs) p.push('"feeds-net" only goes with a net observation (dead, low, high, short)');
  if (r.weight !== undefined && !(typeof r.weight === 'number' && r.weight >= 1 && r.weight <= 10)) p.push('"weight" must be 1–10');
  if (typeof r.confirm !== 'string' || !r.confirm.trim() || r.confirm.length > 400) p.push('"confirm" must say what to measure (up to 400 characters)');
  if (r.why !== undefined && (typeof r.why !== 'string' || r.why.length > 400)) p.push('"why" must be text');
  return p;
}

export function parseRule(raw: unknown, at: string, errs: string[], warnings: string[]): RuleDef | null {
  if (!isObj(raw)) { errs.push(`${at} must be an object`); return null; }
  for (const k of Object.keys(raw)) if (!['id', 'when', 'suspect', 'weight', 'confirm', 'why'].includes(k)) warnings.push(`${at}: unknown field "${k}" (ignored)`);
  const p = ruleProblems(raw);
  if (p.length) { errs.push(...p.map((x) => `${at}: ${x}`)); return null; }
  return structuredClone({ id: raw.id, when: raw.when, suspect: raw.suspect, confirm: raw.confirm, ...(raw.weight !== undefined && { weight: raw.weight }), ...(raw.why !== undefined && { why: raw.why }) }) as RuleDef;
}

/** The baseline rules (official-rules). Engineering heuristics from repair practice. */
export const OFFICIAL_RULES: readonly RuleDef[] = [
  { id: 'short-cap', when: 'short', suspect: { where: 'on-net', kinds: ['capacitor'] }, weight: 8, confirm: 'Power off: measure each capacitor on {net} to ground, or inject current into {net} and look for the part that warms up.', why: 'A failed capacitor is the most common short on a rail.' },
  { id: 'short-ic', when: 'short', suspect: { where: 'on-net', kinds: ['ic'] }, weight: 5, confirm: 'Inject current into {net} with the thermal camera on: a shorted chip gets warm.', why: 'A chip can fail short from its supply pin to ground.' },
  { id: 'short-any', when: 'short', suspect: { where: 'on-net', kinds: ['diode', 'led', 'resistor', 'generic', 'connector'] }, weight: 3, confirm: 'Lift one end of {ref} and measure {net} to ground again.', why: 'Leaks and residue between pins also pull a rail down.' },
  { id: 'dead-source', when: 'dead', suspect: { where: 'on-net', kinds: ['battery', 'connector'] }, weight: 8, confirm: 'Power on: measure the supply right at {ref}\'s pins, then at the board side of its joints.', why: 'When everything downstream is dead, check the supply and its connector first.' },
  { id: 'dead-series', when: 'dead', suspect: { where: 'feeds-net', kinds: ['resistor', 'fuse', 'switch', 'diode', 'led', 'generic', 'connector'] }, weight: 7, confirm: 'Power on: measure across {ref}. Supply voltage on one side and nothing on the other means it (or one of its joints) is open.', why: 'A dead net is usually cut off from its source by an open part or joint.' },
  { id: 'dead-any', when: 'dead', suspect: { where: 'on-net' }, weight: 2, confirm: 'Inspect the joints on {net} (flip the board) and reflow any that look dull.', why: 'A cold or cracked joint can disconnect a part from the net.' },
  { id: 'low-source', when: 'low', suspect: { where: 'on-net', kinds: ['battery', 'connector'] }, weight: 5, confirm: 'Power on: measure the supply at {ref}\'s pins, then on the copper next to each joint, + and −: a big difference is a bad joint or contact.', why: 'A weak supply or a resistive joint at the input pulls every rail down.' },
  { id: 'low-series', when: 'low', suspect: { where: 'feeds-net', kinds: ['resistor', 'fuse', 'diode', 'switch', 'led', 'generic'] }, weight: 6, confirm: 'Power off: measure {ref}. A value well above its marking, or a resistive joint, drops the voltage on {net}.', why: 'Too much resistance in series makes a net read low.' },
  { id: 'low-load', when: 'low', suspect: { where: 'on-net', kinds: ['capacitor', 'resistor', 'ic', 'led', 'diode', 'generic'] }, weight: 4, confirm: 'Power off: measure {ref} for a leak (a capacitor should read open; a resistor its marking).', why: 'A part leaking to ground loads the net down.' },
  { id: 'high-open', when: 'high', suspect: { where: 'on-net', kinds: ['resistor', 'capacitor', 'led', 'diode', 'ic', 'generic'] }, weight: 5, confirm: 'Check that {ref} is fitted and both joints conduct: a missing or open load lets {net} float up.', why: 'A net reads high when the part that should pull it down is open.' },
  { id: 'high-leak', when: 'high', suspect: { where: 'feeds-net', kinds: ['resistor', 'switch', 'capacitor', 'generic', 'ic'] }, weight: 5, confirm: 'Power off: measure {ref}. A resistor reading below its marking, or a part that should be open (a released switch, a capacitor) conducting, lets too much current into {net}. Clean around it with IPA if it looks wet or dirty.', why: 'A net reads high when the part between it and the supply passes more current than it should.' },
  { id: 'high-series', when: 'high', suspect: { where: 'series', kinds: ['resistor', 'diode', 'led'] }, weight: 3, confirm: 'Measure across {ref}: little or no drop means its path to the load is broken.', why: 'An open part downstream stops the current that would pull the net down.' },
  { id: 'hot-part', when: 'hot', suspect: { where: 'the-part' }, weight: 9, confirm: 'Thermal camera or freeze spray on {ref}; then measure it with the power off.', why: 'A part that heats up carries current it shouldn\'t.' },
  { id: 'hot-neighbour', when: 'hot', suspect: { where: 'series', kinds: ['resistor', 'capacitor', 'diode'] }, weight: 3, confirm: 'Measure {ref}: a short or wrong value next to a hot part forces current through it.', why: 'Too much current through one part often comes from a fault next to it.' },
  { id: 'dark-led', when: 'dark', suspect: { where: 'the-part', kinds: ['led'] }, weight: 6, confirm: 'Diode-test {ref}: it should light faintly and read about 1.6–3 V. Check it isn\'t fitted backwards.', why: 'The LED itself may be open, reversed or have a cold joint.' },
  { id: 'tested-part', when: 'tested', suspect: { where: 'the-part' }, weight: 2, confirm: 'Look at {ref}\'s joints closely (flip the board): the test probes it, and a cracked joint there reads open.', why: 'A test fails at this part.' },
  { id: 'dark-series', when: 'dark', suspect: { where: 'series', kinds: ['resistor', 'switch', 'fuse', 'diode'] }, weight: 5, confirm: 'Power on: measure across {ref}; the full supply across it means it\'s open.', why: 'The LED\'s series path may be broken.' },
];

export const ruleAddress = (modId: string, id: string) => itemAddress(modId, 'rules', id);

export interface RuleSet { rules: (RuleDef & { address: string })[]; log: Map<string, { title: string; res: PatchResult }>; addresses: Set<string> }

/** The official rules (patched by running mods) and the rules mods add. */
export function buildRuleSet(active: LoadedMod[]): RuleSet {
  const items = new Map<string, RuleDef>();
  for (const r of OFFICIAL_RULES) items.set(ruleAddress(OFFICIAL_RULES_MOD, r.id), structuredClone(r) as RuleDef);
  for (const m of active) for (const r of m.manifest.rules) items.set(ruleAddress(m.manifest.id, r.id), r);
  const entries = new Map<string, PatchEntry[]>();
  for (const m of active) for (const patch of m.manifest.patches) {
    if (patch.target.includes('/rules/')) entries.set(patch.target, [...(entries.get(patch.target) ?? []), { modId: m.manifest.id, modName: m.manifest.name, patch }]);
  }
  const log = new Map<string, { title: string; res: PatchResult }>();
  for (const [addr, es] of entries) {
    const base = items.get(addr);
    if (!base) continue;
    const { value, result } = applyPatches(base, es, ['when', 'suspect', 'weight', 'confirm', 'why'], (v) => ruleProblems(v));
    log.set(addr, { title: base.id, res: result });
    items.set(addr, value);
  }
  return { rules: [...items].map(([address, r]) => ({ ...r, address })), log, addresses: new Set(items.keys()) };
}
