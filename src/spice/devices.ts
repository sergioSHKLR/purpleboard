// Device models and their MNA stamps. Unknown index -1 denotes ground.
// Conventions follow SPICE3: KCL rows sum currents *leaving* a node; a branch current
// of a V/L/E element flows from its + node through the element to its − node.
import type { SparseMatrix } from './sparse';
import type { Waveform } from './types';
import type { CompiledExpr } from './expr';

export const VT_300K = (1.380649e-23 * 300.15) / 1.602176634e-19; // ≈ 25.86 mV
const EXP_MAX = 80;

export interface Ctx {
  A: SparseMatrix;
  b: Float64Array;
  /** Current Newton iterate (all unknowns). */
  x: Float64Array;
  mode: 'dc' | 'tran';
  time: number;
  h: number;
  method: 'be' | 'trap';
  /** Source stepping factor (1 = full value). */
  srcFact: number;
  gmin: number;
  /** Set by devices whose junction voltages were limited this iteration. */
  noncon: boolean;
  /** Default rise/fall time for PULSE sources (tran tstep). */
  tstep: number;
  tstop: number;
}

export interface DevReport { i: number; p: number; v?: number; extra?: Record<string, number> }

const V = (x: Float64Array, i: number) => (i < 0 ? 0 : x[i]);

export abstract class Device {
  constructor(readonly name: string) {}
  abstract load(ctx: Ctx): void;
  /** Called once a time point (or the operating point) is accepted. */
  accept(_ctx: Ctx): void {}
  /** Initialises transient history from the operating point (or UIC values). */
  initTran(_ctx: Ctx, _uic: boolean): void {}
  breakpoints(_tstop: number, _tstep: number): number[] { return []; }
  report(_x: Float64Array): DevReport { return { i: 0, p: 0 }; }
}

function stampG(A: SparseMatrix, a: number, b: number, g: number) {
  A.add(a, a, g); A.add(b, b, g); A.add(a, b, -g); A.add(b, a, -g);
}
/** Current `i` leaving node a and entering node b (an equivalent current source a→b). */
function stampI(bv: Float64Array, a: number, b: number, i: number) {
  if (a >= 0) bv[a] -= i;
  if (b >= 0) bv[b] += i;
}
function stampBranch(A: SparseMatrix, p: number, m: number, j: number) {
  A.add(p, j, 1); A.add(m, j, -1); A.add(j, p, 1); A.add(j, m, -1);
}

// ---------- waveforms ----------

export function waveAt(w: Waveform, t: number, tstep: number, tstop: number): number {
  switch (w.type) {
    case 'dc': return w.v;
    case 'pulse': {
      const tr = w.tr > 0 ? w.tr : tstep, tf = w.tf > 0 ? w.tf : tstep;
      const pw = w.pw > 0 ? w.pw : tstop, per = w.per > 0 ? w.per : Infinity;
      if (t < w.td) return w.v1;
      let tt = t - w.td;
      if (isFinite(per)) tt %= per;
      if (tt < tr) return w.v1 + ((w.v2 - w.v1) * tt) / tr;
      if (tt < tr + pw) return w.v2;
      if (tt < tr + pw + tf) return w.v2 + ((w.v1 - w.v2) * (tt - tr - pw)) / tf;
      return w.v1;
    }
    case 'sin': {
      if (t < w.td) return w.vo;
      const tt = t - w.td;
      return w.vo + w.va * Math.sin(2 * Math.PI * w.freq * tt) * Math.exp(-tt * w.theta);
    }
    case 'pwl': {
      const p = w.pts;
      if (!p.length) return 0;
      if (t <= p[0][0]) return p[0][1];
      for (let i = 1; i < p.length; i++) {
        if (t <= p[i][0]) {
          const [t0, v0] = p[i - 1], [t1, v1] = p[i];
          return t1 === t0 ? v1 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
        }
      }
      return p[p.length - 1][1];
    }
  }
}

