// Reading the website's Umami Cloud numbers from scripts. Umami Cloud's free plan has no API key,
// so this drives a logged-in browser: Chrome with remote debugging on port 9333 and its own
// profile in ~/.deadboard/umami-profile (outside the repo). The first time, log in to
// cloud.umami.is in the window that opens; the login is kept. Requests run inside the Umami tab
// with the page's own token, which is never printed.
//
//   npm run umami -- stats [--days 7]                     visitors, visits, bounce, time
//   npm run umami -- events [--days 7]                    event counts
//   npm run umami -- values "<event>" <property> [--days 7]
//   npm run umami -- home [--days 7]                      where homepage visits end, per device
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WEBSITE = 'f87071cc-1be3-4f31-9d52-a80861fa7e40';
const API = 'https://gateway-eu.umami.is/api';
const PORT = 9333;
const PROFILE = join(homedir(), '.deadboard', 'umami-profile');
const CHROMES = [
  process.env.CHROME_PATH ?? '',
  join(homedir(), 'Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter((p) => p && existsSync(p));

interface Tab { type: string; url: string; webSocketDebuggerUrl: string }
const tabs = async (): Promise<Tab[] | null> => { try { return (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()) as Tab[]; } catch { return null; } };

/** The Umami tab, launching the browser (and waiting for a login) when needed. */
async function umamiTab(): Promise<Tab> {
  let list = await tabs();
  if (!list) {
    if (!CHROMES.length) throw new Error('No Chrome found (set CHROME_PATH).');
    spawn(CHROMES[0], [`--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run', 'https://cloud.umami.is/'], { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 30 && !(list = await tabs()); i++) await new Promise((r) => setTimeout(r, 500));
  }
  for (let i = 0; i < 180; i++) {
    const tab = (list ?? []).find((t) => t.type === 'page' && t.url.startsWith('https://cloud.umami.is/'));
    if (tab && (await evaluate(tab, "!!localStorage.getItem('umami.auth')"))) return tab;
    if (i === 0) console.error('Waiting for a login to cloud.umami.is in the browser window…');
    await new Promise((r) => setTimeout(r, 2000));
    list = await tabs();
  }
  throw new Error('No logged-in cloud.umami.is tab.');
}

async function evaluate<T>(tab: Tab, expression: string): Promise<T> {
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  return new Promise<T>((resolve, reject) => {
    ws.onmessage = (m) => {
      const d = JSON.parse(String(m.data));
      if (d.id !== 1) return;
      ws.close();
      if (d.result?.exceptionDetails) reject(new Error(d.result.exceptionDetails.text));
      else resolve(d.result?.result?.value as T);
    };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
}

let tabP: Promise<Tab> | null = null;
/** GET /api/websites/<id>/<path> (or an absolute /api path) with query parameters; POST when `body` is given. */
export async function umami<T>(path: string, params: Record<string, string | number> = {}, body?: unknown): Promise<T> {
  const tab = await (tabP ??= umamiTab());
  const u = new URL(path.startsWith('/') ? `${API}${path}` : `${API}/websites/${WEBSITE}/${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const js = `(async () => {
    let t = localStorage.getItem('umami.auth'); try { t = JSON.parse(t); } catch {}
    const o = { headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' } };
    ${body === undefined ? '' : `o.method = 'POST'; o.body = ${JSON.stringify(JSON.stringify(body))};`}
    const r = await fetch(${JSON.stringify(u.toString())}, o);
    return JSON.stringify({ status: r.status, body: await r.text() });
  })()`;
  const res = JSON.parse(await evaluate<string>(tab, js)) as { status: number; body: string };
  if (res.status !== 200) throw new Error(`Umami ${path}: HTTP ${res.status} ${res.body.slice(0, 200)}`);
  return JSON.parse(res.body) as T;
}

const val = (s: Record<string, unknown>, k: string) => Number(typeof s[k] === 'object' ? (s[k] as { value: number }).value : s[k]);

/** Event counts (name → total) between two times (ms). */
export async function eventCounts(startAt: number, endAt: number): Promise<Map<string, number>> {
  const m = await umami<{ x: string; y: number }[]>('metrics', { startAt, endAt, type: 'event', limit: 200 });
  return new Map(m.map((r) => [r.x, r.y]));
}

/** Totals per value of an event property (e.g. "board fixed" → board). */
export async function eventValues(event: string, property: string, startAt: number, endAt: number): Promise<Map<string, number>> {
  const r = await umami<{ value: string; total: number }[]>('event-data/values', { startAt, endAt, event, propertyName: property });
  return new Map(r.map((x) => [String(x.value), x.total]));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, a, b] = process.argv.slice(2).filter((x, i, all) => !x.startsWith('--') && all[i - 1] !== '--days');
  const d = process.argv.indexOf('--days');
  const endAt = Date.now(), startAt = endAt - ((d >= 0 && Number(process.argv[d + 1])) || 7) * 86_400_000;
  if (cmd === 'stats') {
    const s = await umami<Record<string, unknown>>('stats', { startAt, endAt });
    const v = val(s, 'visits');
    console.log(`visitors ${val(s, 'visitors')} · visits ${v} · page views ${val(s, 'pageviews')} · bounce ${v ? Math.round((100 * val(s, 'bounces')) / v) : '-'}% · avg visit ${v ? Math.round(val(s, 'totaltime') / v) : '-'} s`);
  } else if (cmd === 'events') {
    for (const [k, n] of [...(await eventCounts(startAt, endAt))].sort((x, y) => y[1] - x[1])) console.log(`${String(n).padStart(6)}  ${k}`);
  } else if (cmd === 'values' && a && b) {
    for (const [k, n] of [...(await eventValues(a, b, startAt, endAt))].sort((x, y) => y[1] - x[1])) console.log(`${String(n).padStart(6)}  ${k}`);
  } else if (cmd === 'home') {
    // the homepage leave report: where visits ended, per device (the "home left" event)
    for (const device of ['mobile', 'laptop', 'desktop']) {
      const r = await umami<{ value: string; total: number }[]>('event-data/values', { startAt, endAt, event: 'home left', propertyName: 'exit', device });
      const total = r.reduce((a, x) => a + x.total, 0);
      if (!total) continue;
      console.log(`\n${device}: ${total} homepage visits`);
      for (const x of r.sort((p, q) => q.total - p.total).slice(0, 12)) console.log(`${String(x.total).padStart(6)}  ${String(Math.round((100 * x.total) / total)).padStart(3)}%  ${x.value}`);
      for (const prop of ['shown', 'touched', 'teaser', 'via']) {
        const v = await umami<{ value: string; total: number }[]>('event-data/values', { startAt, endAt, event: 'home left', propertyName: prop, device });
        console.log(`  ${prop}: ${v.sort((p, q) => q.total - p.total).map((x) => `${x.value} ${x.total}`).join(' · ')}`);
      }
    }
  } else {
    console.log('npm run umami -- stats | events | home | values "<event>" <property>   [--days N]');
  }
}
