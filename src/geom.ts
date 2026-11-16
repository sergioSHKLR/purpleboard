import earcut from 'earcut';
import type { V2 } from './types';

export const DEG = Math.PI / 180;
export type BB = [number, number, number, number];
export type V3 = [number, number, number];

/** A convex point set (1 = disc, 2 = capsule, >=3 = polygon) inflated by radius r. */
export interface Shape { pts: V2[]; r: number; bb: BB }

export function rot(p: V2, deg: number): V2 {
  if (!deg) return [p[0], p[1]];
  const a = deg * DEG, c = Math.cos(a), s = Math.sin(a);
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
}
export const add = (a: V2, b: V2): V2 => [a[0] + b[0], a[1] + b[1]];
export const sub = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
export const dist = (a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function makeShape(pts: V2[], r: number): Shape {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  return { pts, r, bb: [x0 - r, y0 - r, x1 + r, y1 + r] };
}

export function segParam(p: V2, a: V2, b: V2): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 <= 0) return 0;
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export function pointSegDist(p: V2, a: V2, b: V2): number {
  const t = segParam(p, a, b);
  return Math.hypot(p[0] - a[0] - t * (b[0] - a[0]), p[1] - a[1] - t * (b[1] - a[1]));
}

function orient(a: V2, b: V2, c: V2) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

export function segSegDist(a: V2, b: V2, c: V2, d: V2): number {
  const d1 = orient(c, d, a), d2 = orient(c, d, b), d3 = orient(a, b, c), d4 = orient(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(pointSegDist(a, c, d), pointSegDist(b, c, d), pointSegDist(c, a, b), pointSegDist(d, a, b));
}

export function pointInConvex(p: V2, poly: V2[]): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const o = orient(poly[i], poly[(i + 1) % poly.length], p);
    if (o === 0) continue;
    const s = o > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

const edgeCount = (n: number) => (n <= 2 ? 1 : n);

/** Distance between the convex hulls of two point sets (0 when they overlap). */
export function hullDist(A: V2[], B: V2[]): number {
  if (A.length >= 3 && pointInConvex(B[0], A)) return 0;
  if (B.length >= 3 && pointInConvex(A[0], B)) return 0;
  const na = edgeCount(A.length), nb = edgeCount(B.length);
  let m = Infinity;
  for (let i = 0; i < na; i++) {
    const a0 = A[i], a1 = A[(i + 1) % A.length];
    for (let j = 0; j < nb; j++) {
      const d = segSegDist(a0, a1, B[j], B[(j + 1) % B.length]);
      if (d < m) { m = d; if (m === 0) return 0; }
    }
  }
  return m;
}

export const shapeGap = (A: Shape, B: Shape) => hullDist(A.pts, B.pts) - A.r - B.r;

/** Signed-ish distance from a point to the shape surface (<= 0 means inside). */
export function shapePointDist(S: Shape, p: V2): number {
  if (S.pts.length >= 3 && pointInConvex(p, S.pts)) return -S.r;
  const n = edgeCount(S.pts.length);
  let m = Infinity;
  for (let i = 0; i < n; i++) {
    const d = pointSegDist(p, S.pts[i], S.pts[(i + 1) % S.pts.length]);
    if (d < m) m = d;
  }
  return m - S.r;
}

export function pointInPolygon(p: V2, poly: V2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polyBB(poly: V2[]): BB {
  return makeShape(poly, 0).bb;
}

/** Uniform spatial hash for broad-phase queries. */
export class Grid {
  readonly x0: number;
  readonly y0: number;
  readonly cs: number;
  readonly nx: number;
  readonly ny: number;
  private cells: (number[] | undefined)[];
  private stamp: Uint32Array;
  private cur = 0;

  constructor(bb: BB, cell: number, capacity: number) {
    const w = Math.max(bb[2] - bb[0], 1e-3), h = Math.max(bb[3] - bb[1], 1e-3);
    this.cs = Math.max(cell, w / 512, h / 512);
    this.x0 = bb[0];
    this.y0 = bb[1];
    this.nx = Math.max(1, Math.ceil(w / this.cs));
    this.ny = Math.max(1, Math.ceil(h / this.cs));
    this.cells = new Array(this.nx * this.ny);
    this.stamp = new Uint32Array(Math.max(1, capacity));
  }

  private ix(x: number) { return Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.x0) / this.cs))); }
  private iy(y: number) { return Math.min(this.ny - 1, Math.max(0, Math.floor((y - this.y0) / this.cs))); }

  insert(id: number, bb: BB) {
    const i0 = this.ix(bb[0]), i1 = this.ix(bb[2]), j0 = this.iy(bb[1]), j1 = this.iy(bb[3]);
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const k = j * this.nx + i;
        (this.cells[k] ??= []).push(id);
      }
  }

  query(bb: BB, out: number[]): number[] {
    out.length = 0;
    const s = ++this.cur;
    const i0 = this.ix(bb[0]), i1 = this.ix(bb[2]), j0 = this.iy(bb[1]), j1 = this.iy(bb[3]);
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const c = this.cells[j * this.nx + i];
        if (!c) continue;
        for (const id of c) if (this.stamp[id] !== s) { this.stamp[id] = s; out.push(id); }
      }
    return out;
  }
}

