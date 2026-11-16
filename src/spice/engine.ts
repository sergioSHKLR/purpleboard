// SPICE engine: elaborates a Circuit (flattening subcircuits), builds the MNA system and
// runs DC operating point, DC sweep and transient analyses with Newton–Raphson.
import type { Analysis, Circuit, Element, Model, Subckt } from './types';
import { SparseLU, SparseMatrix } from './sparse';
import { compileExpr, mapExprNodes, parseExpr, ExprError } from './expr';
import {
  BSource, Bjt, Capacitor, Device, Diode, ISource, Inductor, Mosfet, Resistor, Switch, VCCS, VCVS, VSource,
  bjtParams, diodeParams, mosParams, swParams, type Ctx, type DevReport,
} from './devices';

export interface EngineOptions {
  reltol: number;
  abstol: number;
  vntol: number;
  gmin: number;
  /** Conductance from every node to ground (ngspice `.option rshunt` = 1/gshunt). 0 = off. */
  gshunt: number;
  itl1: number;
  itl4: number;
}

const DEFAULTS: EngineOptions = { reltol: 1e-3, abstol: 1e-12, vntol: 1e-6, gmin: 1e-12, gshunt: 0, itl1: 150, itl4: 25 };

export interface OpResult {
  converged: boolean;
  iterations: number;
  strategy: 'newton' | 'gmin' | 'source' | 'ptran' | 'failed';
  /** Node voltages by node name (ground omitted). */
  nodes: Map<string, number>;
  /** Branch currents, keyed `i(<element>)`. */
  branches: Map<string, number>;
  devices: Map<string, DevReport>;
  singular: string[];
  x: Float64Array;
}

export interface SweepResult { src: string; values: number[]; points: OpResult[] }

export interface TranResult {
  converged: boolean;
  message?: string;
  time: number[];
  /** Saved node voltages / branch currents per time point, keyed by name ("v(n)" / "i(V1)"). */
  signals: Map<string, number[]>;
  steps: number;
  rejected: number;
  final: OpResult | null;
}

export type AnalysisResult =
  | { type: 'op'; result: OpResult }
  | { type: 'dc'; result: SweepResult }
  | { type: 'tran'; result: TranResult };

export class SpiceError extends Error {}

const isGround = (n: string) => n === '0' || n.toLowerCase() === 'gnd';

export class Engine {
  readonly opts: EngineOptions;
  readonly devices: Device[] = [];
  readonly deviceByName = new Map<string, Device>();
  /** Unknown index → name ("node" or "elem#branch"). */
  readonly unknownNames: string[] = [];
  readonly isVoltage: boolean[] = [];
  private readonly nodeIdx = new Map<string, number>();
  private readonly nodeDisplay: string[] = [];
  private readonly branchOf = new Map<string, number>();
  private readonly lu = new SparseLU();
  private x: Float64Array = new Float64Array(0);
  readonly warnings: string[] = [];

  constructor(readonly circuit: Circuit, opts: Partial<EngineOptions> = {}) {
    const o = circuit.options ?? {};
    this.opts = {
      ...DEFAULTS,
      ...(o.reltol !== undefined && { reltol: o.reltol }),
      ...(o.abstol !== undefined && { abstol: o.abstol }),
      ...(o.vntol !== undefined && { vntol: o.vntol }),
      ...(o.gmin !== undefined && { gmin: o.gmin }),
      ...(o.rshunt !== undefined && o.rshunt > 0 && { gshunt: 1 / o.rshunt }),
      ...(o.itl1 !== undefined && { itl1: o.itl1 }),
      ...(o.itl4 !== undefined && { itl4: o.itl4 }),
      ...opts,
    };
    const models = new Map<string, Model>();
    for (const m of circuit.models) models.set(m.name.toLowerCase(), m);
    const subckts = new Map<string, Subckt>();
    for (const s of circuit.subckts) subckts.set(s.name.toLowerCase(), s);
    this.elaborate(circuit.elements, '', new Map(), [models], subckts, 0);
    this.x = new Float64Array(this.unknownNames.length);
  }

