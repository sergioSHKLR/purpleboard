import type { Component, ComponentKind, LedColor, Pad, V2 } from './types';
import { DEG, makeShape, rot, type Shape } from './geom';

/** Kinds with an electrical model in the simulator. */
export const MODELED: ReadonlySet<ComponentKind> = new Set<ComponentKind>([
  'resistor', 'capacitor', 'led', 'diode', 'battery', 'switch', 'fuse',
]);
/** Two-terminal parts whose pins are interchangeable. */
export const SYMMETRIC: ReadonlySet<ComponentKind> = new Set<ComponentKind>(['resistor', 'capacitor', 'fuse', 'switch']);
const POLAR: Partial<Record<ComponentKind, [string, string]>> = {
  led: ['A', 'K'], diode: ['A', 'K'], battery: ['+', '-'],
};

export function twoRoles(c: Component): [string, string] | null {
  const pr = POLAR[c.kind];
  if (pr && c.pins[pr[0]] !== undefined && c.pins[pr[1]] !== undefined) return pr;
  const k = Object.keys(c.pins);
  return k.length >= 2 ? [k[0], k[1]] : null;
}

/** Pad name that electrically carries `role`, taking a reversed (180°) seating into account. */
export function rolePadName(c: Component, role: string): string | undefined {
  const pr = twoRoles(c);
  if (c.state.reversed && pr && (role === pr[0] || role === pr[1])) return c.pins[role === pr[0] ? pr[1] : pr[0]];
  return c.pins[role];
}

export function padWorld(c: Component, p: Pad): { at: V2; rot: number } {
  const r = rot(p.at, c.rot);
  return { at: [c.at[0] + r[0], c.at[1] + r[1]], rot: c.rot + (p.rot ?? 0) };
}

export function padMask(p: Pad): number {
  return p.layers === 'FB' ? 3 : p.layers === 'F' ? 1 : 2;
}

export function padRadius(p: Pad): number {
  const m = Math.min(p.size[0], p.size[1]) / 2;
  return p.shape === 'circle' || p.shape === 'oval' ? m : p.shape === 'roundrect' ? m * 0.25 : 0;
}

export function padShape(c: Component, p: Pad): Shape {
  const { at, rot: r } = padWorld(c, p);
  const hx = p.size[0] / 2, hy = p.size[1] / 2;
  const a = r * DEG, cs = Math.cos(a), sn = Math.sin(a);
  const tr = (x: number, y: number): V2 => [at[0] + x * cs - y * sn, at[1] + x * sn + y * cs];
  switch (p.shape) {
    case 'circle':
      return makeShape([at], Math.min(hx, hy));
    case 'oval': {
      if (Math.abs(hx - hy) < 1e-6) return makeShape([at], hx);
      return hx > hy ? makeShape([tr(-(hx - hy), 0), tr(hx - hy, 0)], hy) : makeShape([tr(0, -(hy - hx)), tr(0, hy - hx)], hx);
    }
    default: {
      const rr = padRadius(p);
      const x = hx - rr, y = hy - rr;
      return makeShape([tr(-x, -y), tr(x, -y), tr(x, y), tr(-x, y)], rr);
    }
  }
}

export const LED_INFO: Record<LedColor, { vf: number; css: string; rgb: [number, number, number] }> = {
  red: { vf: 1.8, css: '#ff3b30', rgb: [1, 0.16, 0.12] },
  orange: { vf: 1.9, css: '#ff8a00', rgb: [1, 0.5, 0.05] },
  yellow: { vf: 2.0, css: '#ffd60a', rgb: [1, 0.85, 0.1] },
  green: { vf: 2.1, css: '#30d158', rgb: [0.15, 1, 0.3] },
  blue: { vf: 3.0, css: '#2f7dff', rgb: [0.2, 0.45, 1] },
  white: { vf: 3.0, css: '#f4f7ff', rgb: [0.95, 0.97, 1] },
};
export const LED_COLORS = Object.keys(LED_INFO) as LedColor[];

const trim = (v: number) => String(parseFloat(v.toPrecision(3)));