/**
 * Triangulation of a polygon (earcut: fast, and robust to the zero-width slits KiCad uses to
 * join holes in copper-pour fills). Returns vertex index triples, each counter-clockwise.
 */
export function triangulate(poly: V2[]): number[] {
  const n = poly.length;
  if (n < 3) return [];
  const flat = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) { flat[2 * i] = poly[i][0]; flat[2 * i + 1] = poly[i][1]; }
  const out = earcut(flat);
  for (let i = 0; i + 2 < out.length; i += 3) {
    if (orient(poly[out[i]], poly[out[i + 1]], poly[out[i + 2]]) < 0) { const t = out[i + 1]; out[i + 1] = out[i + 2]; out[i + 2] = t; }
  }
  return out;
}

// ---- 4x4 matrices (column-major, WebGPU clip-space z in [0,1]) ----

export type M4 = Float32Array;

export function m4mul(a: M4, b: M4): M4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  return o;
}

export function perspective(fovy: number, aspect: number, near: number, far: number): M4 {
  const f = 1 / Math.tan(fovy / 2), o = new Float32Array(16);
  o[0] = f / aspect; o[5] = f; o[10] = far / (near - far); o[11] = -1; o[14] = (near * far) / (near - far);
  return o;
}

export function ortho(l: number, r: number, b: number, t: number, n: number, f: number): M4 {
  const o = new Float32Array(16);
  o[0] = 2 / (r - l); o[5] = 2 / (t - b); o[10] = 1 / (n - f);
  o[12] = -(r + l) / (r - l); o[13] = -(t + b) / (t - b); o[14] = n / (n - f); o[15] = 1;
  return o;
}

const norm3 = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function lookAt(eye: V3, target: V3, up: V3): M4 {
  const z = norm3([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const x = norm3(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
    -dot3(x, eye), -dot3(y, eye), -dot3(z, eye), 1,
  ]);
}

export function invert(m: M4): M4 {
  const inv = new Float32Array(16);
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return inv;
  det = 1 / det;
  inv[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  inv[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  inv[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  inv[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  inv[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  inv[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  inv[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  inv[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  inv[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  inv[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  inv[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  inv[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  inv[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  inv[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  inv[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  inv[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return inv;
}

export function transform4(m: M4, x: number, y: number, z: number, w: number): [number, number, number, number] {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12] * w,
    m[1] * x + m[5] * y + m[9] * z + m[13] * w,
    m[2] * x + m[6] * y + m[10] * z + m[14] * w,
    m[3] * x + m[7] * y + m[11] * z + m[15] * w,
  ];
}
