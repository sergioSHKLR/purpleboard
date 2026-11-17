// Board thermal model: 2D finite-volume plate + lumped part bodies.
//
//   plate cell   C = ρc·t·dx²        lateral G = k_inplane·t     convection G = 2·h·dx²
//   part body    C = ρc_body·volume  to board  G = h_joint·footprint area   to air G = h·top area
//
// Heat sources are SPICE dissipations per part. Freeze spray deposits frost that pins a cell at
// 0 °C until its latent heat is paid; isopropyl evaporates at a vapour-pressure-driven rate,
// so on a powered board both reveal the hot spot exactly as on the bench.
// Constants are typical handbook values (estimates), kept here as data.
import type { Board, Component } from './types';

export interface ThermalConstants {
  /** Volumetric heat capacity of the laminate+copper stack (J/m³K). */
  rhoCBoard: number;
  /** Effective in-plane conductivity of a multilayer board with planes (W/mK). */
  kInPlane: number;
  /** Combined natural convection + radiation per face (W/m²K). */
  hAir: number;
  /** Solder-joint / pad spreading conductance per footprint area (W/m²K). */
  hJoint: number;
  /** Volumetric heat capacity of part bodies (ceramic/epoxy) (J/m³K). */
  rhoCPart: number;
  ambient: number;
}

export const THERMAL_DEFAULTS: ThermalConstants = {
  // hJoint: 0402 part ≈ 150 K/W to the board (datasheet range ~100–200 K/W for this size)
  rhoCBoard: 2.0e6, kInPlane: 35, hAir: 12, hJoint: 11000, rhoCPart: 2.5e6, ambient: 25,
};

const ICE_LATENT = 3.34e5 * 917; // J per m³ of frost
const IPA_LATENT = 6.7e5 * 786;  // J per m³ of liquid IPA

interface PartNode { c: Component; cells: number[]; C: number; Gb: number; Ga: number; T: number; P: number; area: number; frost: number; ipa: number; rosin: number; rosinMelt: number }

/**
 * Rosin method: a thin white rosin film (condensed vapour) melts clear on a part warmer than
 * its softening point — the hottest part on a powered, shorted rail clears first. Typical
 * gum-rosin softening ~60–70 °C; the melting rate is an estimate.
 */
export const ROSIN_SOFTEN = 60;

/**
 * Thermal-camera emissivity by surface (typical handbook values). Shiny metal emits little and
 * mostly reflects the cooler room, so a hot pad or solder joint reads far colder than it is.
 */
export const EMISSIVITY = { mask: 0.9, package: 0.9, via: 0.6, metal: 0.1, shell: 0.3 } as const;

/** Temperature an IR camera calibrated for ε = 1 reads off a surface (grey-body, °C). */
export function apparentTemp(tC: number, eps: number, ambientC = 25): number {
  const K = 273.15, t = tC + K, a = ambientC + K;
  return Math.pow(eps * t ** 4 + (1 - eps) * a ** 4, 0.25) - K;
}
const ROSIN_MELT_RATE = 1 / 15; // fraction per second per kelvin above softening

/** External heat sources used for rework. */
export type HeatSource =
  /** Soldering iron: tip at `temp`, conductance `g` (W/K, wetting-dependent), power limit `pmax`. */
  | { kind: 'iron'; x: number; y: number; temp: number; g: number; pmax: number; until: number; partId?: string }
  /** Hot-air nozzle: air at `temp`, forced-convection coefficient `h` (W/m²K) over radius `r`. */
  | { kind: 'hotair'; x: number; y: number; r: number; temp: number; h: number; until: number }
  /** Bottom preheater: heats the whole board from below with coefficient `h` toward `temp`. */
  | { kind: 'preheat'; temp: number; h: number; until: number };