  get size() { return this.unknownNames.length; }

  // ---------- elaboration ----------

  private node(name: string): number {
    if (isGround(name)) return -1;
    const key = name.toLowerCase();
    let k = this.nodeIdx.get(key);
    if (k === undefined) {
      k = this.unknownNames.length;
      this.unknownNames.push(name);
      this.isVoltage.push(true);
      this.nodeIdx.set(key, k);
      this.nodeDisplay.push(name);
    }
    return k;
  }

  private branch(elem: string): number {
    const k = this.unknownNames.length;
    this.unknownNames.push(elem + '#branch');
    this.isVoltage.push(false);
    this.branchOf.set(elem.toLowerCase(), k);
    return k;
  }

  private elaborate(els: Element[], prefix: string, portMap: Map<string, string>, scopes: Map<string, Model>[], subckts: Map<string, Subckt>, depth: number) {
    if (depth > 30) throw new SpiceError('Subcircuit nesting too deep (recursive .subckt?)');
    const mapNode = (n: string) => {
      if (isGround(n)) return '0';
      const p = portMap.get(n.toLowerCase());
      if (p !== undefined) return p;
      return prefix ? `${prefix}.${n}` : n;
    };
    const findModel = (name: string): Model => {
      for (let i = scopes.length - 1; i >= 0; i--) {
        const m = scopes[i].get(name.toLowerCase());
        if (m) return m;
      }
      throw new SpiceError(`Unknown model "${name}"`);
    };
    for (const e of els) {
      const name = prefix ? `${prefix}.${e.name}` : e.name;
      const N = (i: number) => this.node(mapNode(e.n[i]));
      let dev: Device;
      switch (e.kind) {
        case 'R':
          if (!(e.value !== 0 && isFinite(e.value))) throw new SpiceError(`${name}: resistance must be non-zero`);
          dev = new Resistor(name, N(0), N(1), e.value);
          break;
        case 'C': dev = new Capacitor(name, N(0), N(1), e.value, e.ic); break;
        case 'L': { const a = N(0), b = N(1); dev = new Inductor(name, a, b, this.branch(name), e.value, e.ic); break; }
        case 'V': { const a = N(0), b = N(1); dev = new VSource(name, a, b, this.branch(name), e.wave); break; }
        case 'I': dev = new ISource(name, N(0), N(1), e.wave); break;
        case 'E': { const a = N(0), b = N(1), c = N(2), d = N(3); dev = new VCVS(name, a, b, c, d, this.branch(name), e.gain); break; }
        case 'G': dev = new VCCS(name, N(0), N(1), N(2), N(3), e.gain); break;
        case 'D': {
          const m = findModel(e.model);
          if (m.type !== 'D') throw new SpiceError(`${name}: model ${m.name} is not a diode`);
          const P = diodeParams(m.params);
          const a = N(0), k = N(1);
          const ai = P.RS > 0 ? this.node(`${name}#a`) : a;
          dev = new Diode(name, a, ai, k, P, e.area ?? 1);
          break;
        }
        case 'M': {
          const m = findModel(e.model);
          if (m.type !== 'NMOS' && m.type !== 'PMOS') throw new SpiceError(`${name}: model ${m.name} is not a MOSFET`);
          dev = new Mosfet(name, N(0), N(1), N(2), m.type === 'PMOS', mosParams(m.params, e.w, e.l));
          N(3); // bulk node exists in the netlist; body effect not modelled
          break;
        }
        case 'Q': {
          const m = findModel(e.model);
          if (m.type !== 'NPN' && m.type !== 'PNP') throw new SpiceError(`${name}: model ${m.name} is not a BJT`);
          dev = new Bjt(name, N(0), N(1), N(2), m.type === 'PNP', bjtParams(m.params), e.area ?? 1);
          break;
        }
        case 'S': {
          const m = findModel(e.model);
          if (m.type !== 'SW') throw new SpiceError(`${name}: model ${m.name} is not a switch`);
          dev = new Switch(name, N(0), N(1), N(2), N(3), swParams(m.params), !!e.on);
          break;
        }
        case 'B': {
          let ex;
          try { ex = mapExprNodes(parseExpr(e.expr), mapNode); } catch (err) { throw new SpiceError(`${name}: ${(err as ExprError).message}`); }
          const a = N(0), b = N(1);
          const f = compileExpr(ex, (nn) => this.node(nn));
          dev = new BSource(name, a, b, e.mode === 'V' ? this.branch(name) : -1, e.mode, f);
          break;
        }
        case 'X': {
          const sub = subckts.get(e.subckt.toLowerCase());
          if (!sub) throw new SpiceError(`${name}: unknown subcircuit "${e.subckt}"`);
          if (sub.ports.length !== e.n.length) throw new SpiceError(`${name}: ${e.subckt} expects ${sub.ports.length} nodes, got ${e.n.length}`);
          const pm = new Map<string, string>();
          sub.ports.forEach((p, i) => pm.set(p.toLowerCase(), mapNode(e.n[i])));
          const local = new Map<string, Model>();
          for (const m of sub.models) local.set(m.name.toLowerCase(), m);
          this.elaborate(sub.elements, name, pm, [...scopes, local], subckts, depth + 1);
          continue;
        }
      }
      if (this.deviceByName.has(name.toLowerCase())) throw new SpiceError(`Duplicate element name ${name}`);
      this.devices.push(dev);
      this.deviceByName.set(name.toLowerCase(), dev);
    }
  }