export function fmtSI(v: number, unit: string): string {
  const a = Math.abs(v);
  if (a === 0) return '0 ' + unit;
  if (a >= 1e6) return trim(v / 1e6) + ' M' + unit;
  if (a >= 1e3) return trim(v / 1e3) + ' k' + unit;
  if (a >= 1) return trim(v) + ' ' + unit;
  if (a >= 1e-3) return trim(v * 1e3) + ' m' + unit;
  if (a >= 1e-6) return trim(v * 1e6) + ' µ' + unit;
  if (a >= 1e-9) return trim(v * 1e9) + ' n' + unit;
  return trim(v * 1e12) + ' p' + unit;
}

export const fmtOhm = (v: number) => fmtSI(v, 'Ω').replace(' ', '');

/** Parses KiCad/EE style values: 4k7, 10K, 330R, 2.2uF, 1M, 500mA, 3V. */
export function parseValue(s: string): number {
  const m = s.trim().replace(',', '.').match(/^([0-9]*\.?[0-9]+)\s*([pnuµmkKMGR]?)([0-9]*)/);
  if (!m) return NaN;
  const mult: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, R: 1, '': 1 };
  let num = m[1];
  if (m[3] && m[2]) num = m[1] + '.' + m[3];
  return parseFloat(num) * (mult[m[2]] ?? 1);
}

export const E12 = [1, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2];
export function e12Values(min = 10, max = 1e6): number[] {
  const out: number[] = [];
  for (let dec = 1; dec <= 1e6; dec *= 10)
    for (const e of E12) {
      const v = Math.round(e * dec * 100) / 100;
      if (v >= min && v <= max) out.push(v);
    }
  return out;
}

export const BAND_RGB: [number, number, number][] = [
  [0.07, 0.07, 0.07], [0.45, 0.25, 0.1], [0.85, 0.1, 0.1], [1, 0.5, 0], [1, 0.85, 0],
  [0.1, 0.65, 0.2], [0.1, 0.25, 0.9], [0.5, 0.15, 0.8], [0.5, 0.5, 0.5], [0.95, 0.95, 0.95],
];
export const BAND_NAMES = ['black', 'brown', 'red', 'orange', 'yellow', 'green', 'blue', 'violet', 'grey', 'white'];
export const GOLD_RGB: [number, number, number] = [0.83, 0.66, 0.22];

/** 4-band code: [digit1, digit2, multiplierExp] — exp -1 = gold multiplier. */
export function resistorBands(v: number): [number, number, number] {
  if (!(v > 0)) return [0, 0, 0];
  let e = Math.floor(Math.log10(v)) - 1;
  let m = Math.round(v / Math.pow(10, e));
  if (m >= 100) { m = Math.round(m / 10); e++; }
  if (e < -1) e = -1;
  return [Math.floor(m / 10) % 10, m % 10, e];
}

export function bandText(v: number): string {
  const [a, b, e] = resistorBands(v);
  return `${BAND_NAMES[a]}-${BAND_NAMES[b]}-${e < 0 ? 'gold' : BAND_NAMES[e]}-gold`;
}

export const KIND_NAMES: Record<ComponentKind, string> = {
  resistor: 'Resistor', capacitor: 'Capacitor', led: 'LED', diode: 'Diode', battery: 'Power source',
  switch: 'Switch', fuse: 'Fuse', testpoint: 'Test point', ic: 'IC', connector: 'Connector', generic: 'Part',
};

export function marking(c: Component): string {
  if (!c.state.populated) return 'empty footprint';
  if (c.state.burnt) return c.kind === 'fuse' ? 'blackened glass — blown' : 'charred, unreadable';
  switch (c.kind) {
    case 'resistor': return `${fmtOhm(c.value)} (${bandText(c.value)})`;
    case 'capacitor': return fmtSI(c.value, 'F');
    case 'led': return `${c.color ?? 'red'} LED`;
    case 'battery': return `${c.label ? c.label + ' · ' : ''}${fmtSI(c.value, 'V')}`;
    case 'fuse': return `${fmtSI(c.value, 'A')} fuse`;
    case 'switch': return c.state.closed ? 'pressed / closed' : 'released / open';
    default: return c.label ?? c.footprint ?? '';
  }
}

export const batteryRint = (v: number) => (v <= 3.6 ? 8 : 0.2);
