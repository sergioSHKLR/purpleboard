// Rework process outcomes from thermal history. The thermal model supplies temperatures under
// real heat sources (iron, hot air, preheater); this monitor turns them into what happens to the
// solder joints, pads and parts. Limits are typical process-window values (estimates, as data).
import type { Board, Component } from './types';
import type { ThermalModel } from './thermal';
import { rng, seedOf, sampleSeverity } from './faults';

export interface Alloy { name: string; liquidus: number }
export const SAC305: Alloy = { name: 'SAC305 (lead-free)', liquidus: 217 };
export const SN63: Alloy = { name: 'Sn63Pb37', liquidus: 183 };

export interface ProcessLimits {
  alloy: Alloy;
  /** Time above liquidus for a joint to wet properly (s). */
  reflowSeconds: number;
  /** Flux activity: seconds above liquidus before it is exhausted. */
  fluxSeconds: number;
  /** Pad adhesion: cumulative seconds above `padLiftTemp` before the pad delaminates. */
  padLiftTemp: number;
  padLiftSeconds: number;
  /** Part body: cumulative seconds above `partMaxTemp` before it is damaged. */
  partMaxTemp: number;
  partMaxSeconds: number;
  /** MLCC thermal shock: heating rate (K/s, smoothed) that cracks an un-preheated ceramic cap. */
  mlccShockRate: number;
  /**
   * Hot-air coefficient (W/m²K; impinging rework jets ≈ 500–1000 at normal flow) that displaces a
   * molten small part, and what "small" means (mm²).
   */
  blowAwayH: number;
  smallPartArea: number;
}

/** Bottom preheater coefficient (W/m²K): holds a board near 130 °C at a 150 °C setting. */
export const PREHEAT_H = 150;
/** Hot-air jet coefficients (W/m²K): normal and high flow. */
export const HOTAIR_H = { normal: 1000, high: 1500 }; // upper end of jet range: the 1-layer plate model under-states local surface heating

/** Tip-to-joint conductance (W/K): wetted with flux vs dry tip. */
export const IRON_G = { flux: 0.22, dry: 0.07 };

export const DEFAULT_LIMITS: ProcessLimits = {
  alloy: SAC305, reflowSeconds: 0.6, fluxSeconds: 8, padLiftTemp: 300, padLiftSeconds: 6,
  partMaxTemp: 300, partMaxSeconds: 10, mlccShockRate: 150, blowAwayH: 1400, smallPartArea: 0.6,
};

export type ReworkEventKind = 'molten' | 'reflowed' | 'dull-joint' | 'pad-lifted' | 'part-overheated' | 'mlcc-cracked' | 'part-displaced';
export interface ReworkEvent { kind: ReworkEventKind; ref: string; pad?: number; detail: string }

interface JointState { above: number; melted: boolean; hot: number }
interface PartState { seen: number; overheat: number; rate: number; lastT: number; base: number; flux: number; cracked: boolean; displaced: boolean; molten: boolean }

export class ReworkMonitor {
  private joints = new Map<string, JointState>();
  private parts = new Map<string, PartState>();

  constructor(readonly board: Board, readonly thermal: ThermalModel, readonly limits: ProcessLimits = DEFAULT_LIMITS) {}

  private part(c: Component): PartState {
    let s = this.parts.get(c.id);
    if (!s) this.parts.set(c.id, (s = { seen: this.thermal.time, overheat: 0, rate: 0, lastT: this.thermal.partTemp(c.id) ?? 25, base: this.thermal.partTemp(c.id) ?? 25, flux: 0, cracked: false, displaced: false, molten: false }));
    return s;
  }

  /** Flux applied over an area (parts whose origin lies inside). */
  applyFlux(xmm: number, ymm: number, rmm = 3) {
    for (const c of this.board.components) {
      if ((c.at[0] - xmm) ** 2 + (c.at[1] - ymm) ** 2 <= rmm * rmm) this.part(c).flux = this.limits.fluxSeconds;
    }
  }

  isMolten(c: Component): boolean { return this.parts.get(c.id)?.molten ?? false; }

