// PurpleBoard (sergioSHKLR, 2026): bench safety violations, a buzzer and a per-board safety score.
// Pure bookkeeping: the bench (src/ui/app.ts) decides when a rule is broken and calls record().
import { tk } from './i18n';

export type SafetyKind = 'live-iron' | 'live-wick' | 'live-ipa' | 'live-short' | 'overheat';

/** Points each violation costs, out of a 100-point safety score per board. */
export const SAFETY_POINTS: Readonly<Record<SafetyKind, number>> = {
  'live-iron': 10,
  'live-wick': 10,
  'live-ipa': 15,
  'live-short': 20,
  overheat: 10,
};

/** English labels (the bench passes them through t()). */
export const SAFETY_LABELS: Readonly<Record<SafetyKind, string>> = {
  'live-iron': tk('Soldering iron on a powered board'),
  'live-wick': tk('Desolder wick on a powered board'),
  'live-ipa': tk('Isopropyl on a powered board'),
  'live-short': tk('Short made on a live board'),
  overheat: tk('Overheat damage (iron or hot air held too long)'),
};

export const SAFETY_ORDER: readonly SafetyKind[] = ['live-iron', 'live-wick', 'live-ipa', 'live-short', 'overheat'];

/** The same violation key within this many seconds of the last attempt is the same contact. */
export const SAFETY_DEBOUNCE_S = 1.5;

export interface SafetyViolation { kind: SafetyKind; key: string; at: number; points: number }

export class SafetyLog {
  readonly list: SafetyViolation[] = [];
  private last = new Map<string, number>();

  /**
   * One violation, counted once per contact: a repeat of the same kind + key less than
   * SAFETY_DEBOUNCE_S after the previous attempt (counted or not) is ignored. `now` in seconds.
   */
  record(kind: SafetyKind, key: string, now: number): SafetyViolation | null {
    const k = `${kind}:${key}`;
    const prev = this.last.get(k);
    this.last.set(k, now);
    if (prev !== undefined && now - prev < SAFETY_DEBOUNCE_S) return null;
    const v: SafetyViolation = { kind, key, at: now, points: SAFETY_POINTS[kind] };
    this.list.push(v);
    return v;
  }

  get penalty(): number { return this.list.reduce((s, v) => s + v.points, 0); }
  /** 100 minus the penalties, never below 0. */
  get score(): number { return Math.max(0, 100 - this.penalty); }

  /** Count and points per kind, in SAFETY_ORDER, kinds with no violation left out. */
  breakdown(): { kind: SafetyKind; count: number; points: number }[] {
    return SAFETY_ORDER.map((kind) => {
      const l = this.list.filter((v) => v.kind === kind);
      return { kind, count: l.length, points: l.reduce((s, v) => s + v.points, 0) };
    }).filter((r) => r.count > 0);
  }

  reset() { this.list.length = 0; this.last.clear(); }
}

/** The bench tool that touches the board → the violation it is with the supply on (null: allowed live). */
export function liveToolViolation(tool: string): SafetyKind | null {
  return tool === 'iron' ? 'live-iron' : tool === 'wick' ? 'live-wick' : tool === 'ipa' ? 'live-ipa' : null;
}

/** Rework events that count as overheat damage. */
export function isOverheatEvent(kind: string): boolean {
  return kind === 'pad-lifted' || kind === 'part-overheated' || kind === 'mlcc-cracked';
}

const BUZZER_KEY = 'purpleboard_safety_buzzer';
export function loadBuzzerOn(store: Pick<Storage, 'getItem'> | null): boolean {
  try { return store?.getItem(BUZZER_KEY) !== '0'; } catch { return true; }
}
export function saveBuzzerOn(store: Pick<Storage, 'setItem'> | null, on: boolean) {
  try { store?.setItem(BUZZER_KEY, on ? '1' : '0'); } catch { /* storage unavailable */ }
}
