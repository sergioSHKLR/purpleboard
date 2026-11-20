// Fault types as mod items. The 13 classes in src/faults.ts are the mod official-faults (their
// severity ranges can be patched); a mod adds new fault types as data, made of primitives that set
// the same part state the built-in faults do, so listing, clearing, repairing and the flag check
// work unchanged:
//
//   { "id": "salt-water", "name": "Salt-water damage", "applies": { "kinds": ["capacitor", "resistor"] },
//     "effects": [ { "do": "leak", "ohms": { "min": 200, "max": 20000 } }, { "do": "residue", "amount": 0.8, "leaky": true } ] }
//
// The first effect with a range takes the severity an author types in the Author tab or a puzzle.
import type { Component, ComponentKind } from '../types';
import { FAULT_LABELS, FAULT_RANGES, applicableFaults, icRailPads, injectFault, needsSpice, type FaultClass, type FaultRange } from '../faults';
import { addResidue } from '../residue';
import { itemAddress } from './address';
import type { LoadedMod } from './mods';
import { applyPatches, type PatchEntry, type PatchResult } from './patches';

export const OFFICIAL_FAULTS_MOD = 'official-faults';

export interface Range { min: number; max: number; dist?: 'log' | 'lin' }
export type Primitive =
  | { do: 'leak'; between?: [string, string] | 'rail-ground'; ohms: Range }
  | { do: 'drift'; factor: Range }
  | { do: 'cold'; pad?: string; ohms?: Range }
  | { do: 'open' }
  | { do: 'break'; pad?: string }
  | { do: 'residue'; amount: number; leaky?: boolean }
  | { do: 'warm-open'; pad?: string; temp: Range }
  | { do: 'warm-leak'; temp: Range }
  | { do: 'flex-open' | 'flex-close'; pad?: string; level: Range };

export interface FaultTypeDef {
  id: string;
  name: string;
  description?: string;
  applies: { kinds?: ComponentKind[]; minPads?: number; needsNet?: boolean; railToGround?: boolean };
  effects: Primitive[];
}

/** One fault type as the app offers it: official class or mod item. */
export interface FaultTypeInfo {
  address: string;
  modId: string;
  label: string;
  /** Official class (src/faults.ts), when it is one. */
  cls?: FaultClass;
  def?: FaultTypeDef;
  /** What the severity number means; null when there is none. */
  severity: { unit: string; min: number; max: number } | null;
  /** The author can pick a pad. */
  padChoice: boolean;
  /** Only SPICE shows it. */
  spiceOnly: boolean;
}

const KINDS: ComponentKind[] = ['resistor', 'capacitor', 'led', 'diode', 'battery', 'switch', 'fuse', 'testpoint', 'ic', 'connector', 'generic'];
const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
type Raw = Record<string, unknown>;
const isObj = (x: unknown): x is Raw => !!x && typeof x === 'object' && !Array.isArray(x);

function rangeProblem(x: unknown, at: string, lo: number, hi: number, unit: string): string | null {
  if (!isObj(x) || typeof x.min !== 'number' || typeof x.max !== 'number' || !(x.min > 0) || !(x.max >= x.min) || x.min < lo || x.max > hi) return `${at} must be { "min", "max" } with ${lo} ≤ min ≤ max ≤ ${hi} (${unit})`;
  if (x.dist !== undefined && x.dist !== 'log' && x.dist !== 'lin') return `${at}.dist must be "log" or "lin"`;
  return null;
}

