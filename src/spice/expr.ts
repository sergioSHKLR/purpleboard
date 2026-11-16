// Behavioral-source expressions (ngspice B-source subset) with forward-mode automatic
// differentiation, so Newton gets exact Jacobian entries for nonlinear behavior.
//
// Syntax: numbers with SPICE suffixes, V(n), V(n1,n2), time, + - * / ^ (or **), unary −,
// comparisons < > <= >= == !=, && || !, ternary a ? b : c, and functions
// abs exp ln log log10 sqrt min max pow tanh sin cos atan u uramp limit.
import { parseSpiceNumber } from './units';

export type Expr =
  | { t: 'num'; v: number }
  | { t: 'v'; a: string; b?: string }
  | { t: 'time' }
  | { t: 'un'; op: '-' | '!'; x: Expr }
  | { t: 'bin'; op: string; a: Expr; b: Expr }
  | { t: 'tern'; c: Expr; a: Expr; b: Expr }
  | { t: 'fn'; name: string; args: Expr[] };

const FNS = new Set(['abs', 'exp', 'ln', 'log', 'log10', 'sqrt', 'min', 'max', 'pow', 'pwr', 'tanh', 'sin', 'cos', 'atan', 'u', 'uramp', 'limit']);

export class ExprError extends Error {}

export function parseExpr(src: string): Expr {
  let s = src.trim();
  if (s.startsWith('{') && s.endsWith('}')) s = s.slice(1, -1);
  let i = 0;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const peek = (str: string) => { ws(); return s.startsWith(str, i); };
  const eat = (str: string) => { if (peek(str)) { i += str.length; return true; } return false; };
  const expect = (str: string) => { if (!eat(str)) throw new ExprError(`expected "${str}" at ${i} in "${src}"`); };

  const primary = (): Expr => {
    ws();
    if (eat('(')) { const e = ternary(); expect(')'); return e; }
    const m = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?[a-zµ]*/i.exec(s.slice(i));
    if (m) { i += m[0].length; return { t: 'num', v: parseSpiceNumber(m[0]) }; }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
    if (!id) throw new ExprError(`unexpected "${s[i] ?? 'end'}" at ${i} in "${src}"`);
    i += id[0].length;
    const name = id[0].toLowerCase();
    if (name === 'time') return { t: 'time' };
    if (name === 'v' && peek('(')) {
      expect('(');
      const node = () => { ws(); const n = /^[^,()\s]+/.exec(s.slice(i)); if (!n) throw new ExprError(`bad node in "${src}"`); i += n[0].length; return n[0]; };
      const a = node();
      const b = eat(',') ? node() : undefined;
      expect(')');
      return { t: 'v', a, b };
    }
    if (FNS.has(name) && peek('(')) {
      expect('(');
      const args: Expr[] = [];
      if (!peek(')')) do args.push(ternary()); while (eat(','));
      expect(')');
      return { t: 'fn', name, args };
    }
    if (name === 'pi') return { t: 'num', v: Math.PI };
    throw new ExprError(`unknown identifier "${id[0]}" in "${src}"`);
  };
  const unary = (): Expr => {
    if (eat('-')) return { t: 'un', op: '-', x: unary() };
    if (eat('+')) return unary();
    if (peek('!') && !peek('!=')) { i++; return { t: 'un', op: '!', x: unary() }; }
    return power();
  };
  const power = (): Expr => {
    const a = primary();
    if (eat('**') || eat('^')) return { t: 'bin', op: '^', a, b: unary() };
    return a;
  };
  const level = (next: () => Expr, ops: string[]) => (): Expr => {
    let a = next();
    for (;;) {
      const op = ops.find((o) => peek(o) && !(o === '*' && peek('**')) && !(o.length === 1 && '<>!='.includes(o) && s[i + 1] === '='));
      if (!op) return a;
      i += op.length;
      a = { t: 'bin', op, a, b: next() };
    }
  };
  const mul = level(unary, ['*', '/']);
  const add = level(mul, ['+', '-']);
  const cmp = level(add, ['<=', '>=', '==', '!=', '<', '>']);
  const and = level(cmp, ['&&']);
  const or = level(and, ['||']);
  const ternary = (): Expr => {
    const c = or();
    if (eat('?')) { const a = ternary(); expect(':'); const b = ternary(); return { t: 'tern', c, a, b }; }
    return c;
  };
  const e = ternary();
  ws();
  if (i < s.length) throw new ExprError(`trailing "${s.slice(i)}" in "${src}"`);
  return e;
}