  // ---------- Newton ----------

  private makeCtx(mode: 'dc' | 'tran', tstep = 0, tstop = 0): Ctx {
    const n = this.size;
    return {
      A: new SparseMatrix(n), b: new Float64Array(n), x: this.x,
      mode, time: 0, h: 0, method: 'be', srcFact: 1, gmin: this.opts.gmin, noncon: false, tstep, tstop,
    };
  }

  private newton(ctx: Ctx, maxIter: number, gshunt: number, pt?: { g: number; xPrev: Float64Array }): { ok: boolean; iters: number; singular: number[] } {
    const n = this.size;
    const { reltol, vntol, abstol } = this.opts;
    let singular: number[] = [];
    for (let it = 1; it <= maxIter; it++) {
      ctx.A.clear();
      ctx.b.fill(0);
      ctx.noncon = false;
      for (const d of this.devices) d.load(ctx);
      if (gshunt > 0) for (let i = 0; i < n; i++) if (this.isVoltage[i]) ctx.A.add(i, i, gshunt);
      if (pt) for (let i = 0; i < n; i++) if (this.isVoltage[i]) { ctx.A.add(i, i, pt.g); ctx.b[i] += pt.g * pt.xPrev[i]; }
      const res = this.lu.solve(ctx.A, ctx.b);
      singular = res.singular;
      const xn = res.x;
      let conv = !ctx.noncon;
      for (let i = 0; i < n; i++) {
        const v = xn[i];
        if (!isFinite(v)) return { ok: false, iters: it, singular };
        if (conv) {
          const tol = reltol * Math.max(Math.abs(v), Math.abs(ctx.x[i])) + (this.isVoltage[i] ? vntol : abstol);
          if (Math.abs(v - ctx.x[i]) > tol) conv = false;
        }
      }
      ctx.x = xn;
      this.x = xn;
      if (conv && it > 1) return { ok: true, iters: it, singular };
    }
    return { ok: false, iters: maxIter, singular };
  }

