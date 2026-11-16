// Behavioral converter models attached to a discovered power tree (universal templates).
//
// Every model is a set of ngspice-compatible B elements:
//   output  : Norton source  I = G·(Vset − Vout)·EN·UVLO  (high impedance when disabled,
//             LDO / load switch only source current)
//   input   : power-conserving draw (switchers: Pout/(η·Vin), linear/series: Iout)
//   PGOOD   : open-drain pull-down while Vout < 90 % of target (board pull-ups do the rest)
//   soft-start (transient): Vset ramps with an internal RC; in DC it is at its final value.
import type { Element } from './types';
import { powerStateRank, railVoltage, type PowerSource, type PowerTree } from './powertree';

export interface PowerModelOptions {
  /** Enable logic threshold (V) and transition width (V). */
  enVth?: number;
  /** Switcher efficiency for input-current conservation. */
  efficiency?: number;
  /** Soft-start time constant (s). */
  softStart?: number;
  /** Minimum confidence to model. */
  minConfidence?: 'low' | 'medium' | 'high';
  /** Explicit targets by rail (VID-controlled CPU/GPU rails, charger set points…). */
  setpoints?: Record<string, number>;
  /** Feedback reference voltages by controller refdes (from a chip library / datasheet). */
  vref?: Record<string, number>;
  /** Refs the netlist already simulates as devices (their diode/FET paths need no stand-in). */
  simulatedRefs?: Set<string>;
  /** Machine power-state rank (see sequencer POWER_STATES): enables FET power switches. */
  stateRank?: number;
  /** Refs of damaged parts: their converters / switches produce nothing. */
  deadRefs?: Set<string>;
  /** Emulated power controller: is this enable asserted? (undefined: not controller-driven). */
  enableAsserted?: (net: string) => boolean | undefined;
}

/** Forward drop of a power OR-ing diode (Schottky, at load). Typical value. */
const DIODE_OR_DROP = 0.3;

/** Output current limit by converter kind (A). Typical orders of magnitude — estimates. */
export const CURRENT_LIMIT = { buck: 8, boost: 3, ldo: 1, 'load-switch': 2, 'fet-switch': 10, 'diode-or': 5 } as const;

/** Reference voltages common to switching/linear regulator controllers. */
export const STANDARD_VREFS = [0.5, 0.591, 0.6, 0.75, 0.765, 0.8, 0.9, 1.0, 1.2, 1.21, 1.22, 1.23, 1.24, 1.25];

/** Divider/rail-name consistency: implied reference and the nearest standard one. */
export function dividerCheck(s: PowerSource): { implied: number; nearest: number; consistent: boolean } | null {
  if (!s.divider || s.vTarget === null) return null;
  const implied = s.vTarget * s.divider.ratio;
  const nearest = STANDARD_VREFS.reduce((a, b) => (Math.abs(b - implied) < Math.abs(a - implied) ? b : a));
  return { implied, nearest, consistent: Math.abs(nearest - implied) / nearest <= 0.04 };
}

export interface PowerModelReport {
  ref: string;
  kind: PowerSource['kind'];
  output: string;
  input: string | null;
  vTarget: number | null;
  target: 'setpoint' | 'rail-name' | 'fb-divider' | 'downstream-rail-name' | 'input' | 'none';
  divider?: { implied: number; nearest: number; consistent: boolean } | null;
  modelled: boolean;
  why: string;
}

const CONF = { low: 0, medium: 1, high: 2 };

/** Target voltage for a converter: own rail name, else a pass-through descendant's rail name. */
export function targetVoltage(s: PowerSource, tree: PowerTree, opts: PowerModelOptions = {}): { v: number | null; how: PowerModelReport['target'] } {
  if (s.kind === 'load-switch' || s.kind === 'fet-switch' || s.kind === 'pass-through' || s.kind === 'diode-or') return { v: null, how: 'input' };
  const set = opts.setpoints?.[s.output];
  if (set !== undefined) return { v: set, how: 'setpoint' };
  if (s.vTarget !== null) return { v: s.vTarget, how: 'rail-name' };
  const vref = opts.vref?.[s.ref];
  if (vref !== undefined && s.divider) return { v: +(vref / s.divider.ratio).toFixed(4), how: 'fb-divider' };
  const seen = new Set<string>([s.output]);
  const queue = [s.output];
  while (queue.length) {
    const r = queue.shift()!;
    for (const c of tree.sources) {
      if (c.kind !== 'pass-through' || c.input !== r || seen.has(c.output)) continue;
      const v = railVoltage(c.output);
      if (v !== null) return { v, how: 'downstream-rail-name' };
      seen.add(c.output);
      queue.push(c.output);
    }
  }
  return { v: null, how: 'none' };
}

