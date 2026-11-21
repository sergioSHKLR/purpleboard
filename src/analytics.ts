// Website usage analytics (Umami Cloud: no cookies, no personal data, no consent banner needed).
// Runs only on the public website: the Umami website id comes from the build (VITE_UMAMI_ID, set
// from the repository variable UMAMI_ID in the Pages workflow) AND the page must be served from
// SITE_HOST, so local dev, forks, and the iOS and desktop apps never send anything.
//
// Umami counts visitors and page views by itself. It measures visit length as the time between
// events, and the bench is one long page, so we add "active N min" events: active time counts
// only while the tab is visible and the player touched mouse, keys or screen in the last 2 minutes.
// Each event fires once per page load when that much active time is reached, so the Events view
// reads as a funnel ("1 min: 400, 5 min: 210, 30 min: 40") and Umami's visit duration is right.

export const SITE_HOST = 'deadboard.org';
const SCRIPT = 'https://cloud.umami.is/script.js';
/** Active-time milestones in minutes. Sparse on purpose: a 4-hour session costs 13 events. */
export const MILESTONES = [1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240];
const IDLE_MS = 2 * 60_000;
const TICK_MS = 15_000;

type UmamiPayload = Record<string, unknown>;
declare global {
  interface Window {
    umami?: { track: (nameOrPayload: string | ((props: UmamiPayload) => UmamiPayload), data?: Record<string, string | number>) => void };
  }
}

type Call = Parameters<NonNullable<Window['umami']>['track']>;
/** Calls made before the deferred script arrived (only kept once analytics is on for this page). */
let pending: Call[] | null = null;
const send = (...c: Call) => {
  if (typeof window === 'undefined') return;
  if (window.umami) window.umami.track(...c);
  else if (pending && pending.length < 50) pending.push(c);
};

/**
 * The bench's own events: which board was opened and fixed, how far the first lesson got, and
 * finishing the tutorial. Ids only for boards that ship with the game; anything the player imported
 * or made is just "custom". No-ops wherever analytics is off (the Umami script never loads): dev,
 * forks, the apps. Events fired before the script loaded (the first seconds) are sent once it has.
 */
export function trackEvent(name: string, data?: Record<string, string | number>): void {
  send(name, data);
}

/**
 * Opening another board counts as a page view ("/board/<id>"): the bench is one page, so without
 * this Umami calls every visit that stays on the bench a bounce, however long the player stays.
 */
export function trackBoardView(boardId: string, title: string): void {
  send((p) => ({ ...p, url: `/board/${boardId}`, title }));
}

/** Visible seconds as a range for the leave events: ranges answer "left at once or after trying". */
export function secondsBucket(sec: number): string {
  return sec < 5 ? '<5s' : sec < 15 ? '5-15s' : sec < 30 ? '15-30s' : sec < 60 ? '30-60s' : '60s+';
}

/** Deepest scroll (0..1 of the scrollable height) in quarters: '0%', '25%', '50%', '75%', '100%'. */
export function scrollBucket(f: number): string {
  return `${Math.min(4, Math.floor(Math.max(0, f) * 4 + 1e-9)) * 25}%`;
}

/** Seconds this page has been visible so far (a background tab's time does not count). */
export function visibleClock(): () => number {
  if (typeof document === 'undefined') return () => 0;
  let total = 0;
  let since = document.hidden ? -1 : performance.now();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && since >= 0) { total += performance.now() - since; since = -1; }
    else if (!document.hidden && since < 0) since = performance.now();
  });
  return () => (total + (since >= 0 ? performance.now() - since : 0)) / 1000;
}

/**
 * Runs `fn` once, the first time the page is hidden: leaving, closing the tab, switching tab or
 * app. Mobile browsers often skip `pagehide` but always fire `visibilitychange`. Umami sends with
 * `keepalive`, so an event tracked here still arrives while the page unloads.
 */
export function onFirstHide(fn: () => void): void {
  if (typeof document === 'undefined') return;
  let done = false;
  const go = () => { if (done) return; done = true; fn(); };
  document.addEventListener('visibilitychange', () => { if (document.hidden) go(); });
  addEventListener('pagehide', go);
}

/** Should this page load be tracked? */
export function analyticsEnabled(websiteId: string, host: string): boolean {
  return /^[0-9a-f-]{36}$/i.test(websiteId) && host === SITE_HOST;
}

/** Milestones (minutes) passed when active time goes from `fromSec` to `toSec`. */
export function milestonesCrossed(fromSec: number, toSec: number): number[] {
  return MILESTONES.filter((m) => m * 60 > fromSec && m * 60 <= toSec);
}

export function initAnalytics(): void {
  const id = ((import.meta.env?.VITE_UMAMI_ID as string | undefined) ?? '').trim();
  if (typeof document === 'undefined' || !analyticsEnabled(id, location.hostname)) return;

  const s = document.createElement('script');
  s.defer = true;
  s.src = SCRIPT;
  s.dataset.websiteId = id;
  s.dataset.domains = SITE_HOST;
  s.dataset.doNotTrack = 'true'; // honour the browser's Do Not Track setting
  pending = [];
  s.addEventListener('load', () => {
    const q = pending ?? [];
    pending = null; // from now on calls go straight to the script (or nowhere, under Do Not Track)
    for (const c of q) window.umami?.track(...c);
  });
  document.head.appendChild(s);

  let lastInput = Date.now();
  let lastTick = Date.now();
  let activeSec = 0;
  const touch = () => { lastInput = Date.now(); };
  for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) {
    addEventListener(ev, touch, { passive: true, capture: true });
  }
  document.addEventListener('visibilitychange', () => { lastTick = Date.now(); if (!document.hidden) touch(); });

  setInterval(() => {
    const now = Date.now();
    // a throttled background tab can tick late: never count more than one tick per tick
    const dt = Math.min(now - lastTick, TICK_MS) / 1000;
    lastTick = now;
    if (document.hidden || now - lastInput > IDLE_MS) return;
    const before = activeSec;
    activeSec += dt;
    for (const m of milestonesCrossed(before, activeSec)) window.umami?.track(`active ${m} min`);
  }, TICK_MS);
}