/** Problems with a fault type (empty = valid). */
export function faultTypeProblems(d: Raw): string[] {
  const p: string[] = [];
  if (typeof d.id !== 'string' || !ID_RE.test(d.id)) p.push('"id" must be 2-64 lowercase letters, digits, ".", "-" or "_"');
  if (typeof d.name !== 'string' || !d.name.trim() || d.name.length > 80) p.push('"name" must be text (1–80 characters)');
  if (d.description !== undefined && (typeof d.description !== 'string' || d.description.length > 500)) p.push('"description" must be text');
  const a = d.applies;
  if (!isObj(a)) p.push('"applies" must be an object, e.g. { "kinds": ["capacitor"] }');
  else {
    if (a.kinds !== undefined && !(Array.isArray(a.kinds) && a.kinds.length && a.kinds.every((k) => KINDS.includes(k as ComponentKind)))) p.push(`"applies.kinds" must list part kinds: ${KINDS.join(', ')}`);
    if (a.minPads !== undefined && !(Number.isInteger(a.minPads) && (a.minPads as number) >= 1 && (a.minPads as number) <= 1000)) p.push('"applies.minPads" must be a whole number ≥ 1');
    for (const k of ['needsNet', 'railToGround'] as const) if (a[k] !== undefined && typeof a[k] !== 'boolean') p.push(`"applies.${k}" must be true or false`);
  }
  if (!Array.isArray(d.effects) || !d.effects.length || d.effects.length > 6) p.push('"effects" must list 1–6 effects');
  else d.effects.forEach((e: unknown, i: number) => {
    const at = `effects[${i}]`;
    if (!isObj(e)) { p.push(`${at} must be an object`); return; }
    const pad = e.pad !== undefined && typeof e.pad !== 'string' ? `${at}.pad must be a pad name ("2")` : null;
    const push = (x: string | null) => { if (x) p.push(x); };
    switch (e.do) {
      case 'leak':
        push(rangeProblem(e.ohms, `${at}.ohms`, 0.01, 1e9, 'Ω'));
        if (e.between !== undefined && e.between !== 'rail-ground' && !(Array.isArray(e.between) && e.between.length === 2 && e.between.every((x) => typeof x === 'string'))) p.push(`${at}.between must be two pad names or "rail-ground"`);
        break;
      case 'drift': push(rangeProblem(e.factor, `${at}.factor`, 0.01, 1000, '×')); break;
      case 'cold': push(pad); if (e.ohms !== undefined) push(rangeProblem(e.ohms, `${at}.ohms`, 0.01, 1e9, 'Ω')); break;
      case 'open': break;
      case 'break': push(pad); break;
      case 'residue':
        if (typeof e.amount !== 'number' || !(e.amount > 0 && e.amount <= 1)) p.push(`${at}.amount must be 0–1`);
        if (e.leaky !== undefined && typeof e.leaky !== 'boolean') p.push(`${at}.leaky must be true or false`);
        break;
      case 'warm-open': push(pad); push(rangeProblem(e.temp, `${at}.temp`, 25, 150, '°C')); break;
      case 'warm-leak': push(rangeProblem(e.temp, `${at}.temp`, 25, 150, '°C')); break;
      case 'flex-open': case 'flex-close': push(pad); push(rangeProblem(e.level, `${at}.level`, 0.05, 1, 'flex 0–1')); break;
      default: p.push(`${at}.do must be one of: leak, drift, cold, open, break, residue, warm-open, warm-leak, flex-open, flex-close`);
    }
  });
  return p;
}

export function parseFaultType(raw: unknown, at: string, errs: string[], warnings: string[]): FaultTypeDef | null {
  if (!isObj(raw)) { errs.push(`${at} must be an object`); return null; }
  for (const k of Object.keys(raw)) if (!['id', 'name', 'description', 'applies', 'effects'].includes(k)) warnings.push(`${at}: unknown field "${k}" (ignored)`);
  const d: Raw = { applies: {}, ...raw };
  const problems = faultTypeProblems(d);
  if (problems.length) { errs.push(...problems.map((x) => `${at}: ${x}`)); return null; }
  return structuredClone({ id: d.id, name: d.name, applies: d.applies, effects: d.effects, ...(d.description !== undefined && { description: d.description }) }) as FaultTypeDef;
}

const rangeOf = (e: Primitive): { r: Range; unit: string } | null =>
  e.do === 'leak' ? { r: e.ohms, unit: 'Ω' } : e.do === 'drift' ? { r: e.factor, unit: '×' } : e.do === 'cold' && e.ohms ? { r: e.ohms, unit: 'Ω' }
    : e.do === 'warm-open' || e.do === 'warm-leak' ? { r: e.temp, unit: '°C' } : e.do === 'flex-open' || e.do === 'flex-close' ? { r: e.level, unit: 'flex' } : null;

