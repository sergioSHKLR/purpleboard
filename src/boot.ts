// Power-up as a technician sees it on the bench-supply ammeter. A generic power controller
// (the job of an SMC / EC / PMIC sequencer) steps the board through its power states and only
// advances when the rails of the current state are up; a rail that never comes up makes it
// give up, shut down and retry — the "current climbs then drops back" boot loop.
// Timings are typical orders of magnitude, not a specific controller's datasheet values.
import type { PowerTree } from './spice/powertree';
import { railVoltage } from './spice/powertree';
import { POWER_STATES, expectedUp, type PowerStateName } from './spice/sequencer';

export type BootState = PowerStateName | 'OFF';

/** Controller timing (s). Estimates. */
export const BOOT_TIMING = {
  /** Supply connected → power button / auto-boot. */
  standby: 1.0,
  /** Minimum time spent in each state before checking its rails. */
  dwell: { G3H: 0, S5: 0.12, S4: 0.05, S3: 0.12, S0: 0.25, S0SW: 0.25 } as Record<PowerStateName, number>,
  /** Longest wait for a state's rails before the controller gives up. */
  timeout: 1.2,
  /** Off time before retrying after a failed attempt. */
  retry: 1.5,
  /** Bench-supply ammeter averaging (first-order time constant). */
  meterTau: 0.25,
};

export interface RequiredRail { rail: string; v: number }

/**
 * Rails a controller would wait for in `state`: the outputs of its main regulators (switching
 * converters and LDOs with a known target, detected with at least medium confidence) whose
 * names say they are up in that state. Per-device load switches are not waited for — a dead
 * SSD or Wi-Fi rail does not stop a real sequencer, it only shows on the ammeter.
 */
export function requiredRails(tree: PowerTree, state: PowerStateName): RequiredRail[] {
  const out = new Map<string, RequiredRail>();
  for (const s of tree.sources) {
    if (!['buck', 'boost', 'ldo'].includes(s.kind) || s.confidence === 'low') continue;
    if (expectedUp(s.output, state) !== true) continue;
    const v = s.vTarget ?? railVoltage(s.output);
    if (v) out.set(s.output, { rail: s.output, v });
  }
  return [...out.values()];
}

export interface BootSample { t: number; amps: number; state: BootState }

/** Steps the machine state; the caller re-solves the board whenever `state` changes. */
export class BootController {
  state: BootState = 'OFF';
  /** Displayed (averaged) supply current, A. */
  amps = 0;
  /** Number of failed attempts since power-on. */
  failures = 0;
  /** Rails that blocked the last failed attempt. */
  blockedBy: string[] = [];
  readonly history: BootSample[] = [];
  private t = 0;
  private inState = 0;
  /** Time to stay in standby before (re)starting the sequence. */
  private standbyWait: number = BOOT_TIMING.standby;

  constructor(private readonly states: PowerStateName[] = POWER_STATES.map((s) => s.name)) {}

  get time() { return this.t; }

  powerOn() {
    this.state = this.states[0];
    this.t = 0; this.inState = 0; this.failures = 0; this.blockedBy = []; this.amps = 0; this.standbyWait = BOOT_TIMING.standby;
    this.history.length = 0;
  }

  powerOff() { this.state = 'OFF'; }

  /**
   * Advances time. `measuredAmps` is the solved supply current for the current state;
   * `missing(state)` lists required rails of that state that are not up in the latest solve.
   * Returns true when the state changed (re-solve needed).
   */
  tick(dt: number, measuredAmps: number, missing: (s: PowerStateName) => string[]): boolean {
    this.t += dt;
    this.inState += dt;
    this.amps += (measuredAmps - this.amps) * (1 - Math.exp(-dt / BOOT_TIMING.meterTau));
    const last = this.history[this.history.length - 1];
    if (!last || this.t - last.t >= 0.05) {
      this.history.push({ t: this.t, amps: this.amps, state: this.state });
      if (this.history.length > 600) this.history.shift();
    }
    if (this.state === 'OFF') return false;
    const i = this.states.indexOf(this.state);
    const next = this.states[i + 1];
    if (!next) return false; // fully on
    const wait = i === 0 ? this.standbyWait : BOOT_TIMING.dwell[this.state];
    if (this.inState < wait) return false;
    const miss = missing(this.state);
    if (!miss.length) return this.go(next);
    if (this.inState >= wait + BOOT_TIMING.timeout) {
      // the controller gives up: back to standby (always-on rails stay up), then a retry
      this.failures++;
      this.blockedBy = miss;
      this.standbyWait = BOOT_TIMING.retry;
      return this.go(this.states[0]);
    }
    return false;
  }

  private go(s: BootState): boolean {
    this.state = s;
    this.inState = 0;
    return true;
  }
}