function waveBreakpoints(w: Waveform, tstop: number, tstep: number): number[] {
  const out: number[] = [];
  if (w.type === 'pulse') {
    const tr = w.tr > 0 ? w.tr : tstep, tf = w.tf > 0 ? w.tf : tstep;
    const pw = w.pw > 0 ? w.pw : tstop, per = w.per > 0 ? w.per : Infinity;
    for (let base = w.td; base < tstop && out.length < 40000; base += per) {
      out.push(base, base + tr, base + tr + pw, base + tr + pw + tf);
      if (!isFinite(per)) break;
    }
  } else if (w.type === 'pwl') {
    for (const [t] of w.pts) out.push(t);
  } else if (w.type === 'sin' && w.td > 0) {
    out.push(w.td);
  }
  return out.filter((t) => t > 0 && t < tstop);
}

// ---------- linear elements ----------

export class Resistor extends Device {
  constructor(name: string, readonly a: number, readonly b: number, readonly r: number) { super(name); }
  load(ctx: Ctx) { stampG(ctx.A, this.a, this.b, 1 / this.r); }
  report(x: Float64Array): DevReport {
    const v = V(x, this.a) - V(x, this.b), i = v / this.r;
    return { i, p: v * i, v };
  }
}

export class Capacitor extends Device {
  private vPrev = 0;
  private iPrev = 0;
  private iNow = 0;
  constructor(name: string, readonly a: number, readonly b: number, readonly c: number, readonly ic?: number) { super(name); }
  load(ctx: Ctx) {
    if (ctx.mode !== 'tran' || this.c === 0) return;
    const geq = ctx.method === 'trap' ? (2 * this.c) / ctx.h : this.c / ctx.h;
    const ieq = ctx.method === 'trap' ? -geq * this.vPrev - this.iPrev : -geq * this.vPrev;
    stampG(ctx.A, this.a, this.b, geq);
    stampI(ctx.b, this.a, this.b, ieq);
    const v = V(ctx.x, this.a) - V(ctx.x, this.b);
    this.iNow = geq * v + ieq;
  }
  initTran(ctx: Ctx, uic: boolean) {
    this.vPrev = uic && this.ic !== undefined ? this.ic : uic ? 0 : V(ctx.x, this.a) - V(ctx.x, this.b);
    this.iPrev = 0;
  }
  accept(ctx: Ctx) {
    if (ctx.mode !== 'tran') return;
    const v = V(ctx.x, this.a) - V(ctx.x, this.b);
    const geq = ctx.method === 'trap' ? (2 * this.c) / ctx.h : this.c / ctx.h;
    this.iPrev = ctx.method === 'trap' ? geq * (v - this.vPrev) - this.iPrev : geq * (v - this.vPrev);
    this.vPrev = v;
    this.iNow = this.iPrev;
  }
  report(x: Float64Array): DevReport {
    const v = V(x, this.a) - V(x, this.b);
    return { i: this.iNow, p: v * this.iNow, v };
  }
}

export class Inductor extends Device {
  private iPrev = 0;
  private vPrev = 0;
  constructor(name: string, readonly a: number, readonly b: number, readonly j: number, readonly l: number, readonly ic?: number) { super(name); }
  load(ctx: Ctx) {
    stampBranch(ctx.A, this.a, this.b, this.j);
    if (ctx.mode !== 'tran') return; // DC: short circuit, V(a)-V(b)=0
    const req = ctx.method === 'trap' ? (2 * this.l) / ctx.h : this.l / ctx.h;
    ctx.A.add(this.j, this.j, -req);
    ctx.b[this.j] += ctx.method === 'trap' ? -req * this.iPrev - this.vPrev : -req * this.iPrev;
  }
  initTran(ctx: Ctx, uic: boolean) {
    this.iPrev = uic ? this.ic ?? 0 : ctx.x[this.j];
    this.vPrev = uic ? 0 : V(ctx.x, this.a) - V(ctx.x, this.b);
  }
  accept(ctx: Ctx) {
    if (ctx.mode !== 'tran') return;
    this.iPrev = ctx.x[this.j];
    this.vPrev = V(ctx.x, this.a) - V(ctx.x, this.b);
  }
  report(x: Float64Array): DevReport {
    const v = V(x, this.a) - V(x, this.b), i = x[this.j];
    return { i, p: v * i, v };
  }
}