function sample(r: Range, rnd: () => number): number {
  const u = rnd();
  const v = (r.dist ?? 'log') === 'log' ? Math.exp(Math.log(r.min) + u * (Math.log(r.max) - Math.log(r.min))) : r.min + u * (r.max - r.min);
  return +v.toPrecision(3);
}

export function faultTypeFits(def: FaultTypeDef, c: Component): boolean {
  const a = def.applies;
  if (a.kinds && !a.kinds.includes(c.kind)) return false;
  if (new Set(c.pads.map((p) => p.name)).size < (a.minPads ?? 1)) return false;
  if (a.needsNet && !c.pads.some((p) => p.net)) return false;
  if (a.railToGround) { const ip = icRailPads(c); if (!ip.rail.length || !ip.ground.length) return false; }
  // a leak between named pads needs those pads
  for (const e of def.effects) if (e.do === 'leak' && Array.isArray(e.between) && !e.between.every((n) => c.pads.some((p) => p.name === n))) return false;
  return true;
}

/** Plants a mod fault type on a part. `severity` replaces the first ranged effect's random value. */
export function injectFaultType(def: FaultTypeDef, c: Component, rnd: () => number, opts: { severity?: number; pad?: number } = {}): { describe: string } {
  const pads = [...new Set(c.pads.map((p) => p.name))];
  let severityUsed = false;
  const pick = (r: Range) => { if (opts.severity !== undefined && !severityUsed) { severityUsed = true; return opts.severity; } return sample(r, rnd); };
  const padIndex = (name?: string) => {
    if (opts.pad !== undefined) return opts.pad;
    if (name !== undefined) { const i = c.pads.findIndex((p) => p.name === name); if (i >= 0) return i; }
    return Math.floor(rnd() * c.pads.length);
  };
  for (const e of def.effects) {
    switch (e.do) {
      case 'leak': {
        const ohms = pick(e.ohms);
        if (e.between === 'rail-ground') {
          const { rail, ground } = icRailPads(c);
          if (!rail.length || !ground.length) throw new Error(`${c.ref}: no power-rail and ground pins`);
          c.state.leak = { ohms, a: c.pads[rail[Math.floor(rnd() * rail.length)]].name, b: c.pads[ground[0]].name };
        } else {
          const [a, b] = Array.isArray(e.between) ? e.between : [pads[0], pads[1] ?? pads[0]];
          c.state.leak = { ohms, a, b };
        }
        break;
      }
      case 'drift': c.state.drift = pick(e.factor); break;
      case 'cold': {
        const pi = padIndex(e.pad);
        if (!c.state.cold.includes(pi)) c.state.cold = [...c.state.cold, pi].sort((x, y) => x - y);
        if (e.ohms) c.state.coldOhms = { ...(c.state.coldOhms ?? {}), [pi]: pick(e.ohms) };
        break;
      }
      case 'open': c.state.burnt = true; break;
      case 'break': injectFault(c, 'net-break', rnd, { pad: padIndex(e.pad) }); break;
      case 'residue': addResidue(c, e.amount, !!e.leaky); break;
      case 'warm-open': injectFault(c, 'thermal-open-joint', rnd, { pad: padIndex(e.pad), severity: pick(e.temp) }); break;
      case 'warm-leak': injectFault(c, 'thermal-leak', rnd, { severity: pick(e.temp) }); break;
      case 'flex-open': case 'flex-close': injectFault(c, e.do === 'flex-open' ? 'flex-open-joint' : 'flex-close-joint', rnd, { pad: padIndex(e.pad), severity: Math.min(1, pick(e.level)) }); break;
    }
  }
  return { describe: `${c.ref}: ${def.name}` };
}

// ---------------- official classes + overlay ----------------

/** The patchable data of an official class: its severity range. */
export interface OfficialFaultItem { range: FaultRange | null }
const officialItem = (cls: FaultClass): OfficialFaultItem => ({ range: (FAULT_RANGES as Record<string, FaultRange>)[cls] ? structuredClone((FAULT_RANGES as Record<string, FaultRange>)[cls]) : null });

export interface FaultRegistry {
  /** Fault types from running mods (official ones come from src/faults.ts). */
  types: FaultTypeInfo[];
  defs: Map<string, FaultTypeDef>;
  log: Map<string, { title: string; res: PatchResult }>;
  addresses: Set<string>;
  /** Official classes' ranges as patched (for setFaultRangeOverlay), or null. */
  ranges: Map<FaultClass, FaultRange> | null;
}