  /**
   * Pseudo-transient continuation: every node gets a capacitor to ground and the circuit is
   * marched from rest — effectively a power-up — until it settles; a DC solve then finishes.
   */
  private ptran(ctx: Ctx, g: number, x0?: Float64Array): { ok: boolean; iters: number; r?: { ok: boolean; iters: number; singular: number[] } } {
    ctx.x = x0 ? Float64Array.from(x0) : new Float64Array(this.size);
    let h = 1e-6, iters = 0;
    const cnode = 1e-6;
    for (let step = 0; step < 600; step++) {
      const xPrev = ctx.x;
      ctx.x = Float64Array.from(xPrev);
      const r = this.newton(ctx, 30, g, { g: cnode / h, xPrev });
      iters += r.iters;
      if (!r.ok) { ctx.x = xPrev; h /= 4; if (h < 1e-14) return { ok: false, iters }; continue; }
      let dmax = 0;
      for (let i = 0; i < this.size; i++) if (this.isVoltage[i]) dmax = Math.max(dmax, Math.abs(ctx.x[i] - xPrev[i]));
      h = Math.min(r.iters <= 6 ? h * 4 : r.iters <= 12 ? h * 1.5 : h, 1e6);
      if (dmax < 1e-4 && h >= 1e-2) {
        const fin = this.newton(ctx, this.opts.itl1, g);
        iters += fin.iters;
        if (fin.ok) return { ok: true, iters, r: fin };
      }
    }
    return { ok: false, iters };
  }

  /** DC operating point with gmin- and source-stepping fallbacks. */
  op(initial?: Float64Array): OpResult {
    const ctx = this.makeCtx('dc');
    const start = initial && initial.length === this.size ? Float64Array.from(initial) : new Float64Array(this.size);
    ctx.x = start;
    const g = this.opts.gshunt;
    let total = 0;
    let r = this.newton(ctx, this.opts.itl1, g);
    total += r.iters;
    let strategy: OpResult['strategy'] = 'newton';
    if (!r.ok && this.devices.length > 200) {
      const pt = this.ptran(ctx, g, initial);
      total += pt.iters;
      if (pt.ok) { r = pt.r!; strategy = 'ptran'; }
    }
    if (!r.ok) {
      strategy = 'gmin';
      ctx.x = new Float64Array(this.size);
      let ok = true;
      for (let gs = 1e-2; gs >= Math.max(g, 1e-13); gs /= 10) {
        r = this.newton(ctx, this.opts.itl1, Math.max(gs, g));
        total += r.iters;
        if (!r.ok) { ok = false; break; }
      }
      if (ok) { r = this.newton(ctx, this.opts.itl1, g); total += r.iters; }
      if (!ok || !r.ok) {
        strategy = 'source';
        ctx.x = new Float64Array(this.size);
        let f = 0, df = 0.1;
        ok = true;
        while (f < 1) {
          const nf = Math.min(1, f + df);
          ctx.srcFact = nf;
          const save = ctx.x;
          r = this.newton(ctx, this.opts.itl1, g);
          total += r.iters;
          if (r.ok) { f = nf; df = Math.min(df * 2, 0.5); }
          else {
            ctx.x = save;
            df /= 4;
            if (df < 1e-5) { ok = false; break; }
          }
        }
        ctx.srcFact = 1;
        if (!ok) {
          const pt = this.ptran(ctx, g);
          total += pt.iters;
          if (pt.ok) { r = pt.r!; ok = true; strategy = 'ptran'; }
          if (!ok) strategy = 'failed';
        }
      }
    }
    for (const d of this.devices) d.accept(ctx);
    return this.opResult(ctx.x, strategy !== 'failed' && r.ok, total, strategy, r.singular);
  }