export class VSource extends Device {
  /** Overrides the DC value (used by .dc sweeps). */
  dcOverride: number | null = null;
  constructor(name: string, readonly p: number, readonly m: number, readonly j: number, public wave: Waveform) { super(name); }
  value(ctx: Ctx): number {
    if (this.dcOverride !== null) return this.dcOverride * ctx.srcFact;
    const t = ctx.mode === 'tran' ? ctx.time : 0;
    return waveAt(this.wave, t, ctx.tstep, ctx.tstop) * ctx.srcFact;
  }
  load(ctx: Ctx) {
    stampBranch(ctx.A, this.p, this.m, this.j);
    ctx.b[this.j] += this.value(ctx);
  }
  breakpoints(tstop: number, tstep: number) { return waveBreakpoints(this.wave, tstop, tstep); }
  report(x: Float64Array): DevReport {
    const v = V(x, this.p) - V(x, this.m), i = x[this.j];
    // SPICE sign: positive branch current flows into the + node, so a source delivering power has i < 0.
    return { i, p: -v * i, v };
  }
}

export class ISource extends Device {
  dcOverride: number | null = null;
  private last = 0;
  constructor(name: string, readonly p: number, readonly m: number, public wave: Waveform) { super(name); }
  load(ctx: Ctx) {
    const t = ctx.mode === 'tran' ? ctx.time : 0;
    const i = (this.dcOverride ?? waveAt(this.wave, t, ctx.tstep, ctx.tstop)) * ctx.srcFact;
    this.last = i;
    stampI(ctx.b, this.p, this.m, i);
  }
  breakpoints(tstop: number, tstep: number) { return waveBreakpoints(this.wave, tstop, tstep); }
  report(x: Float64Array): DevReport {
    const v = V(x, this.p) - V(x, this.m);
    return { i: this.last, p: -v * this.last, v };
  }
}

export class VCVS extends Device {
  constructor(name: string, readonly p: number, readonly m: number, readonly cp: number, readonly cm: number, readonly j: number, readonly gain: number) { super(name); }
  load(ctx: Ctx) {
    stampBranch(ctx.A, this.p, this.m, this.j);
    ctx.A.add(this.j, this.cp, -this.gain);
    ctx.A.add(this.j, this.cm, this.gain);
  }
  report(x: Float64Array): DevReport {
    const v = V(x, this.p) - V(x, this.m), i = x[this.j];
    return { i, p: -v * i, v };
  }
}

export class VCCS extends Device {
  constructor(name: string, readonly p: number, readonly m: number, readonly cp: number, readonly cm: number, readonly gm: number) { super(name); }
  load(ctx: Ctx) {
    const { A } = ctx, g = this.gm;
    A.add(this.p, this.cp, g); A.add(this.p, this.cm, -g);
    A.add(this.m, this.cp, -g); A.add(this.m, this.cm, g);
  }
  report(x: Float64Array): DevReport {
    const i = this.gm * (V(x, this.cp) - V(x, this.cm));
    const v = V(x, this.p) - V(x, this.m);
    return { i, p: v * i, v };
  }
}

// ---------- junction helpers (SPICE3 DEVpnjlim / DEVfetlim / DEVlimvds) ----------

function pnjlim(vnew: number, vold: number, vt: number, vcrit: number): [number, boolean] {
  if (vnew > vcrit && Math.abs(vnew - vold) > 2 * vt) {
    if (vold > 0) {
      const arg = 1 + (vnew - vold) / vt;
      vnew = arg > 0 ? vold + vt * Math.log(arg) : vcrit;
    } else {
      vnew = vt * Math.log(vnew / vt);
    }
    return [vnew, true];
  }
  return [vnew, false];
}