export const officialFaultAddress = (cls: FaultClass) => itemAddress(OFFICIAL_FAULTS_MOD, 'faultTypes', cls);

/**
 * Collects running mods' fault types and applies patches: to official classes (their range; the app
 * passes `ranges` to setFaultRangeOverlay so src/faults.ts samples from it) and to mod types.
 */
export function buildFaultRegistry(active: LoadedMod[], officialClasses: readonly FaultClass[]): FaultRegistry {
  const defs = new Map<string, FaultTypeDef>();
  for (const m of active) for (const d of m.manifest.faultTypes) defs.set(itemAddress(m.manifest.id, 'faultTypes', d.id), d);
  const entries = new Map<string, PatchEntry[]>();
  for (const m of active) for (const patch of m.manifest.patches) {
    if (!patch.target.includes('/faultTypes/')) continue;
    entries.set(patch.target, [...(entries.get(patch.target) ?? []), { modId: m.manifest.id, modName: m.manifest.name, patch }]);
  }
  const log = new Map<string, { title: string; res: PatchResult }>();
  const ranges = new Map<FaultClass, FaultRange>();
  for (const [addr, es] of entries) {
    const cls = officialClasses.find((c) => officialFaultAddress(c) === addr);
    if (cls) {
      const base = officialItem(cls);
      if (!base.range) continue;
      const unit = base.range.unit;
      const { value, result } = applyPatches(base, es, ['range'], (v) => {
        const r = v.range as Raw;
        const lo = unit === 'ohm' ? 0.001 : 0.001, hi = unit === 'ohm' ? 1e9 : 1000;
        const pr = rangeProblem(r, 'range', lo, hi, unit === 'ohm' ? 'Ω' : '×');
        return pr ? [pr] : r.unit !== undefined && r.unit !== unit ? ['"range.unit" can\'t change'] : [];
      });
      log.set(addr, { title: cls, res: result });
      if (result.changes.length && value.range) ranges.set(cls, { ...value.range, unit });
    } else if (defs.has(addr)) {
      const { value, result } = applyPatches(defs.get(addr)! as unknown as Raw, es, ['name', 'description', 'applies', 'effects'], (v) => faultTypeProblems({ ...v }));
      log.set(addr, { title: defs.get(addr)!.name, res: result });
      if (result.changes.length) defs.set(addr, value as unknown as FaultTypeDef);
    }
  }
  const types: FaultTypeInfo[] = [...defs].map(([address, def]) => {
    const first = def.effects.map(rangeOf).find(Boolean) ?? null;
    return {
      address, modId: address.split('/')[0], label: def.name, def,
      severity: first ? { unit: first.unit, min: first.r.min, max: first.r.max } : null,
      padChoice: def.effects.some((e) => 'pad' in e || e.do === 'cold' || e.do === 'break' || e.do === 'warm-open' || e.do === 'flex-open' || e.do === 'flex-close'),
      spiceOnly: def.effects.some((e) => e.do === 'leak' || e.do === 'drift' || (e.do === 'cold' && !!e.ohms) || e.do === 'warm-leak'),
    };
  });
  const addresses = new Set([...officialClasses.map(officialFaultAddress), ...defs.keys()]);
  return { types, defs, log, addresses, ranges: ranges.size ? ranges : null };
}

/** Official classes and running mods' types that fit a part. */
export function faultTypesFor(c: Component, reg: FaultRegistry | null): FaultTypeInfo[] {
  const official: FaultTypeInfo[] = [...applicableFaults(c), ...(applicableFaults(c).includes('open-part') ? [] : ['open-part' as FaultClass])].map((cls) => ({
    address: officialFaultAddress(cls), modId: OFFICIAL_FAULTS_MOD, cls, label: FAULT_LABELS[cls],
    severity: null, padChoice: ['cold-joint', 'thermal-open-joint', 'flex-open-joint', 'flex-close-joint', 'net-break'].includes(cls), spiceOnly: needsSpice(cls),
  }));
  return [...official, ...(reg?.types ?? []).filter((x) => x.def && faultTypeFits(x.def, c))];
}