  private opResult(x: Float64Array, converged: boolean, iterations: number, strategy: OpResult['strategy'], singular: number[]): OpResult {
    const nodes = new Map<string, number>();
    const branches = new Map<string, number>();
    for (let i = 0; i < this.size; i++) {
      if (this.isVoltage[i]) nodes.set(this.unknownNames[i], x[i]);
      else branches.set(`i(${this.unknownNames[i].replace(/#branch$/, '')})`, x[i]);
    }
    const devices = new Map<string, DevReport>();
    for (const d of this.devices) devices.set(d.name, d.report(x));
    return { converged, iterations, strategy, nodes, branches, devices, singular: singular.map((i) => this.unknownNames[i]), x: Float64Array.from(x) };
  }

  /** Node voltage from a result vector (ground and unknown nodes → 0 / undefined). */
  voltage(x: Float64Array, node: string): number | undefined {
    if (isGround(node)) return 0;
    const k = this.nodeIdx.get(node.toLowerCase());
    return k === undefined ? undefined : x[k];
  }

  /** Overrides (or with null restores) the DC value of an independent source. */
  setDc(name: string, v: number | null): void {
    const d = this.deviceByName.get(name.toLowerCase());
    if (!(d instanceof VSource || d instanceof ISource)) throw new SpiceError(`No independent source ${name}`);
    d.dcOverride = v;
  }

  hasNode(node: string): boolean {
    return isGround(node) || this.nodeIdx.has(node.toLowerCase());
  }

  // ---------- DC sweep ----------

  dc(src: string, start: number, stop: number, step: number): SweepResult {
    const dev = this.deviceByName.get(src.toLowerCase());
    if (!(dev instanceof VSource || dev instanceof ISource)) throw new SpiceError(`.dc source ${src} not found`);
    if (step === 0 || Math.sign(stop - start) * Math.sign(step) < 0) throw new SpiceError('.dc: bad step');
    const values: number[] = [];
    const points: OpResult[] = [];
    const count = Math.floor((stop - start) / step + 1e-9);
    for (let k = 0; k <= count; k++) {
      const v = start + k * step;
      dev.dcOverride = v;
      values.push(v);
      if (k === 0) { points.push(this.op()); continue; }
      const ctx = this.makeCtx('dc');
      ctx.x = Float64Array.from(this.x);
      const r = this.newton(ctx, this.opts.itl1, this.opts.gshunt);
      if (!r.ok) { points.push(this.op()); continue; }
      for (const d of this.devices) d.accept(ctx);
      points.push(this.opResult(ctx.x, r.ok, r.iters, 'newton', r.singular));
    }
    dev.dcOverride = null;
    return { src, values, points };
  }

  // ---------- transient ----------

