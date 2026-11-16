// Fault severity models. Real failures are not one value: a "shorted cap" may be 0.1 Ω or
// 40 Ω, a "cold joint" 2 Ω or open. Each fault class samples its severity from a range
// (log-uniform: failure resistances spread over decades), from a seeded RNG so a scenario
// is reproducible. Ranges are engineering estimates from repair practice, not measured
// statistics — they are data here so they can be refined.
import type { Component } from './types';
import type { IntermittentSpec } from './intermittent';
import { netRole } from './spice/powertree';
import { addResidue } from './residue';

/** Intermittent trigger ranges (°C for thermal, flex level 0..1 for mechanical); estimates. */
export const INTERMITTENT_RANGES = {
  thermalOpen: { min: 35, max: 75, hysteresis: [3, 10] as [number, number] },
  thermalLeak: { min: 35, max: 60 },
  flex: { min: 0.3, max: 0.8 },
};

export type FaultClass =
  | 'mlcc-dead-short' | 'cap-partial-short' | 'liquid-leakage' | 'resistor-drift'
  | 'cap-capacitance-loss' | 'cold-joint' | 'open-part' | 'ic-rail-short' | 'net-break'
  | 'thermal-open-joint' | 'thermal-leak' | 'flex-open-joint' | 'flex-close-joint';

export interface FaultRange { min: number; max: number; unit: 'ohm' | 'x' ; dist: 'log' | 'lin'; note: string }

type Scalar = Exclude<FaultClass, 'open-part' | 'net-break' | 'thermal-open-joint' | 'thermal-leak' | 'flex-open-joint' | 'flex-close-joint'>;

export const FAULT_RANGES: Record<Scalar, FaultRange> = {
  'mlcc-dead-short': { min: 0.05, max: 2, unit: 'ohm', dist: 'log', note: 'cracked / failed MLCC, rail pulled to ground' },
  'cap-partial-short': { min: 2, max: 50, unit: 'ohm', dist: 'log', note: 'degraded dielectric, rail sags and the part heats' },
  'liquid-leakage': { min: 100, max: 50e3, unit: 'ohm', dist: 'log', note: 'ionic residue between pins: biases signals, rarely heats' },
  'resistor-drift': { min: 1.5, max: 30, unit: 'x', dist: 'log', note: 'corrosion raises resistance (multiplier)' },
  'cap-capacitance-loss': { min: 0.05, max: 0.6, unit: 'x', dist: 'lin', note: 'aged / cracked cap keeps a fraction of its capacitance' },
  'cold-joint': { min: 0.5, max: 1e6, unit: 'ohm', dist: 'log', note: 'series resistance of a poor joint; top of range ≈ open' },
  'ic-rail-short': { min: 0.2, max: 10, unit: 'ohm', dist: 'log', note: 'failed die / shorted internal MOSFET from a power pin to ground' },
};

const GROUND_NET = /^(A|D|P|S)?GND(_.*)?$|^VSS(_.*)?$|_GND$/i;

/** A chip's power-rail pads and ground pads, from net names (empty when it has none). */
export function icRailPads(c: Component): { rail: number[]; ground: number[] } {
  const rail: number[] = [], ground: number[] = [];
  c.pads.forEach((p, i) => {
    if (!p.net) return;
    if (GROUND_NET.test(p.net)) ground.push(i);
    else if (netRole(p.net) === 'rail') rail.push(i);
  });
  return { rail, ground };
}

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable seed from a string (e.g. scenario id + refdes). */
export function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function sampleSeverity(cls: Scalar, r: () => number): number {
  const f = FAULT_RANGES[cls];
  const u = r();
  const v = f.dist === 'log' ? Math.exp(Math.log(f.min) + u * (Math.log(f.max) - Math.log(f.min))) : f.min + u * (f.max - f.min);
  return +v.toPrecision(3);
}

export interface InjectedFault { ref: string; cls: FaultClass; severity?: number; pad?: number; describe: string }

/**
 * Applies a fault to a component with a sampled (or given) severity.
 * Two-terminal leaks go across the part's first two distinct pads.
 */
