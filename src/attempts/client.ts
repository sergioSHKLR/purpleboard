// The game side of DEADBOARD's own puzzle statistics: one anonymous record per attempt (the
// fields and their rules are in ./record.ts). An attempt starts when a board is loaded and ends
// when it is fixed, another board is loaded, or the page is left. When the tab is hidden the record
// so far is sent (the page may never come back); if the player returns, the final record replaces
// it on the collector (same random `attempt` token, never stored on the device).
//
// Sends only on the public website (SITE_HOST) when the build has a collector address
// (VITE_ATTEMPTS_URL), never in the apps, dev or forks. Honours Do Not Track, Global Privacy
// Control and the player's own switch (⚙ menu, `pcbfix_stats_off`).

import { SITE_HOST } from '../analytics';
import { ACTIVE_RANGES, ATTEMPT_RANGES, type AttemptRecord, COUNT_RANGES, DAY_RANGES, inRange, RECORD_VERSION, SOLVED_RANGES, TOOL_IDS, type VIDEOS } from './record';

export type PuzzleInfo = Pick<AttemptRecord, 'puzzle' | 'kind' | 'from' | 'pv' | 'level' | 'faults'>;
export interface AttemptContext {
  layout: AttemptRecord['layout'];
  lang: AttemptRecord['lang'];
  /** Boards solved before this attempt. */
  solvedBefore: number;
  /** Whole days since this device first opened the bench. */
  daysSinceFirst: number;
}

type Sender = (rec: AttemptRecord, final: boolean) => void;

/** An attempt this short, with nothing done, is browsing: not sent. */
export const MIN_ACTIVE_SEC = 10;

interface Open {
  info: PuzzleInfo;
  ctx: AttemptContext;
  token: string;
  nth: number;
  activeSec: number;
  moves: number;
  probes: number;
  tests: number;
  firstTest: AttemptRecord['firstTest'];
  notes: number;
  look: number;
  videos: Set<'approach' | 'solution'>;
  tools: Set<string>;
  tut: number;
  sent: boolean;
}

export class AttemptTracker {
  private cur: Open | null = null;
  private begun = 0;

  constructor(private send: Sender, private build: string, private token: () => string = randomToken) {}

  /** A board was loaded: the open attempt (if any) ends as "switched" and a new one starts. */
  begin(info: PuzzleInfo, ctx: AttemptContext): void {
    this.end('switched');
    this.cur = { info, ctx, token: this.token(), nth: ++this.begun, activeSec: 0, moves: 0, probes: 0, tests: 0, firstTest: 'none', notes: 0, look: 0, videos: new Set(), tools: new Set(), tut: 0, sent: false };
  }

  /** Seconds of active play (visible tab, recent input) on the open attempt. */
  active(sec: number): void { if (this.cur) this.cur.activeSec += Math.max(0, sec); }
  tool(id: string): void { if (this.cur && (TOOL_IDS as readonly string[]).includes(id)) this.cur.tools.add(id); }
  probe(): void { if (this.cur) this.cur.probes++; }
  move(): void { if (this.cur) this.cur.moves++; }
  note(): void { if (this.cur) this.cur.notes = Math.min(20, this.cur.notes + 1); }
  look(): void { if (this.cur) this.cur.look++; }
  video(kind: 'approach' | 'solution'): void { this.cur?.videos.add(kind); }
  tutStep(step: number): void { if (this.cur) this.cur.tut = Math.min(20, Math.max(this.cur.tut, step)); }

  /** Tests ran; a fix ends the attempt. */
  tests(passed: boolean, fixed: boolean): void {
    if (!this.cur) return;
    this.cur.tests++;
    if (this.cur.firstTest === 'none') this.cur.firstTest = passed ? 'pass' : 'fail';
    if (fixed) this.end('fixed');
  }

  /** The tab was hidden: send what we have as "left"; the attempt stays open in case the player returns. */
  hidden(): void {
    const c = this.cur;
    if (!c || !this.worthSending(c)) return;
    c.sent = true;
    this.send(this.record(c, 'left'), false);
  }

  /** The record as it would be sent now (tests). */
  peek(outcome: AttemptRecord['outcome']): AttemptRecord | null {
    return this.cur ? this.record(this.cur, outcome) : null;
  }

  private end(outcome: AttemptRecord['outcome']): void {
    const c = this.cur;
    this.cur = null;
    if (!c || (!c.sent && !this.worthSending(c))) return;
    this.send(this.record(c, outcome), true);
  }

  private worthSending(c: Open): boolean {
    return c.activeSec >= MIN_ACTIVE_SEC || c.moves + c.probes + c.tests + c.notes + c.look + c.videos.size + c.tools.size > 0;
  }