export function exprToString(e: Expr): string {
  switch (e.t) {
    case 'num': return String(e.v);
    case 'v': return e.b ? `V(${e.a},${e.b})` : `V(${e.a})`;
    case 'time': return 'time';
    case 'un': return `${e.op}(${exprToString(e.x)})`;
    case 'bin': return `(${exprToString(e.a)}${e.op === '^' ? '**' : e.op}${exprToString(e.b)})`;
    case 'tern': return `(${exprToString(e.c)} ? ${exprToString(e.a)} : ${exprToString(e.b)})`;
    case 'fn': return `${e.name}(${e.args.map(exprToString).join(',')})`;
  }
}

/** Node names referenced by an expression. */
export function exprNodes(e: Expr, out: string[] = []): string[] {
  switch (e.t) {
    case 'v': out.push(e.a); if (e.b) out.push(e.b); break;
    case 'un': exprNodes(e.x, out); break;
    case 'bin': exprNodes(e.a, out); exprNodes(e.b, out); break;
    case 'tern': exprNodes(e.c, out); exprNodes(e.a, out); exprNodes(e.b, out); break;
    case 'fn': for (const a of e.args) exprNodes(a, out); break;
  }
  return out;
}

/** Remaps node names (subcircuit flattening). */
export function mapExprNodes(e: Expr, f: (n: string) => string): Expr {
  switch (e.t) {
    case 'v': return { t: 'v', a: f(e.a), ...(e.b && { b: f(e.b) }) };
    case 'un': return { ...e, x: mapExprNodes(e.x, f) };
    case 'bin': return { ...e, a: mapExprNodes(e.a, f), b: mapExprNodes(e.b, f) };
    case 'tern': return { t: 'tern', c: mapExprNodes(e.c, f), a: mapExprNodes(e.a, f), b: mapExprNodes(e.b, f) };
    case 'fn': return { ...e, args: e.args.map((a) => mapExprNodes(a, f)) };
    default: return e;
  }
}

// ---------- compiled evaluation with dual numbers ----------

/** Value plus partial derivatives w.r.t. the expression's local variables. */
type Dual = { v: number; d: Float64Array };

export interface CompiledExpr {
  /** Distinct unknown indices the expression depends on (−1 = ground, excluded). */
  vars: number[];
  /** Evaluates value and ∂/∂x[vars[k]]. */
  eval(x: Float64Array, time: number): { v: number; d: Float64Array };
}

