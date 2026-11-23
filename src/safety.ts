// PurpleBoard (sergioSHKLR, 2026): bench safety violations, a buzzer and a per-board safety score.
// Pure bookkeeping: the bench (src/ui/app.ts) decides when a rule is broken and calls record().
import { t, tk } from './i18n';
import type { Board, Component } from './types';

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

// ---------------- safety brief (before every board exercise) ----------------

export type BriefItemId = 'power-off' | 'heat' | 'short' | 'supplies' | 'high-voltage' | 'charge' | 'mlcc' | 'hot-air' | 'ipa' | 'esd';
export interface BriefItem { id: BriefItemId; text: string; /** Breaking it costs safety points (else it is advice). */ scored: boolean }
export type BriefTier = 'short' | 'standard' | 'full';
export interface SafetyBrief { tier: BriefTier; items: BriefItem[] }

/** Thresholds the brief uses (the MLCC and small-part sizes follow src/rework.ts). */
export const BRIEF_LIMITS = {
  /** A supply at or above this can drive a damaging short (below: a coin cell). */
  shortVolts: 5,
  /** Above the SELV limit (60 V DC): high-voltage warning. */
  highVolts: 60,
  /** Electrolytics that hold a noticeable charge. */
  bigCapF: 100e-6,
  /** Ceramic caps this big (body w × h, mm²) crack from thermal shock (rework.ts). */
  mlccArea: 1.2,
  /** Parts this small (mm²) blow off under hot air (rework.ts smallPartArea). */
  smallPartArea: 0.6,
};

const refList = (cs: Component[]) => cs.slice(0, 3).map((c) => c.ref).join(', ') + (cs.length > 3 ? ', …' : '');
const volts = (v: number) => `${+v.toPrecision(3)} V`;

/**
 * The safety brief for a board, derived from what is on it: every powered board gets the
 * power-off rule and the heat rule; supply strength, fuses, several supplies, big capacitors,
 * large ceramic caps, tiny parts, liquid residue and ICs each add an item. Penalties come from
 * SAFETY_POINTS. Short (≤ 2 items), standard (3–4) or full (5 and more).
 */
export function safetyBriefFor(board: Board): SafetyBrief {
  const cs = board.components.filter((c) => c.state.populated !== false);
  const of = (k: Component['kind']) => cs.filter((c) => c.kind === k);
  const sources = of('battery');
  const maxV = Math.max(0, ...sources.map((c) => c.value));
  const P = SAFETY_POINTS;
  const items: BriefItem[] = [];
  if (sources.length) {
    items.push({ id: 'power-off', scored: true, text: t('Power off before the iron, wick or isopropyl touch the board (−{iron} / −{wick} / −{ipa} pts if not).', { iron: P['live-iron'], wick: P['live-wick'], ipa: P['live-ipa'] }) });
  }
  if (maxV > BRIEF_LIMITS.highVolts) {
    items.push({ id: 'high-voltage', scored: false, text: t('High voltage ({v}): keep hands and tools off live copper.', { v: volts(maxV) }) });
  }
  if (sources.length > 1) {
    items.push({ id: 'supplies', scored: false, text: t('{n} supply input ({volts}): make sure it is off.|{n} supply inputs ({volts}): make sure all of them are off.', { n: sources.length, volts: sources.map((c) => volts(c.value)).join(', ') }) });
  }
  const fuses = of('fuse');
  if (sources.length && (maxV >= BRIEF_LIMITS.shortVolts || fuses.length)) {
    items.push({ id: 'short', scored: true, text: fuses.length
      ? t('The {v} supply can drive a short: a bridge or jumper made live burns parts or blows {fuses} (−{n} pts).', { v: volts(maxV), fuses: refList(fuses), n: P['live-short'] })
      : t('The {v} supply can drive a short: a bridge or jumper made live burns parts (−{n} pts).', { v: volts(maxV), n: P['live-short'] }) });
  }
  const bigCaps = of('capacitor').filter((c) => c.value >= BRIEF_LIMITS.bigCapF);
  if (bigCaps.length) {
    items.push({ id: 'charge', scored: false, text: t('Large capacitors ({refs}) can stay charged after power-off: discharge them before work.', { refs: refList(bigCaps) }) });
  }
  items.push({ id: 'heat', scored: true, text: t('Heat each joint only as long as it needs: overheating lifts pads and damages parts (−{n} pts in Realistic rework).', { n: P.overheat }) });
  const mlcc = of('capacitor').filter((c) => c.body.w * c.body.h >= BRIEF_LIMITS.mlccArea && c.value < BRIEF_LIMITS.bigCapF);
  if (mlcc.length) {
    items.push({ id: 'mlcc', scored: true, text: t('Ceramic capacitors ({refs}) crack from thermal shock: preheat before heating them (−{n} pts).', { refs: refList(mlcc), n: P.overheat }) });
  }
  const tiny = cs.filter((c) => c.body.w * c.body.h < BRIEF_LIMITS.smallPartArea && c.pads.length <= 2);
  if (tiny.length) {
    items.push({ id: 'hot-air', scored: false, text: t('Hot air can blow small parts ({refs}) off their pads: heat briefly, then check them.', { refs: refList(tiny) }) });
  }
  const residue = cs.filter((c) => c.state.residue);
  if (residue.length) {
    items.push({ id: 'ipa', scored: true, text: t('Residue on {refs}: scrub with isopropyl only with power off. It is flammable: let it dry before the iron (−{n} pts).', { refs: refList(residue), n: P['live-ipa'] }) });
  }
  const ics = of('ic');
  if (ics.length) {
    items.push({ id: 'esd', scored: false, text: t('{n} IC is static-sensitive: use a wrist strap and mat (good practice; the sim does not score ESD).|{n} ICs are static-sensitive: use a wrist strap and mat (good practice; the sim does not score ESD).', { n: ics.length }) });
  }
  const tier: BriefTier = items.length <= 2 ? 'short' : items.length <= 4 ? 'standard' : 'full';
  return { tier, items };
}

export const BRIEF_TIER_LABELS: Readonly<Record<BriefTier, string>> = {
  short: tk('Short brief'),
  standard: tk('Standard brief'),
  full: tk('Full brief'),
};