  private record(c: Open, outcome: AttemptRecord['outcome']): AttemptRecord {
    const video: (typeof VIDEOS)[number] = c.videos.size === 2 ? 'both' : c.videos.has('approach') ? 'approach' : c.videos.has('solution') ? 'solution' : 'none';
    return {
      v: RECORD_VERSION,
      attempt: c.token,
      build: this.build,
      ...c.info,
      level: Math.round(c.info.level * 10) / 10,
      outcome,
      active: inRange(ACTIVE_RANGES, c.activeSec),
      moves: inRange(COUNT_RANGES, c.moves),
      probes: inRange(COUNT_RANGES, c.probes),
      tests: inRange(COUNT_RANGES, c.tests),
      firstTest: c.firstTest,
      notes: c.notes,
      look: inRange(COUNT_RANGES, c.look),
      video,
      tools: [...c.tools].sort() as AttemptRecord['tools'],
      tut: c.tut,
      layout: c.ctx.layout,
      lang: c.ctx.lang,
      nth: inRange(ATTEMPT_RANGES, c.nth),
      solved: inRange(SOLVED_RANGES, c.ctx.solvedBefore),
      days: inRange(DAY_RANGES, c.ctx.daysSinceFirst),
      ab: '',
    };
  }
}

/** 32 random hex characters (one attempt's token). */
export function randomToken(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export const STATS_OFF_KEY = 'pcbfix_stats_off';
const FIRST_DAY_KEY = 'pcbfix_first_day';

/** The player's own switch (default on, on the website only). */
export function statsSwitchOn(): boolean {
  try { return localStorage.getItem(STATS_OFF_KEY) !== '1'; } catch { return true; }
}
export function setStatsSwitch(on: boolean): void {
  try { if (on) localStorage.removeItem(STATS_OFF_KEY); else localStorage.setItem(STATS_OFF_KEY, '1'); } catch { /* private mode */ }
}

/** Do Not Track or Global Privacy Control set in the browser. */
export function browserOptedOut(nav: { doNotTrack?: string | null; globalPrivacyControl?: boolean } = typeof navigator === 'undefined' ? {} : navigator as never): boolean {
  return nav.doNotTrack === '1' || nav.doNotTrack === 'yes' || nav.globalPrivacyControl === true;
}

/** Should this page send attempt records at all? (The switch is checked on every send.) */
export function attemptsEnabled(url: string, host: string): boolean {
  return /^https:\/\/[a-z0-9.-]+\/[a-z0-9/]*$/.test(url) && host === SITE_HOST;
}

/** Whole days since this device first opened the bench (only the date is kept, on the device). */
export function daysSinceFirstPlay(now = new Date()): number {
  const today = now.toISOString().slice(0, 10);
  let first = today;
  try {
    first = localStorage.getItem(FIRST_DAY_KEY) ?? today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(first)) first = today;
    localStorage.setItem(FIRST_DAY_KEY, first);
  } catch { /* private mode: every visit is day 0 */ }
  return Math.max(0, Math.round((Date.parse(today) - Date.parse(first)) / 86_400_000));
}

/**
 * The browser sender: `sendBeacon` with a text body (no CORS preflight, still delivered while the
 * page unloads), else `fetch` with keepalive. Null where attempts are off.
 */
export function browserSender(): Sender | null {
  const url = ((import.meta.env?.VITE_ATTEMPTS_URL as string | undefined) ?? '').trim();
  if (typeof location === 'undefined' || !attemptsEnabled(url, location.hostname) || browserOptedOut()) return null;
  return (rec) => {
    if (!statsSwitchOn()) return;
    const body = JSON.stringify(rec);
    try {
      if (navigator.sendBeacon?.(url, new Blob([body], { type: 'text/plain' }))) return;
    } catch { /* fall through */ }
    void fetch(url, { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'text/plain' }, credentials: 'omit' }).catch(() => {});
  };
}

/**
 * Active play time, like the "active N min" events: counts only while the tab is visible and
 * there was input in the last 2 minutes. Calls `add(seconds)` every 15 s of such time.
 */
export function startActiveClock(add: (sec: number) => void): void {
  if (typeof document === 'undefined') return;
  const IDLE_MS = 120_000, TICK_MS = 15_000;
  let lastInput = Date.now(), lastTick = Date.now();
  const touch = () => { lastInput = Date.now(); };
  for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) addEventListener(ev, touch, { passive: true, capture: true });
  document.addEventListener('visibilitychange', () => { lastTick = Date.now(); if (!document.hidden) touch(); });
  setInterval(() => {
    const now = Date.now();
    const dt = Math.min(now - lastTick, TICK_MS) / 1000;
    lastTick = now;
    if (document.hidden || now - lastInput > IDLE_MS) return;
    add(dt);
  }, TICK_MS);
}