function fetlim(vnew: number, vold: number, vto: number): number {
  const vtsthi = Math.abs(2 * (vold - vto)) + 2;
  const vtstlo = vtsthi / 2;
  const vtox = vto + 3.5;
  const delv = vnew - vold;
  if (vold >= vto) {
    if (vold >= vtox) {
      if (delv <= 0) {
        if (vnew >= vtox) { if (-delv > vtstlo) vnew = vold - vtstlo; }
        else vnew = Math.max(vnew, vto + 2);
      } else if (delv >= vtsthi) vnew = vold + vtsthi;
    } else if (delv <= 0) vnew = Math.max(vnew, vto - 0.5);
    else vnew = Math.min(vnew, vto + 4);
  } else if (delv <= 0) {
    if (-delv > vtsthi) vnew = vold - vtsthi;
  } else {
    const vtemp = vto + 0.5;
    if (vnew <= vtemp) { if (delv > vtstlo) vnew = vold + vtstlo; }
    else vnew = vtemp;
  }
  return vnew;
}

function limvds(vnew: number, vold: number): number {
  if (vold >= 3.5) {
    if (vnew > vold) vnew = Math.min(vnew, 3 * vold + 2);
    else if (vnew < 3.5) vnew = Math.max(vnew, 2);
  } else if (vnew > vold) vnew = Math.min(vnew, 4);
  else vnew = Math.max(vnew, -0.5);
  return vnew;
}

/** exp() with linear continuation beyond EXP_MAX to avoid overflow. Returns [value, derivative]. */
function safeExp(u: number): [number, number] {
  if (u <= EXP_MAX) { const e = Math.exp(u); return [e, e]; }
  const e = Math.exp(EXP_MAX);
  return [e * (1 + u - EXP_MAX), e];
}

/** Stamps a linearised nonlinear terminal current I leaving `row`: I ≈ i0 + Σ g·(V(p) − V(m) − v0). */
function stampNL(ctx: Ctx, row: number, i0: number, terms: [number, number, number, number][]) {
  if (row < 0) return;
  let ieq = i0;
  for (const [g, p, m, v0] of terms) {
    ctx.A.add(row, p, g);
    ctx.A.add(row, m, -g);
    ieq -= g * v0;
  }
  ctx.b[row] -= ieq;
}

// ---------- diode ----------

export interface DiodeParams { IS: number; N: number; RS: number; BV: number; IBV: number; CJO: number }

export function diodeParams(p: Record<string, number>): DiodeParams {
  return {
    IS: p.is ?? 1e-14, N: p.n ?? 1, RS: p.rs ?? 0,
    BV: p.bv !== undefined && p.bv > 0 ? p.bv : Infinity, IBV: p.ibv ?? 1e-3, CJO: p.cjo ?? 0,
  };
}

export class Diode extends Device {
  private vdOld = 0;
  private cap: Capacitor | null = null;
  readonly nvt: number;
  readonly vcrit: number;
  constructor(name: string, readonly a: number, readonly ai: number, readonly k: number, readonly P: DiodeParams, readonly area = 1) {
    super(name);
    this.nvt = P.N * VT_300K;
    this.vcrit = this.nvt * Math.log(this.nvt / (Math.SQRT2 * P.IS * area));
    if (P.CJO > 0) this.cap = new Capacitor(name + '#cj', ai, k, P.CJO * area);
  }
  private iv(vd: number): [number, number] {
    const { IS, BV, IBV } = this.P, is = IS * this.area, nvt = this.nvt;
    const [e, de] = safeExp(vd / nvt);
    let id = is * (e - 1), gd = (is * de) / nvt;
    if (isFinite(BV)) {
      const [eb, deb] = safeExp(-(vd + BV) / nvt);
      id -= IBV * this.area * eb;
      gd += (IBV * this.area * deb) / nvt;
    }
    return [id, gd];
  }
  load(ctx: Ctx) {
    const { x } = ctx;
    if (this.ai !== this.a) stampG(ctx.A, this.a, this.ai, 1 / this.P.RS);
    let vd = V(x, this.ai) - V(x, this.k);
    let lim = false;
    if (isFinite(this.P.BV) && vd < Math.min(0, -this.P.BV + 10 * this.nvt)) {
      // limit in breakdown on the mirrored junction voltage
      let vr = -(vd + this.P.BV);
      [vr, lim] = pnjlim(vr, -(this.vdOld + this.P.BV), this.nvt, this.vcrit);
      vd = -(vr + this.P.BV);
    } else {
      [vd, lim] = pnjlim(vd, this.vdOld, this.nvt, this.vcrit);
    }
    if (lim) ctx.noncon = true;
    this.vdOld = vd;
    let [id, gd] = this.iv(vd);
    gd += ctx.gmin; id += ctx.gmin * vd;
    stampNL(ctx, this.ai, id, [[gd, this.ai, this.k, vd]]);
    stampNL(ctx, this.k, -id, [[-gd, this.ai, this.k, vd]]);
    this.cap?.load(ctx);
  }
  initTran(ctx: Ctx, uic: boolean) { this.cap?.initTran(ctx, uic); }
  accept(ctx: Ctx) { this.cap?.accept(ctx); }
  report(x: Float64Array): DevReport {
    const vd = V(x, this.ai) - V(x, this.k);
    const [id] = this.iv(vd);
    const v = V(x, this.a) - V(x, this.k);
    return { i: id, p: v * id, v };
  }
}