export function injectFault(c: Component, cls: FaultClass, r: () => number, opts: { severity?: number; pad?: number } = {}): InjectedFault {
  const pads = [...new Set(c.pads.map((p) => p.name))];
  const lin = (a: number, b: number) => +(a + r() * (b - a)).toPrecision(3);
  const addI = (f: IntermittentSpec) => { c.state.intermittent = [...(c.state.intermittent ?? []), f]; };
  if (cls === 'thermal-open-joint' || cls === 'flex-open-joint' || cls === 'flex-close-joint') {
    const pi = opts.pad ?? Math.floor(r() * c.pads.length);
    const R = INTERMITTENT_RANGES;
    const f: IntermittentSpec = cls === 'thermal-open-joint'
      ? { kind: 'thermal-open', pad: pi, threshold: opts.severity ?? lin(R.thermalOpen.min, R.thermalOpen.max), hysteresis: lin(...R.thermalOpen.hysteresis) }
      : { kind: cls === 'flex-open-joint' ? 'flex-open' : 'flex-close', pad: pi, threshold: opts.severity ?? lin(R.flex.min, R.flex.max) };
    addI(f);
    const what = f.kind === 'thermal-open' ? `opens above ${f.threshold} °C (closes below ${(f.threshold - f.hysteresis!).toFixed(1)} °C)` : f.kind === 'flex-open' ? `opens when the board flexes (≥ ${f.threshold})` : `only conducts while pressed (≥ ${f.threshold})`;
    return { ref: c.ref, cls, severity: f.threshold, pad: pi, describe: `${c.ref} pad ${c.pads[pi].name}: cracked joint, ${what}` };
  }
  if (cls === 'thermal-leak') {
    const ohms = sampleSeverity('cap-partial-short', r);
    const f: IntermittentSpec = { kind: 'thermal-leak', threshold: opts.severity ?? lin(INTERMITTENT_RANGES.thermalLeak.min, INTERMITTENT_RANGES.thermalLeak.max), hysteresis: 4, ohms };
    addI(f);
    return { ref: c.ref, cls, severity: f.threshold, describe: `${c.ref}: leaks ${ohms} Ω above ${f.threshold} °C` };
  }
  if (cls === 'net-break') {
    const named = c.pads.map((p, i) => (p.net ? i : -1)).filter((i) => i >= 0);
    if (!named.length) throw new Error(`${c.ref}: no named nets to break`);
    const pi = opts.pad !== undefined && named.includes(opts.pad) ? opts.pad : named[Math.floor(r() * named.length)];
    if (!c.state.netBreak?.includes(pi)) c.state.netBreak = [...(c.state.netBreak ?? []), pi].sort((a, b) => a - b);
    addResidue(c, 0.6, false, [pi]); // corrosion that ate the copper is visible near the pin
    return { ref: c.ref, cls, pad: pi, describe: `${c.ref} pad ${c.pads[pi].name}: broken copper on ${c.pads[pi].net} near this pin — reflow will not fix it, bridge it with a jumper wire` };
  }
  const sev = cls === 'open-part' ? undefined : opts.severity ?? sampleSeverity(cls, r);
  switch (cls) {
    case 'ic-rail-short': {
      const { rail, ground } = icRailPads(c);
      if (!rail.length || !ground.length) throw new Error(`${c.ref}: no power-rail and ground pins to short`);
      const pi = opts.pad !== undefined && rail.includes(opts.pad) ? opts.pad : rail[Math.floor(r() * rail.length)];
      const a = c.pads[pi].name, b = c.pads[ground[0]].name;
      c.state.leak = { ohms: sev!, a, b };
      return { ref: c.ref, cls, severity: sev, pad: pi, describe: `${c.ref}: internal short ${fmt(sev!)} from pin ${a} (${c.pads[pi].net}) to ground — ${FAULT_RANGES[cls].note}` };
    }
    case 'mlcc-dead-short': case 'cap-partial-short': case 'liquid-leakage':
      c.state.leak = { ohms: sev!, a: pads[0], b: pads[1] };
      if (cls === 'liquid-leakage') addResidue(c, 1, true); // the leak *is* the visible ionic film
      return { ref: c.ref, cls, severity: sev, describe: `${c.ref}: ${fmt(sev!)} across pads ${pads[0]}–${pads[1]} (${FAULT_RANGES[cls].note})` };
    case 'resistor-drift': case 'cap-capacitance-loss':
      c.state.drift = sev;
      return { ref: c.ref, cls, severity: sev, describe: `${c.ref}: value ×${sev} (${FAULT_RANGES[cls].note})` };
    case 'cold-joint': {
      const pi = opts.pad ?? Math.floor(r() * c.pads.length);
      if (!c.state.cold.includes(pi)) c.state.cold = [...c.state.cold, pi].sort((a, b) => a - b);
      c.state.coldOhms = { ...(c.state.coldOhms ?? {}), [pi]: sev! };
      return { ref: c.ref, cls, severity: sev, pad: pi, describe: `${c.ref} pad ${c.pads[pi].name}: cold joint ${fmt(sev!)}` };
    }
    case 'open-part':
      c.state.burnt = true;
      return { ref: c.ref, cls, describe: `${c.ref}: open` };
  }
}

