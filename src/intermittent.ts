// Intermittent faults: conditions that switch a joint or a leak on and off with the board's
// physical environment. They act by toggling the ordinary fault state (cold pad, leak), so
// connectivity, both solvers, the meter and the renderer follow without special cases.
import type { Board, Component } from './types';

export type IntermittentKind =
  /** cracked joint / BGA ball: opens when the part is warm, recloses when it cools (hysteresis) */
  | 'thermal-open'
  /** degraded dielectric / ionic residue: conducts (leak) only when warm */
  | 'thermal-leak'
  /** cracked joint that opens while the board is flexed near it */
  | 'flex-open'
  /** joint that only makes contact while pressed (classic "press on the chip and it works") */
  | 'flex-close';

export interface IntermittentSpec {
  kind: IntermittentKind;
  /** Pad index for joint faults. */
  pad?: number;
  /** °C for thermal kinds, flex level (0..1) for flex kinds. */
  threshold: number;
  /** Thermal hysteresis (K): the fault clears below threshold − hysteresis. */
  hysteresis?: number;
  /** Leak resistance for thermal-leak (Ω). */
  ohms?: number;
  /** Current state (fault present). Maintained by updateIntermittents. */
  active?: boolean;
}

export interface Environment {
  partTemp(id: string): number | undefined;
  /** Board flex at a point, 0 (relaxed) … 1 (strong press). */
  flexAt(xmm: number, ymm: number): number;
}

/** Flex field from presses: Gaussian bump around each press, fading over its duration. */
export class FlexField {
  private presses: { x: number; y: number; t0: number; dur: number; s: number; r: number }[] = [];
  private now = 0;
  press(xmm: number, ymm: number, opts: { strength?: number; radius?: number; duration?: number } = {}) {
    this.presses.push({ x: xmm, y: ymm, t0: this.now, dur: opts.duration ?? 2.0, s: opts.strength ?? 1, r: opts.radius ?? 12 });
  }
  advance(dt: number) {
    this.now += dt;
    this.presses = this.presses.filter((p) => this.now - p.t0 < p.dur);
  }
  at(xmm: number, ymm: number): number {
    let f = 0;
    for (const p of this.presses) {
      const d2 = (xmm - p.x) ** 2 + (ymm - p.y) ** 2;
      f = Math.max(f, p.s * Math.exp(-d2 / (2 * p.r * p.r)));
    }
    return f;
  }
  get active() { return this.presses.length > 0; }
}

function setCold(c: Component, pi: number, open: boolean) {
  const s = new Set(c.state.cold);
  if (open) s.add(pi); else s.delete(pi);
  c.state.cold = [...s].sort((a, b) => a - b);
}

/**
 * Re-evaluates every intermittent fault against the environment. Returns the refs whose
 * electrical state changed (the caller re-solves when the list is non-empty).
 */
export function updateIntermittents(board: Board, env: Environment): string[] {
  const changed: string[] = [];
  for (const c of board.components) {
    const list = c.state.intermittent;
    if (!list?.length || !c.state.populated) continue;
    let touched = false;
    for (const f of list) {
      let active = !!f.active;
      if (f.kind === 'thermal-open' || f.kind === 'thermal-leak') {
        const t = env.partTemp(c.id) ?? 25;
        const hys = f.hysteresis ?? 5;
        if (!active && t >= f.threshold) active = true;
        else if (active && t <= f.threshold - hys) active = false;
      } else {
        const fl = env.flexAt(c.at[0], c.at[1]);
        active = f.kind === 'flex-open' ? fl >= f.threshold : fl < f.threshold;
      }
      if (active === !!f.active) continue;
      f.active = active;
      touched = true;
      if (f.kind === 'thermal-leak') c.state.leak = active ? { ohms: f.ohms ?? 10 } : undefined;
      else if (f.pad !== undefined) setCold(c, f.pad, active);
    }
    if (touched) changed.push(c.ref);
  }
  return changed;
}

/** Initialises fault state for a resting board at ambient (flex-close joints start open). */
export function settleIntermittents(board: Board): void {
  updateIntermittents(board, { partTemp: () => 25, flexAt: () => 0 });
}