// ---------- MOSFET (Shichman–Hodges level 1, no body effect) ----------

export interface MosParams { VTO: number; KP: number; LAMBDA: number; W: number; L: number }

export function mosParams(p: Record<string, number>, w?: number, l?: number): MosParams {
  return { VTO: p.vto ?? 0, KP: p.kp ?? 2e-5, LAMBDA: p.lambda ?? 0, W: w ?? p.w ?? 1, L: l ?? p.l ?? 1 };
}

export class Mosfet extends Device {
  private vgsOld = 0;
  private vdsOld = 0;
  private readonly sign: number;
  private readonly beta: number;
  private readonly vto: number;
  constructor(name: string, readonly d: number, readonly g: number, readonly s: number, pmos: boolean, readonly P: MosParams) {
    super(name);
    this.sign = pmos ? -1 : 1;
    this.beta = (P.KP * P.W) / P.L;
    this.vto = this.sign * P.VTO;
  }
  private ids(vgs: number, vds: number): [number, number, number] {
    const vgst = vgs - this.vto, b = this.beta, lam = this.P.LAMBDA;
    if (vgst <= 0) return [0, 0, 0];
    const cl = 1 + lam * vds;
    if (vds < vgst) {
      return [b * vds * (vgst - vds / 2) * cl, b * vds * cl, b * (vgst - vds) * cl + b * lam * vds * (vgst - vds / 2)];
    }
    return [(b / 2) * vgst * vgst * cl, b * vgst * cl, (lam * b / 2) * vgst * vgst];
  }
  private evalAt(x: Float64Array) {
    const sg = this.sign;
    const vgs = sg * (V(x, this.g) - V(x, this.s));
    const vds = sg * (V(x, this.d) - V(x, this.s));
    return { vgs, vds };
  }
  load(ctx: Ctx) {
    const sg = this.sign;
    let { vgs, vds } = this.evalAt(ctx.x);
    let vgd = vgs - vds;
    const vgdOld = this.vgsOld - this.vdsOld;
    const vgs0 = vgs, vds0 = vds;
    if (this.vdsOld >= 0) {
      vgs = fetlim(vgs, this.vgsOld, this.vto);
      vds = vgs - vgd;
      vds = limvds(vds, this.vdsOld);
      vgd = vgs - vds;
    } else {
      vgd = fetlim(vgd, vgdOld, this.vto);
      vds = vgs - vgd;
      vds = -limvds(-vds, -this.vdsOld);
      vgs = vgd + vds;
    }
    if (Math.abs(vgs - vgs0) > 1e-9 || Math.abs(vds - vds0) > 1e-9) ctx.noncon = true;
    this.vgsOld = vgs; this.vdsOld = vds;

    // Effective drain/source in normal (vds ≥ 0) or reversed mode.
    const rev = vds < 0;
    const dE = rev ? this.s : this.d, sE = rev ? this.d : this.s;
    const vgsE = rev ? vgd : vgs, vdsE = rev ? -vds : vds;
    const [id, gm, gds0] = this.ids(vgsE, vdsE);
    const gds = gds0 + ctx.gmin;
    const iReal = sg * id + ctx.gmin * sg * vdsE; // current dE → sE
    const terms: [number, number, number, number][] = [
      [gm, this.g, sE, sg * vgsE],
      [gds, dE, sE, sg * vdsE],
    ];
    stampNL(ctx, dE, iReal, terms);
    stampNL(ctx, sE, -iReal, terms.map(([g, p, m, v0]) => [-g, p, m, v0] as [number, number, number, number]));
  }
  report(x: Float64Array): DevReport {
    const { vgs, vds } = this.evalAt(x);
    const rev = vds < 0;
    const [id] = this.ids(rev ? vgs - vds : vgs, rev ? -vds : vds);
    const i = this.sign * (rev ? -id : id); // real current into drain
    const v = V(x, this.d) - V(x, this.s);
    return { i, p: v * i, v, extra: { vgs: this.sign * vgs, vds: this.sign * vds } };
  }
}