const fmt = (ohms: number) => (ohms >= 1e6 ? `${(ohms / 1e6).toPrecision(3)} MΩ` : ohms >= 1e3 ? `${(ohms / 1e3).toPrecision(3)} kΩ` : `${ohms.toPrecision(3)} Ω`);

// ---- Authoring helpers (Author Studio): which faults fit a part, what a part currently has ----

export const FAULT_LABELS: Record<FaultClass, string> = {
  'mlcc-dead-short': 'Dead short (failed MLCC)',
  'cap-partial-short': 'Partial short (leaky cap)',
  'liquid-leakage': 'Liquid residue leakage',
  'resistor-drift': 'Resistance drift',
  'cap-capacitance-loss': 'Capacitance loss',
  'cold-joint': 'Resistive cold joint',
  'open-part': 'Open (damaged part)',
  'ic-rail-short': 'Chip shorted inside (power pin to ground)',
  'net-break': 'Broken copper near a pin (corroded trace / via)',
  'thermal-open-joint': 'Intermittent: opens when warm',
  'thermal-leak': 'Intermittent: leaks when warm',
  'flex-open-joint': 'Intermittent: opens on flex',
  'flex-close-joint': 'Intermittent: works only when pressed',
};

/** Fault classes that the Fast DC solver cannot represent (it only knows open / closed). */
const SPICE_ONLY = new Set<FaultClass>(['mlcc-dead-short', 'cap-partial-short', 'liquid-leakage', 'resistor-drift', 'cap-capacitance-loss', 'cold-joint', 'thermal-leak', 'ic-rail-short']);
export const needsSpice = (cls: FaultClass) => SPICE_ONLY.has(cls);

/** Fault classes that make physical sense for a part, derived from its kind and pad count only. */
export function applicableFaults(c: Component): FaultClass[] {
  const twoPads = new Set(c.pads.map((p) => p.name)).size >= 2;
  const out: FaultClass[] = [];
  if (c.kind === 'capacitor') out.push('mlcc-dead-short', 'cap-partial-short', 'cap-capacitance-loss');
  if (c.kind === 'resistor') out.push('resistor-drift');
  if (c.kind === 'ic') { const ip = icRailPads(c); if (ip.rail.length && ip.ground.length) out.push('ic-rail-short'); }
  if (twoPads) out.push('liquid-leakage');
  if (c.pads.length) out.push('cold-joint', 'thermal-open-joint', 'flex-open-joint', 'flex-close-joint');
  if (c.pads.some((p) => p.net)) out.push('net-break');
  if (twoPads) out.push('thermal-leak');
  return out;
}

/** What the severity number means for a class, and the range it is sampled from when left blank. */
export function severityHint(cls: FaultClass): { unit: string; min: number; max: number; what: string } | null {
  const R = INTERMITTENT_RANGES;
  if (cls === 'open-part' || cls === 'net-break') return null;
  if (cls === 'thermal-open-joint') return { unit: '°C', min: R.thermalOpen.min, max: R.thermalOpen.max, what: 'opens above' };
  if (cls === 'thermal-leak') return { unit: '°C', min: R.thermalLeak.min, max: R.thermalLeak.max, what: 'leaks above' };
  if (cls === 'flex-open-joint' || cls === 'flex-close-joint') return { unit: 'flex 0–1', min: R.flex.min, max: R.flex.max, what: 'flex threshold' };
  const f = FAULT_RANGES[cls];
  return { unit: f.unit === 'ohm' ? 'Ω' : '×', min: f.min, max: f.max, what: f.unit === 'ohm' ? 'resistance' : 'multiplier' };
}

export interface FaultEntry {
  /** Stable key for clearFault: burnt | reversed | leak | drift | cold:<pad> | lifted:<pad> | break:<pad> | int:<index>. */
  key: string;
  label: string;
  /** Invisible to the Fast DC solver. */
  spiceOnly: boolean;
}