export class ThermalModel {
  readonly nx: number;
  readonly ny: number;
  readonly dx: number; // m
  readonly T: Float64Array;
  /** Frost / IPA film thickness per cell (m). */
  readonly frost: Float64Array;
  readonly ipa: Float64Array;
  private readonly Ccell: number;
  private readonly Glat: number;
  private readonly Gair: number;
  private readonly parts: PartNode[] = [];
  private readonly byId = new Map<string, PartNode>();
  /** Extra conductance (W/K) from a cell into the copper planes (pads on plane nets). */
  private readonly planeG: Float64Array;
  sources: HeatSource[] = [];
  /** Heat delivered by sources during the last step (W), for tool feedback. */
  sourcePower = 0;
  time = 0;

  constructor(readonly board: Board, readonly k: ThermalConstants = THERMAL_DEFAULTS, maxCells = 40000) {
    const area = board.w * board.h;
    const dxmm = Math.max(0.5, Math.sqrt(area / maxCells));
    this.dx = dxmm * 1e-3;
    this.nx = Math.max(2, Math.ceil(board.w / dxmm));
    this.ny = Math.max(2, Math.ceil(board.h / dxmm));
    const t = Math.max(0.4, board.thickness) * 1e-3;
    this.Ccell = k.rhoCBoard * t * this.dx * this.dx;
    this.Glat = k.kInPlane * t;
    this.Gair = 2 * k.hAir * this.dx * this.dx;
    const n = this.nx * this.ny;
    this.T = new Float64Array(n).fill(k.ambient);
    this.frost = new Float64Array(n);
    this.ipa = new Float64Array(n);
    this.planeG = new Float64Array(n);
    for (const c of board.components) this.addPart(c);
    this.markPlanes();
  }

  /**
   * Pads on plane nets (ground / big rails: nets with many pads) dump heat into the copper plane
   * through their vias — the reason a ground pad needs far more heat than a signal pad.
   */
  private markPlanes(gPerPad = 0.15) {
    const count = new Map<string, number>();
    for (const c of this.board.components) for (const p of c.pads) if (p.net) count.set(p.net, (count.get(p.net) ?? 0) + 1);
    for (const c of this.board.components) {
      const a = (c.rot * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a);
      for (const p of c.pads) {
        const nPads = p.net ? count.get(p.net) ?? 0 : 0;
        if (nPads < 40 && !/^(GND|VSS|PGND|AGND)/i.test(p.net ?? '')) continue;
        this.planeG[this.cellAt(c.at[0] + p.at[0] * cs - p.at[1] * sn, c.at[1] + p.at[0] * sn + p.at[1] * cs)] += gPerPad;
      }
    }
  }

  addSource(s: HeatSource) { this.sources.push(s); }

  private cellAt(xmm: number, ymm: number): number {
    const i = Math.min(this.nx - 1, Math.max(0, Math.floor(xmm / (this.dx * 1e3))));
    const j = Math.min(this.ny - 1, Math.max(0, Math.floor(ymm / (this.dx * 1e3))));
    return j * this.nx + i;
  }

  private addPart(c: Component) {
    if (!c.pads.length) return;
    const cells = new Set<number>();
    let padArea = 0;
    for (const p of c.pads) {
      const a = (c.rot * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a);
      cells.add(this.cellAt(c.at[0] + p.at[0] * cs - p.at[1] * sn, c.at[1] + p.at[0] * sn + p.at[1] * cs));
      padArea += p.size[0] * p.size[1] * 1e-6;
    }
    const w = Math.max(0.2, c.body.w), h = Math.max(0.2, c.body.h), z = Math.max(0.15, c.body.z);
    const vol = w * h * z * 1e-9;
    const node: PartNode = {
      c, cells: [...cells], C: this.k.rhoCPart * vol, Gb: this.k.hJoint * Math.max(padArea, 1e-8),
      Ga: this.k.hAir * w * h * 1e-6, T: this.k.ambient, P: 0, area: w * h * 1e-6, frost: 0, ipa: 0, rosin: 0, rosinMelt: 0,
    };
    this.parts.push(node);
    this.byId.set(c.id, node);
  }

