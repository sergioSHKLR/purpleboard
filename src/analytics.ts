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

/**
 * The bench's own events: which board was opened and fixed, and finishing the tutorial. Ids only
 * for boards that ship with the game; anything the player imported or made is just "custom".
 * No-ops wherever analytics is off (the Umami script then never loaded): dev, forks, the apps.
 */
export function trackEvent(name: string, data?: Record<string, string | number>): void {
  if (typeof window !== 'undefined') window.umami?.track(name, data);
}

/**
 * Opening another board counts as a page view ("/board/<id>"): the bench is one page, so without
 * this Umami calls every visit that stays on the bench a bounce, however long the player stays.
 */
export function trackBoardView(boardId: string, title: string): void {
  if (typeof window !== 'undefined') window.umami?.track((p) => ({ ...p, url: `/board/${boardId}`, title }));
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