  /** Advance bookkeeping by dt (call after thermal.step(dt)); applies outcomes to the board. */
  update(dt: number): ReworkEvent[] {
    const L = this.limits, ev: ReworkEvent[] = [];
    const hotAir = this.thermal.sources.filter((s) => s.kind === 'hotair');
    for (const c of this.board.components) {
      if (!c.state.populated || !c.pads.length) continue;
      const T = this.thermal.partTemp(c.id);
      if (T === undefined) continue;
      const ps = this.part(c);
      // not observed for a while (monitor paused): resync history instead of seeing a fake jump
      if (this.thermal.time - ps.seen > 1) { ps.lastT = T; ps.base = T; ps.rate = 0; }
      ps.seen = this.thermal.time;
      // heating rate (smoothed) for thermal shock
      const r = (T - ps.lastT) / Math.max(dt, 1e-3);
      ps.rate = ps.rate * 0.7 + r * 0.3;
      ps.lastT = T;
      // slow baseline (τ ≈ 3 s): the temperature the part sat at before a sudden heat-up
      ps.base += (T - ps.base) * Math.min(1, dt / 3);
      let allMolten = true;
      c.pads.forEach((p, pi) => {
        const key = `${c.id}#${pi}`;
        let js = this.joints.get(key);
        if (!js) this.joints.set(key, (js = { above: 0, melted: false, hot: 0 }));
        const tj = this.thermal.jointTemp(c, pi);
        if (tj >= L.alloy.liquidus) {
          js.above += dt;
          if (ps.flux > 0) ps.flux = Math.max(0, ps.flux - dt / c.pads.length);
        } else {
          allMolten = false;
          if (tj < L.alloy.liquidus - 15) { js.above = 0; js.melted = false; }
        }
        if (!js.melted && js.above >= L.reflowSeconds) {
          js.melted = true;
          const lifted = c.state.lifted?.includes(pi);
          if (!lifted && c.state.cold.includes(pi)) {
            const ok = ps.flux > 0 || rng(seedOf(`${c.ref}|${pi}|${Math.round(this.thermal.time)}`))() < 0.4;
            if (ok) {
              c.state.cold = c.state.cold.filter((x) => x !== pi);
              if (c.state.coldOhms) { delete c.state.coldOhms[pi]; if (!Object.keys(c.state.coldOhms).length) c.state.coldOhms = undefined; }
              ev.push({ kind: 'reflowed', ref: c.ref, pad: pi, detail: `${c.ref} pad ${p.name} reflowed${ps.flux > 0 ? ' with flux' : ''}` });
            } else ev.push({ kind: 'dull-joint', ref: c.ref, pad: pi, detail: `${c.ref} pad ${p.name}: no flux — oxidised, still dull` });
          }
          if (!lifted && c.state.intermittent?.some((f) => f.pad === pi)) {
            c.state.intermittent = c.state.intermittent.filter((f) => f.pad !== pi);
            if (!c.state.intermittent.length) c.state.intermittent = undefined;
            ev.push({ kind: 'reflowed', ref: c.ref, pad: pi, detail: `${c.ref} pad ${p.name}: cracked joint reflowed` });
          }
        }
        // pad delamination from prolonged overheating
        if (tj >= L.padLiftTemp) js.hot += dt;
        if (js.hot >= L.padLiftSeconds && !c.state.lifted?.includes(pi)) {
          c.state.lifted = [...(c.state.lifted ?? []), pi];
          if (!c.state.cold.includes(pi)) c.state.cold = [...c.state.cold, pi].sort((a, b) => a - b);
          ev.push({ kind: 'pad-lifted', ref: c.ref, pad: pi, detail: `${c.ref} pad ${p.name} lifted (overheated ${js.hot.toFixed(1)} s above ${L.padLiftTemp} °C) — needs a jumper wire` });
        }
      });
      if (allMolten && !ps.molten) ev.push({ kind: 'molten', ref: c.ref, detail: `${c.ref}: all joints molten — can be lifted` });
      ps.molten = allMolten;
      // part body overheating
      if (T >= L.partMaxTemp) ps.overheat += dt;
      if (ps.overheat >= L.partMaxSeconds && !c.state.burnt && c.kind !== 'testpoint') {
        c.state.burnt = true;
        ev.push({ kind: 'part-overheated', ref: c.ref, detail: `${c.ref} overheated (${ps.overheat.toFixed(1)} s above ${L.partMaxTemp} °C)` });
      }
      // MLCC thermal shock
      // thermal-shock cracking is a large-ceramic problem (0805 and up); small MLCCs survive iron contact
      const area = c.body.w * c.body.h;
      // (only when not preheated: guidance is to bring ceramics to ≥ 100 °C before tip contact)
      if (c.kind === 'capacitor' && !ps.cracked && area >= 1.2 && ps.base < 100 && T > 120 && ps.rate > L.mlccShockRate
        && rng(seedOf(`shock|${c.ref}|${Math.round(this.thermal.time * 10)}`))() < Math.min(1, ps.rate / L.mlccShockRate - 1) * (area / 3)) {
        ps.cracked = true;
        const ohms = sampleSeverity('cap-partial-short', rng(seedOf(`crack|${c.ref}`)));
        c.state.leak = { ohms };
        ev.push({ kind: 'mlcc-cracked', ref: c.ref, detail: `${c.ref} cracked by thermal shock (${ps.rate.toFixed(0)} K/s) — now leaks ${ohms} Ω; preheat the board first` });
      }
      // small molten part under strong airflow is blown off its pads (tombstone / skew)
      if (allMolten && !ps.displaced && c.body.w * c.body.h <= L.smallPartArea) {
        const strong = hotAir.some((s) => s.kind === 'hotair' && s.h >= L.blowAwayH && (c.at[0] - s.x) ** 2 + (c.at[1] - s.y) ** 2 <= s.r * s.r);
        if (strong) {
          ps.displaced = true;
          if (!c.state.cold.includes(0)) c.state.cold = [...c.state.cold, 0].sort((a, b) => a - b);
          ev.push({ kind: 'part-displaced', ref: c.ref, detail: `${c.ref} blown off one pad by the airflow (tombstoned) — re-seat and reflow` });
        }
      }
    }
    return ev;
  }
}