  /** Sets dissipated power per component id (W). */
  setPower(p: Map<string, number>) {
    for (const n of this.parts) n.P = Math.max(0, p.get(n.c.id) ?? 0);
  }

  /** Advances the model by `dt` seconds (internally sub-stepped for stability). */
  step(dt: number) {
    if (!(dt > 0)) return; // dt = 0 (e.g. the first animation frame) would divide by zero
    const hmax = (0.9 * this.Ccell) / (4 * this.Glat + this.Gair);
    const nsub = Math.max(1, Math.ceil(dt / hmax));
    const h = dt / nsub;
    const { nx, ny, T, Ccell, Glat, Gair } = this;
    const amb = this.k.ambient;
    const q = new Float64Array(T.length);
    let planeT = 0;
    for (const v of T) planeT += v;
    planeT /= T.length;
    this.sources = this.sources.filter((src) => src.until > this.time);
    let srcP = 0;
    for (let s = 0; s < nsub; s++) {
      q.fill(0);
      // rework heat sources
      for (const src of this.sources) {
        if (src.until <= this.time) continue;
        if (src.kind === 'iron') {
          const k = this.cellAt(src.x, src.y);
          const node = src.partId ? this.byId.get(src.partId) : undefined;
          const tj = node ? 0.5 * (node.T + T[k]) : T[k];
          // never deliver more than brings the joint to tip temperature within this sub-step
          const cJoint = (node ? node.C : 0) + Ccell;
          const p = Math.max(0, Math.min(src.pmax, src.g * (src.temp - tj), (0.9 * cJoint * (src.temp - tj)) / h));
          // split by heat capacity so tip, part and pad approach the tip temperature together
          if (node) {
            const fn = node.C / cJoint;
            node.T = Math.min(src.temp, node.T + (fn * p * h) / node.C);
            q[k] += (1 - fn) * p;
          } else q[k] += p;
          srcP += p / nsub;
        } else if (src.kind === 'hotair') {
          this.disc(src.x, src.y, src.r, (k) => { const p = src.h * this.dx * this.dx * (src.temp - T[k]); q[k] += p; srcP += p / nsub; });
          for (const n of this.parts) {
            const [px, py] = n.c.at;
            if ((px - src.x) ** 2 + (py - src.y) ** 2 <= src.r * src.r) { const p = src.h * Math.max(1e-8, n.Ga / this.k.hAir) * (src.temp - n.T); n.T += (p * h) / n.C; srcP += p / nsub; }
          }
        } else {
          const g = src.h * this.dx * this.dx;
          for (let k = 0; k < T.length; k++) q[k] += g * (src.temp - T[k]);
        }
      }

      // parts: implicit local update, then their heat flows into the footprint cells
      for (const n of this.parts) {
        let tb = 0;
        for (const i of n.cells) tb += T[i];
        tb /= n.cells.length;
        let Tn = (n.C / h * n.T + n.P + n.Gb * tb + n.Ga * amb) / (n.C / h + n.Gb + n.Ga);
        // frost on the body pins it at 0 °C until the latent heat is paid by the part's own heat
        if (n.frost > 0 && Tn > 0) {
          const e = n.C * Tn, cap = n.frost * n.area * ICE_LATENT;
          if (e < cap) { n.frost -= e / (n.area * ICE_LATENT); Tn = 0; } else { n.frost = 0; Tn = (e - cap) / n.C; }
        }
        if (n.ipa > 0) {
          const d = Math.min(n.ipa, (2e-5 / 20) * Math.pow(2, (Tn - 25) / 13) * h);
          n.ipa -= d;
          Tn -= (d * n.area * IPA_LATENT) / n.C;
        }
        n.T = Tn;
        if (n.rosin > 0 && n.rosinMelt < 1 && Tn > ROSIN_SOFTEN) n.rosinMelt = Math.min(1, n.rosinMelt + ROSIN_MELT_RATE * (Tn - ROSIN_SOFTEN) * h);
        const flow = n.Gb * (Tn - tb) / n.cells.length;
        for (const i of n.cells) q[i] += flow;
      }
      // plate: explicit conduction + convection
      const Tn = new Float64Array(T.length);
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const k = j * nx + i, t0 = T[k];
          let f = q[k] - Gair * (t0 - amb);
          if (i > 0) f += Glat * (T[k - 1] - t0);
          if (i < nx - 1) f += Glat * (T[k + 1] - t0);
          if (j > 0) f += Glat * (T[k - nx] - t0);
          if (j < ny - 1) f += Glat * (T[k + nx] - t0);
          // plane sink treated implicitly (unconditionally stable for many stitched pads in one cell)
          const gp = this.planeG[k];
          let t1 = gp > 0 ? (t0 + (h * (f + gp * planeT)) / Ccell) / (1 + (h * gp) / Ccell) : t0 + (h * f) / Ccell;
          // freeze spray: frost pins the cell at 0 °C until its latent heat is supplied
          if (this.frost[k] > 0 && t1 > 0) {
            const e = Ccell * t1, cap = this.frost[k] * this.dx * this.dx * ICE_LATENT;
            if (e < cap) { this.frost[k] -= e / (this.dx * this.dx * ICE_LATENT); t1 = 0; }
            else { this.frost[k] = 0; t1 = (e - cap) / Ccell; }
          }
          // isopropyl: evaporation rate doubles every ~13 K (vapour pressure), cooling the cell
          if (this.ipa[k] > 0) {
            const rate = (2e-5 / 20) * Math.pow(2, (t1 - 25) / 13); // m/s: a 20 µm film lasts ~20 s at 25 °C
            const d = Math.min(this.ipa[k], rate * h);
            this.ipa[k] -= d;
            t1 -= (d * this.dx * this.dx * IPA_LATENT) / Ccell;
          }
          Tn[k] = t1;
        }
      }
      T.set(Tn);
      this.time += h;
    }
    this.sourcePower = srcP;
  }

  /** Board cell temperature under a pad, and the part body temperature. */
  jointTemp(c: Component, padIndex: number): number {
    const n = this.byId.get(c.id);
    const p = c.pads[padIndex];
    const a = (c.rot * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a);
    const cell = this.T[this.cellAt(c.at[0] + p.at[0] * cs - p.at[1] * sn, c.at[1] + p.at[0] * sn + p.at[1] * cs)];
    return n ? 0.5 * (n.T + cell) : cell;
  }

  /** Runs until the hottest change per second falls below `tol` K/s (or `maxTime` s). */
  settle(maxTime = 600, tol = 0.01): number {
    let last = this.maxTemp();
    for (let t = 0; t < maxTime; t += 1) {
      this.step(1);
      const m = this.maxTemp();
      if (Math.abs(m - last) < tol && t > 2) return t;
      last = m;
    }
    return maxTime;
  }

  partTemp(id: string): number | undefined { return this.byId.get(id)?.T; }
  tempAt(xmm: number, ymm: number): number { return this.T[this.cellAt(xmm, ymm)]; }
  maxTemp(): number {
    let m = -Infinity;
    for (const v of this.T) if (v > m) m = v;
    for (const n of this.parts) if (n.T > m) m = n.T;
    return m;
  }
  hottestPart(): { c: Component; T: number } | null {
    let best: PartNode | null = null;
    for (const n of this.parts) if (!best || n.T > best.T) best = n;
    return best ? { c: best.c, T: best.T } : null;
  }

  private disc(xmm: number, ymm: number, rmm: number, f: (k: number) => void) {
    const r2 = rmm * rmm, s = this.dx * 1e3;
    for (let j = Math.max(0, Math.floor((ymm - rmm) / s)); j <= Math.min(this.ny - 1, Math.ceil((ymm + rmm) / s)); j++)
      for (let i = Math.max(0, Math.floor((xmm - rmm) / s)); i <= Math.min(this.nx - 1, Math.ceil((xmm + rmm) / s)); i++) {
        const cx = (i + 0.5) * s - xmm, cy = (j + 0.5) * s - ymm;
        if (cx * cx + cy * cy <= r2) f(j * this.nx + i);
      }
  }

  /** Freeze spray: a frost layer (default 0.1 mm) and the sprayed area chilled to −40 °C. */
  /** Parts whose body rectangle intersects a disc. */
  private partsIn(xmm: number, ymm: number, rmm: number): PartNode[] {
    return this.parts.filter((n) => {
      const hw = Math.max(n.c.body.w, 0.2) / 2, hh = Math.max(n.c.body.h, 0.2) / 2;
      const a = (-n.c.rot * Math.PI) / 180, dx = xmm - n.c.at[0], dy = ymm - n.c.at[1];
      const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
      const qx = Math.max(Math.abs(lx) - hw, 0), qy = Math.max(Math.abs(ly) - hh, 0);
      return qx * qx + qy * qy <= rmm * rmm;
    });
  }

  freezeSpray(xmm: number, ymm: number, rmm = 8, thickness = 1e-4) {
    this.disc(xmm, ymm, rmm, (k) => { this.frost[k] += thickness; this.T[k] = Math.min(this.T[k], -40); });
    for (const n of this.partsIn(xmm, ymm, rmm)) { n.frost += thickness; n.T = Math.min(n.T, -40); }
  }

  /** Isopropyl alcohol: a liquid film (default 20 µm) over the area. */
  applyIpa(xmm: number, ymm: number, rmm = 10, thickness = 2e-5) {
    this.disc(xmm, ymm, rmm, (k) => { this.ipa[k] += thickness; });
    for (const n of this.partsIn(xmm, ymm, rmm)) n.ipa += thickness;
  }

  /** Rosin film over an area (rosin method). */
  applyRosin(xmm: number, ymm: number, rmm = 8) {
    for (const n of this.partsIn(xmm, ymm, rmm)) { n.rosin = 1; n.rosinMelt = 0; }
  }

  /** Surface state under a part for rendering: frost / wet film, rosin film (white) and melted rosin (clear). */
  partSurface(id: string): { frost: number; wet: number; rosin: number; melted: number } {
    const n = this.byId.get(id);
    if (!n) return { frost: 0, wet: 0, rosin: 0, melted: 0 };
    // what you see on a part is the coating on its body
    let f = n.frost / 1e-4, w = n.ipa / 2e-5;
    for (const i of n.cells) { f = Math.max(f, this.frost[i] / 1e-4); w = Math.max(w, this.ipa[i] / 2e-5); }
    return { frost: Math.min(1, f), wet: Math.min(1, w), rosin: n.rosin * (1 - n.rosinMelt), melted: n.rosin * n.rosinMelt };
  }

  /**
   * Board-surface coatings for rendering: every grid cell still carrying frost or an IPA film,
   * as its centre (mm), cell size (mm) and coverage 0..1. The film evaporates per cell at that
   * cell's temperature, so a hot spot dries out first and shows as a hole in the wet patch.
   */
  forEachFilm(cb: (xmm: number, ymm: number, sizeMm: number, frost: number, wet: number) => void) {
    const s = this.dx * 1e3;
    for (let k = 0; k < this.T.length; k++) {
      const f = this.frost[k], w = this.ipa[k];
      if (f < 2e-6 && w < 4e-7) continue;
      cb(((k % this.nx) + 0.5) * s, (Math.floor(k / this.nx) + 0.5) * s, s, Math.min(1, f / 1e-4), Math.min(1, w / 2e-5));
    }
  }

  reset() {
    this.T.fill(this.k.ambient); this.frost.fill(0); this.ipa.fill(0);
    for (const n of this.parts) { n.T = this.k.ambient; n.frost = 0; n.ipa = 0; n.rosin = 0; n.rosinMelt = 0; }
    this.time = 0;
  }
}