// ---------- BJT (Ebers–Moll transport model with Early effect) ----------

export interface BjtParams { IS: number; BF: number; BR: number; NF: number; NR: number; VAF: number }

export function bjtParams(p: Record<string, number>): BjtParams {
  return { IS: p.is ?? 1e-16, BF: p.bf ?? 100, BR: p.br ?? 1, NF: p.nf ?? 1, NR: p.nr ?? 1, VAF: p.vaf && p.vaf > 0 ? p.vaf : Infinity };
}

export class Bjt extends Device {
  private vbeOld = 0;
  private vbcOld = 0;
  private readonly sign: number;
  constructor(name: string, readonly c: number, readonly bN: number, readonly e: number, pnp: boolean, readonly P: BjtParams, readonly area = 1) {
    super(name);
    this.sign = pnp ? -1 : 1;
  }
  private model(vbe: number, vbc: number) {
    const { IS, BF, BR, NF, NR, VAF } = this.P;
    const is = IS * this.area, vtf = NF * VT_300K, vtr = NR * VT_300K;
    const [ef, def] = safeExp(vbe / vtf), [er, der] = safeExp(vbc / vtr);
    const If = is * (ef - 1), gif = (is * def) / vtf;
    const Ir = is * (er - 1), gir = (is * der) / vtr;
    const k = isFinite(VAF) ? Math.max(0.01, 1 - vbc / VAF) : 1;
    const dk = isFinite(VAF) && 1 - vbc / VAF > 0.01 ? -1 / VAF : 0;
    const ic = (If - Ir) * k - Ir / BR;
    const ib = If / BF + Ir / BR;
    return {
      ic, ib,
      dic_dvbe: gif * k, dic_dvbc: -gir * k + (If - Ir) * dk - gir / BR,
      dib_dvbe: gif / BF, dib_dvbc: gir / BR,
    };
  }
  load(ctx: Ctx) {
    const sg = this.sign, x = ctx.x;
    let vbe = sg * (V(x, this.bN) - V(x, this.e));
    let vbc = sg * (V(x, this.bN) - V(x, this.c));
    const vtf = this.P.NF * VT_300K, vtr = this.P.NR * VT_300K;
    const vcritF = vtf * Math.log(vtf / (Math.SQRT2 * this.P.IS * this.area));
    const vcritR = vtr * Math.log(vtr / (Math.SQRT2 * this.P.IS * this.area));
    let l1: boolean, l2: boolean;
    [vbe, l1] = pnjlim(vbe, this.vbeOld, vtf, vcritF);
    [vbc, l2] = pnjlim(vbc, this.vbcOld, vtr, vcritR);
    if (l1 || l2) ctx.noncon = true;
    this.vbeOld = vbe; this.vbcOld = vbc;
    const m = this.model(vbe, vbc);
    const g = ctx.gmin;
    const ic = sg * m.ic - g * sg * vbc, ib = sg * m.ib + g * sg * (vbe + vbc);
    const a = m.dic_dvbe, bc = m.dic_dvbc - g, pbe = m.dib_dvbe + g, pbc = m.dib_dvbc + g;
    const VBE = sg * vbe, VBC = sg * vbc;
    // collector current (into C terminal = leaving node C)
    stampNL(ctx, this.c, ic, [[a, this.bN, this.e, VBE], [bc, this.bN, this.c, VBC]]);
    stampNL(ctx, this.bN, ib, [[pbe, this.bN, this.e, VBE], [pbc, this.bN, this.c, VBC]]);
    stampNL(ctx, this.e, -(ic + ib), [[-(a + pbe), this.bN, this.e, VBE], [-(bc + pbc), this.bN, this.c, VBC]]);
  }
  report(x: Float64Array): DevReport {
    const sg = this.sign;
    const vbe = sg * (V(x, this.bN) - V(x, this.e)), vbc = sg * (V(x, this.bN) - V(x, this.c));
    const m = this.model(vbe, vbc);
    const ic = sg * m.ic, ib = sg * m.ib;
    const vce = V(x, this.c) - V(x, this.e);
    return { i: ic, p: vce * ic + (V(x, this.bN) - V(x, this.e)) * ib, v: vce, extra: { ib, vbe: sg * vbe } };
  }
}