/** Every fault currently on a part, in a form an author can review and remove. */
export function listFaults(c: Component): FaultEntry[] {
  const s = c.state;
  const out: FaultEntry[] = [];
  const padName = (pi: number) => c.pads[pi]?.name ?? String(pi);
  const ints = s.intermittent ?? [];
  const activeLeak = ints.some((f) => f.kind === 'thermal-leak' && f.active);
  const intPads = new Set(ints.filter((f) => f.kind !== 'thermal-leak' && f.active).map((f) => f.pad));
  if (s.burnt) out.push({ key: 'burnt', label: 'Open (damaged)', spiceOnly: false });
  if (s.reversed) out.push({ key: 'reversed', label: 'Fitted reversed', spiceOnly: false });
  if (s.leak && !activeLeak) {
    const pads = s.leak.a && s.leak.b ? ` across ${s.leak.a}–${s.leak.b}` : '';
    out.push({ key: 'leak', label: `Leak ${fmt(s.leak.ohms)}${pads}`, spiceOnly: true });
  }
  if (s.drift !== undefined && s.drift !== 1) out.push({ key: 'drift', label: `Value ×${s.drift}`, spiceOnly: true });
  for (const pi of s.lifted ?? []) out.push({ key: `lifted:${pi}`, label: `Lifted pad ${padName(pi)}`, spiceOnly: false });
  if (s.residue) out.push({ key: 'residue', label: `Corrosion residue ${Math.round(s.residue.amount * 100)} %${s.residue.leaky ? ' (forms the leak)' : ''}`, spiceOnly: false });
  for (const pi of s.netBreak ?? []) out.push({ key: `break:${pi}`, label: `Broken copper near pad ${padName(pi)}${c.pads[pi]?.net ? ` (${c.pads[pi].net})` : ''}`, spiceOnly: false });
  for (const pi of s.cold) {
    if (s.lifted?.includes(pi)) continue;
    const ohms = s.coldOhms?.[pi];
    if (ohms === undefined && intPads.has(pi)) continue; // the intermittent below owns this open
    out.push({ key: `cold:${pi}`, label: ohms === undefined ? `Cold joint pad ${padName(pi)} (open)` : `Cold joint pad ${padName(pi)} ${fmt(ohms)}`, spiceOnly: ohms !== undefined });
  }
  ints.forEach((f, i) => {
    const on = f.active ? ' · now active' : '';
    const label = f.kind === 'thermal-open' ? `Pad ${padName(f.pad!)} opens above ${f.threshold} °C`
      : f.kind === 'thermal-leak' ? `Leaks ${fmt(f.ohms ?? 10)} above ${f.threshold} °C`
        : f.kind === 'flex-open' ? `Pad ${padName(f.pad!)} opens on flex ≥ ${f.threshold}`
          : `Pad ${padName(f.pad!)} conducts only when pressed (≥ ${f.threshold})`;
    out.push({ key: `int:${i}`, label: label + on, spiceOnly: f.kind === 'thermal-leak' });
  });
  return out;
}

/** Removes one fault listed by listFaults, including the electrical effect of an active intermittent. */
export function clearFault(c: Component, key: string): void {
  const s = c.state;
  const [what, arg] = key.split(':');
  const n = Number(arg);
  const dropCold = (pi: number) => {
    s.cold = s.cold.filter((x) => x !== pi);
    if (s.coldOhms) { const { [pi]: _gone, ...rest } = s.coldOhms; void _gone; s.coldOhms = Object.keys(rest).length ? rest : undefined; }
  };
  switch (what) {
    case 'burnt': s.burnt = false; break;
    case 'reversed': s.reversed = false; break;
    case 'leak': s.leak = undefined; if (s.residue?.leaky) s.residue = undefined; break;
    case 'drift': s.drift = undefined; break;
    case 'cold': dropCold(n); break;
    case 'residue': if (s.residue?.leaky) s.leak = undefined; s.residue = undefined; break;
    case 'break': s.netBreak = s.netBreak?.filter((x) => x !== n); if (!s.netBreak?.length) s.netBreak = undefined; break;
    case 'lifted': s.lifted = s.lifted?.filter((x) => x !== n); if (!s.lifted?.length) s.lifted = undefined; dropCold(n); break;
    case 'int': {
      const f = s.intermittent?.[n];
      if (!f) return;
      s.intermittent = s.intermittent!.filter((_, i) => i !== n);
      if (!s.intermittent.length) s.intermittent = undefined;
      if (f.active && f.kind === 'thermal-leak') s.leak = undefined;
      else if (f.active && f.pad !== undefined && s.coldOhms?.[f.pad] === undefined && !s.lifted?.includes(f.pad)) s.cold = s.cold.filter((x) => x !== f.pad);
      break;
    }
  }
}