  tran(tstep: number, tstop: number, opt: { tstart?: number; tmax?: number; uic?: boolean; save?: string[]; maxPoints?: number } = {}): TranResult {
    if (!(tstep > 0 && tstop > 0)) throw new SpiceError('.tran needs positive tstep and tstop');
    const tstart = opt.tstart ?? 0;
    const hmax = opt.tmax && opt.tmax > 0 ? opt.tmax : Math.min(tstep, (tstop - tstart) / 50);
    const hmin = tstop * 1e-12;
    const ctx = this.makeCtx('tran', tstep, tstop);

    // initial point
    let final: OpResult | null = null;
    if (opt.uic) {
      ctx.x = new Float64Array(this.size);
      this.x = ctx.x;
    } else {
      const op = this.op();
      if (!op.converged) return { converged: false, message: 'Operating point failed to converge', time: [], signals: new Map(), steps: 0, rejected: 0, final: op };
      ctx.x = Float64Array.from(op.x);
    }
    ctx.mode = 'tran';
    for (const d of this.devices) d.initTran(ctx, !!opt.uic);

    const saveIdx: [string, number][] = [];
    const wanted = opt.save?.map((s) => s.toLowerCase());
    for (let i = 0; i < this.size; i++) {
      const key = this.isVoltage[i] ? `v(${this.unknownNames[i]})` : `i(${this.unknownNames[i].replace(/#branch$/, '')})`;
      if (!this.isVoltage[i] && !/^[vl]/i.test(this.unknownNames[i])) continue;
      if (this.isVoltage[i] && this.unknownNames[i].includes('#')) continue;
      if (wanted && !wanted.includes(key.toLowerCase()) && !wanted.includes(this.unknownNames[i].toLowerCase())) continue;
      saveIdx.push([key, i]);
    }
    const signals = new Map<string, number[]>(saveIdx.map(([k]) => [k, []]));
    const time: number[] = [];
    const record = (t: number) => {
      if (t + 1e-15 < tstart) return;
      time.push(t);
      for (const [k, i] of saveIdx) signals.get(k)!.push(ctx.x[i]);
    };
    record(0);

    const bps = new Set<number>();
    for (const d of this.devices) for (const t of d.breakpoints(tstop, tstep)) bps.add(t);
    bps.add(tstop);
    const breakpoints = [...bps].sort((a, b) => a - b);
    let bpi = 0;

    let t = 0;
    let h = Math.min(hmax, tstep) / 10;
    let method: 'be' | 'trap' = 'be';
    let steps = 0, rejected = 0;
    const maxPoints = opt.maxPoints ?? 2_000_000;
    while (t < tstop * (1 - 1e-12)) {
      while (bpi < breakpoints.length && breakpoints[bpi] <= t * (1 + 1e-12) + 1e-18) bpi++;
      const nextBp = breakpoints[bpi] ?? tstop;
      let hitBp = false;
      if (t + h >= nextBp - hmin) { h = nextBp - t; hitBp = true; }
      ctx.time = t + h; ctx.h = h; ctx.method = method;
      const xPrev = ctx.x;
      ctx.x = Float64Array.from(xPrev);
      const r = this.newton(ctx, this.opts.itl4, this.opts.gshunt);
      if (!r.ok) {
        rejected++;
        ctx.x = xPrev;
        this.x = xPrev;
        h /= 8;
        method = 'be';
        if (h < hmin) {
          return { converged: false, message: `Timestep too small at t=${t.toExponential(3)}`, time, signals, steps, rejected, final };
        }
        continue;
      }
      for (const d of this.devices) d.accept(ctx);
      t += h;
      steps++;
      record(t);
      if (steps > maxPoints) return { converged: false, message: 'Too many time points', time, signals, steps, rejected, final };
      if (hitBp) { method = 'be'; h = Math.min(hmax, tstep) / 10; }
      else {
        method = 'trap';
        if (r.iters <= 4) h = Math.min(h * 2, hmax);
        else if (r.iters > 12) h /= 2;
      }
    }
    final = this.opResult(ctx.x, true, 0, 'newton', []);
    return { converged: true, time, signals, steps, rejected, final };
  }

  /** Runs every analysis card in the circuit. Defaults to `.op` when there is none. */
  run(analyses: Analysis[] = this.circuit.analyses): AnalysisResult[] {
    const list = analyses.length ? analyses : [{ type: 'op' } as Analysis];
    return list.map((a): AnalysisResult => {
      if (a.type === 'op') return { type: 'op', result: this.op() };
      if (a.type === 'dc') return { type: 'dc', result: this.dc(a.src, a.start, a.stop, a.step) };
      return { type: 'tran', result: this.tran(a.tstep, a.tstop, { tstart: a.tstart, tmax: a.tmax, uic: a.uic }) };
    });
  }
}

/** Linear interpolation of a transient signal at time `t`. */
export function sampleAt(time: number[], sig: number[], t: number): number {
  if (!time.length) return NaN;
  if (t <= time[0]) return sig[0];
  let lo = 0, hi = time.length - 1;
  if (t >= time[hi]) return sig[hi];
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (time[mid] <= t) lo = mid; else hi = mid; }
  const f = (t - time[lo]) / (time[hi] - time[lo] || 1);
  return sig[lo] + f * (sig[hi] - sig[lo]);
}