export function compileExpr(e: Expr, index: (node: string) => number): CompiledExpr {
  const vars: number[] = [];
  const slot = (n: string) => {
    const k = index(n);
    if (k < 0) return -1;
    let p = vars.indexOf(k);
    if (p < 0) { p = vars.length; vars.push(k); }
    return p;
  };
  // Pre-resolve V() leaves to slots.
  const resolve = (x: Expr): Expr & { sa?: number; sb?: number } => {
    switch (x.t) {
      case 'v': return { ...x, sa: slot(x.a), sb: x.b ? slot(x.b) : -1 };
      case 'un': return { ...x, x: resolve(x.x) };
      case 'bin': return { ...x, a: resolve(x.a), b: resolve(x.b) };
      case 'tern': return { t: 'tern', c: resolve(x.c), a: resolve(x.a), b: resolve(x.b) };
      case 'fn': return { ...x, args: x.args.map(resolve) };
      default: return x;
    }
  };
  const root = resolve(e);
  const n = () => vars.length;
  const constant = (v: number): Dual => ({ v, d: new Float64Array(n()) });
  const chain = (a: Dual, v: number, dv: number): Dual => {
    const d = new Float64Array(a.d.length);
    for (let k = 0; k < d.length; k++) d[k] = a.d[k] * dv;
    return { v, d };
  };
  const comb = (a: Dual, b: Dual, v: number, da: number, db: number): Dual => {
    const d = new Float64Array(a.d.length);
    for (let k = 0; k < d.length; k++) d[k] = a.d[k] * da + b.d[k] * db;
    return { v, d };
  };
  const bool = (b: boolean) => constant(b ? 1 : 0);

  const ev = (x: Expr & { sa?: number; sb?: number }, xv: Float64Array, time: number): Dual => {
    switch (x.t) {
      case 'num': return constant(x.v);
      case 'time': return constant(time);
      case 'v': {
        const r = constant(0);
        if (x.sa! >= 0) { r.v += xv[vars[x.sa!]]; r.d[x.sa!] += 1; }
        if (x.sb! >= 0) { r.v -= xv[vars[x.sb!]]; r.d[x.sb!] -= 1; }
        return r;
      }
      case 'un': {
        const a = ev(x.x, xv, time);
        return x.op === '-' ? chain(a, -a.v, -1) : bool(!a.v);
      }
      case 'tern': return ev(x.c, xv, time).v ? ev(x.a, xv, time) : ev(x.b, xv, time);
      case 'bin': {
        const a = ev(x.a, xv, time), b = ev(x.b, xv, time);
        switch (x.op) {
          case '+': return comb(a, b, a.v + b.v, 1, 1);
          case '-': return comb(a, b, a.v - b.v, 1, -1);
          case '*': return comb(a, b, a.v * b.v, b.v, a.v);
          case '/': { const bv = b.v === 0 ? 1e-30 : b.v; return comb(a, b, a.v / bv, 1 / bv, -a.v / (bv * bv)); }
          case '^': {
            const v = Math.pow(a.v, b.v);
            const da = a.v === 0 ? 0 : b.v * Math.pow(a.v, b.v - 1);
            const db = a.v > 0 ? v * Math.log(a.v) : 0;
            return comb(a, b, v, da, db);
          }
          case '<': return bool(a.v < b.v);
          case '>': return bool(a.v > b.v);
          case '<=': return bool(a.v <= b.v);
          case '>=': return bool(a.v >= b.v);
          case '==': return bool(a.v === b.v);
          case '!=': return bool(a.v !== b.v);
          case '&&': return bool(!!a.v && !!b.v);
          case '||': return bool(!!a.v || !!b.v);
        }
        throw new ExprError(`bad operator ${x.op}`);
      }
      case 'fn': {
        const A = x.args.map((y) => ev(y, xv, time));
        const a = A[0] ?? constant(0);
        switch (x.name) {
          case 'abs': return chain(a, Math.abs(a.v), a.v >= 0 ? 1 : -1);
          case 'exp': { const v = Math.exp(Math.min(a.v, 80)); return chain(a, v, a.v > 80 ? 0 : v); }
          case 'ln': case 'log': { const av = Math.max(a.v, 1e-30); return chain(a, Math.log(av), 1 / av); }
          case 'log10': { const av = Math.max(a.v, 1e-30); return chain(a, Math.log10(av), 1 / (av * Math.LN10)); }
          case 'sqrt': { const av = Math.max(a.v, 0); const v = Math.sqrt(av); return chain(a, v, v > 1e-15 ? 0.5 / v : 0); }
          case 'tanh': { const v = Math.tanh(a.v); return chain(a, v, 1 - v * v); }
          case 'sin': return chain(a, Math.sin(a.v), Math.cos(a.v));
          case 'cos': return chain(a, Math.cos(a.v), -Math.sin(a.v));
          case 'atan': return chain(a, Math.atan(a.v), 1 / (1 + a.v * a.v));
          case 'u': return constant(a.v > 0 ? 1 : 0);
          case 'uramp': return chain(a, Math.max(0, a.v), a.v > 0 ? 1 : 0);
          case 'min': return A.reduce((m, y) => (y.v < m.v ? y : m));
          case 'max': return A.reduce((m, y) => (y.v > m.v ? y : m));
          case 'pow': case 'pwr': {
            const b = A[1] ?? constant(1);
            const base = x.name === 'pwr' ? Math.abs(a.v) : a.v;
            const v = Math.pow(base, b.v) * (x.name === 'pwr' && a.v < 0 ? -1 : 1);
            const da = base === 0 ? 0 : b.v * Math.pow(base, b.v - 1);
            return comb(a, b, v, da, base > 0 ? v * Math.log(base) : 0);
          }
          case 'limit': {
            const lo = A[1] ?? constant(-Infinity), hi = A[2] ?? constant(Infinity);
            return a.v < lo.v ? lo : a.v > hi.v ? hi : a;
          }
        }
        throw new ExprError(`unknown function ${x.name}`);
      }
    }
  };
  return { vars, eval: (xv, time) => ev(root, xv, time) };
}