export function powerTreeElements(tree: PowerTree, node: (net: string) => string | undefined, opts: PowerModelOptions = {}): { elements: Element[]; report: PowerModelReport[] } {
  const vth = opts.enVth ?? 1.0, eta = opts.efficiency ?? 0.9, tss = opts.softStart ?? 1e-3;
  const minC = CONF[opts.minConfidence ?? 'medium'];
  const elements: Element[] = [];
  const report: PowerModelReport[] = [];
  const s = (x: string, k = 20) => `(0.5+0.5*tanh((${x})*${k}))`; // smooth step
  let k = 0;
  for (const src of tree.sources) {
    if (opts.deadRefs?.has(src.ref)) {
      report.push({ ref: src.ref, kind: src.kind, output: src.output, input: src.input, vTarget: null, target: 'none', modelled: false, why: 'part damaged: no output' });
      continue;
    }
    // Passive power paths whose part the netlist does not simulate itself (e.g. a 3-pin dual
    // diode or a FET that the board import leaves as a generic IC footprint).
    if ((src.kind === 'diode-or' || src.kind === 'fet-switch') && !opts.simulatedRefs?.has(src.ref)) {
      const out = node(src.output), inp = src.input ? node(src.input) : undefined;
      const base = { ref: src.ref, kind: src.kind, output: src.output, input: src.input, vTarget: null, target: 'input' as const };
      if (!out || !inp) { report.push({ ...base, modelled: false, why: 'rail not in netlist' }); continue; }
      let iout: string;
      if (src.kind === 'diode-or') {
        iout = `min(${(1 / 0.05).toFixed(3)}*max(V(${inp})-${DIODE_OR_DROP}-V(${out}),0),${CURRENT_LIMIT['diode-or']})`;
      } else {
        // The gate is driven by a chip that is not simulated; with a machine state the switch
        // conducts once that state reaches its output rail's power state (unnamed: S0).
        if (opts.stateRank === undefined) { report.push({ ...base, modelled: false, why: 'FET switch: gate driver not simulated (needs a power state)' }); continue; }
        if ((powerStateRank(src.output) ?? 4) > opts.stateRank) { report.push({ ...base, modelled: false, why: 'FET switch off in this power state' }); continue; }
        iout = `min(${(1 / 0.02).toFixed(3)}*max(V(${inp})-V(${out}),0),${CURRENT_LIMIT['fet-switch']})`;
      }
      k++;
      const id = `${src.ref}_${k}`.replace(/[^A-Za-z0-9_]/g, '_');
      elements.push(
        { kind: 'B', name: `B${id}_OUT`, n: ['0', out], mode: 'I', expr: iout, note: `${src.ref} ${src.kind} ${src.input} → ${src.output}` },
        { kind: 'B', name: `B${id}_IN`, n: [inp, '0'], mode: 'I', expr: iout, note: `${src.ref} input current` },
      );
      report.push({ ...base, modelled: true, why: src.why });
      continue;
    }
    if (!['buck', 'boost', 'ldo', 'load-switch'].includes(src.kind)) continue;
    const { v, how } = targetVoltage(src, tree, opts);
    const base = { ref: src.ref, kind: src.kind, output: src.output, input: src.input, vTarget: v, target: how, divider: dividerCheck(src) };
    const out = node(src.output), inp = src.input ? node(src.input) : undefined;
    if (CONF[src.confidence] < minC) { report.push({ ...base, modelled: false, why: `confidence ${src.confidence}` }); continue; }
    if (!out || !inp) { report.push({ ...base, modelled: false, why: !inp ? 'no input rail identified' : 'output not in netlist' }); continue; }
    const series = src.kind === 'ldo' || src.kind === 'load-switch';
    if (!series && v === null) { report.push({ ...base, modelled: false, why: src.divider ? `no target voltage: FB divider ${src.divider.top}/${src.divider.bottom} found (ratio ${src.divider.ratio.toFixed(4)}) but controller Vref unknown — pass vref or a setpoint` : 'no target voltage (rail name has none, no FB divider; VID-controlled? pass a setpoint)' }); continue; }
    k++;
    const id = `${src.ref}_${k}`.replace(/[^A-Za-z0-9_]/g, '_');
    const en = src.enable ? node(src.enable) : undefined;
    const activeLow = !!src.enable && /(_L|_N|_B|N)$/.test(src.enable.toUpperCase()) && /_L$|_N$/.test(src.enable.toUpperCase());
    // An enable wired only between chips that are not simulated has no node: with a power
    // controller emulated, it follows the controller's decision for the state.
    const ctl = !en && src.enable ? opts.enableAsserted?.(src.enable) : undefined;
    const enExpr = en ? (activeLow ? s(`${vth}-V(${en})`, 25) : s(`V(${en})-${vth}`, 25)) : ctl === false ? '0' : '1';
    // UVLO: input must exceed the target (+ headroom) for bucks/LDOs, 2.5 V for boosts and switches
    const uvloV = src.kind === 'boost' || src.kind === 'load-switch' ? 2.5 : Math.max(2.5, (v ?? 0) * 1.05 + 0.2);
    const uvlo = s(`V(${inp})-${uvloV.toFixed(3)}`, 10);
    const ss = `SS_${id}`;
    // soft-start state: dV(ss)/dt = (EN·UVLO − V(ss))/τ via a 1 µF cap fed by a B current source
    elements.push(
      { kind: 'B', name: `B${id}_SS`, n: ['0', ss], mode: 'I', expr: `(${enExpr}*${uvlo}-V(${ss}))*${(1e-6 / tss).toExponential(3)}`, note: `${src.ref} soft-start` },
      { kind: 'C', name: `C${id}_SS`, n: [ss, '0'], value: 1e-6 },
      { kind: 'R', name: `R${id}_SS`, n: [ss, '0'], value: 1e9 },
    );
    const g = src.kind === 'load-switch' ? 1 / 0.03 : src.kind === 'ldo' ? 1 / 0.05 : 1 / 0.005;
    const vset = src.kind === 'load-switch' ? `V(${inp})` : src.kind === 'ldo' ? `min(${v}, V(${inp})-0.15)` : `${v}`;
    const err = `(${vset}-V(${out}))`;
    const lim = CURRENT_LIMIT[src.kind as keyof typeof CURRENT_LIMIT];
    // output current limit (a converter into a short holds its limit; it does not deliver amps unbounded)
    const iout = series
      ? `min(${g.toFixed(3)}*max(${err},0),${lim})*V(${ss})`
      : `max(min(${g.toFixed(3)}*${err},${lim}),-${lim})*V(${ss})`;
    elements.push({ kind: 'B', name: `B${id}_OUT`, n: ['0', out], mode: 'I', expr: iout, note: `${src.ref} ${src.kind} → ${src.output}${v !== null ? ` ${v} V (${how})` : ''}` });
    // input draw
    const iin = series ? iout : `(${iout})*max(V(${out}),0)/(${eta}*max(V(${inp}),1))`;
    elements.push({ kind: 'B', name: `B${id}_IN`, n: [inp, '0'], mode: 'I', expr: iin, note: `${src.ref} input current` });
    // power good (open drain)
    if (src.pgood && node(src.pgood)) {
      const pg = node(src.pgood)!;
      const ok = v !== null ? s(`V(${out})-${(0.9 * v).toFixed(3)}`, 20) : s(`V(${out})-0.9*V(${inp})`, 20);
      elements.push({ kind: 'B', name: `B${id}_PG`, n: [pg, '0'], mode: 'I', expr: `0.01*V(${pg})*(1-${ok}*V(${ss}))`, note: `${src.ref} PGOOD open-drain` });
    }
    report.push({ ...base, modelled: true, why: src.why });
  }
  return { elements, report };
}