// ---------- voltage-controlled switch (ngspice SW model, with hysteresis) ----------

export interface SwParams { VT: number; VH: number; RON: number; ROFF: number }
export function swParams(p: Record<string, number>): SwParams {
  return { VT: p.vt ?? 0, VH: p.vh ?? 0, RON: p.ron ?? 1, ROFF: p.roff ?? 1e12 };
}

export class Switch extends Device {
  private accepted: boolean;
  private state: boolean;
  constructor(name: string, readonly p: number, readonly m: number, readonly cp: number, readonly cm: number, readonly P: SwParams, on = false) {
    super(name);
    this.accepted = this.state = on;
  }
  private decide(x: Float64Array): boolean {
    const vc = V(x, this.cp) - V(x, this.cm);
    if (vc > this.P.VT + this.P.VH) return true;
    if (vc < this.P.VT - this.P.VH) return false;
    return this.accepted;
  }
  load(ctx: Ctx) {
    const s = this.decide(ctx.x);
    if (s !== this.state) { this.state = s; ctx.noncon = true; }
    stampG(ctx.A, this.p, this.m, 1 / (this.state ? this.P.RON : this.P.ROFF));
  }
  accept(ctx: Ctx) { this.accepted = this.state = this.decide(ctx.x); }
  report(x: Float64Array): DevReport {
    const v = V(x, this.p) - V(x, this.m), i = v / (this.state ? this.P.RON : this.P.ROFF);
    return { i, p: v * i, v, extra: { on: this.state ? 1 : 0 } };
  }
}

// ---------- behavioral source (B element) ----------

export class BSource extends Device {
  private last = 0;
  constructor(name: string, readonly p: number, readonly m: number, readonly j: number, readonly mode: 'V' | 'I', readonly f: CompiledExpr) { super(name); }
  load(ctx: Ctx) {
    const t = ctx.mode === 'tran' ? ctx.time : 0;
    const { v, d } = this.f.eval(ctx.x, t);
    const val = v * (this.mode === 'V' ? ctx.srcFact : 1);
    let lin = val;
    for (let k = 0; k < d.length; k++) lin -= d[k] * ctx.x[this.f.vars[k]];
    this.last = val;
    if (this.mode === 'V') {
      stampBranch(ctx.A, this.p, this.m, this.j);
      for (let k = 0; k < d.length; k++) ctx.A.add(this.j, this.f.vars[k], -d[k]);
      ctx.b[this.j] += lin;
    } else {
      for (let k = 0; k < d.length; k++) {
        ctx.A.add(this.p, this.f.vars[k], d[k]);
        ctx.A.add(this.m, this.f.vars[k], -d[k]);
      }
      stampI(ctx.b, this.p, this.m, lin);
    }
  }
  report(x: Float64Array): DevReport {
    const v = V(x, this.p) - V(x, this.m);
    const i = this.mode === 'V' ? x[this.j] : this.last;
    return { i, p: this.mode === 'V' ? -v * i : v * i, v };
  }
}
