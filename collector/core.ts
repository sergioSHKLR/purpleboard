// DEADBOARD's puzzle-statistics collector, the logic (collector/worker.ts is the Worker entry; a
// Worker module may export only handlers). D1 database: collector/schema.sql; README.md.
//
// POST /v1/attempt with one attempt record (src/attempts/record.ts) as a text body. It stores only
// records that pass `checkRecord`, plus the UTC day. It never reads or stores the IP address or
// any other request header beyond Origin and Content-Length, and it logs nothing (observability is
// off in wrangler.toml). A daily cap keeps it inside the free plan whatever is sent to it.
// A daily cron erases attempt tokens older than a day and folds rows older than 90 days into totals.

import { checkRecord, FIELDS, MAX_BYTES, type AttemptRecord } from '../src/attempts/record';

/** What the worker needs from storage (D1 in production, a fake in test/attempts.test.ts). */
export interface Store {
  /** Rows accepted so far on `day`. */
  accepted(day: string): Promise<number>;
  /** Insert, or replace the row with the same attempt token. */
  put(rec: AttemptRecord, day: string): Promise<void>;
  /** Daily upkeep (see the top of this file). */
  maintain(today: string): Promise<void>;
}

export interface Config {
  /** The only page origin accepted, e.g. "https://deadboard.org". */
  origin: string;
  /** Rows accepted per UTC day at most. */
  cap: number;
}

const cors = (origin: string): Record<string, string> => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'POST',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin',
});

const reply = (status: number, cfg: Config, text = '') =>
  new Response(text || null, { status, headers: { ...cors(cfg.origin), 'Cache-Control': 'no-store', ...(text ? { 'Content-Type': 'text/plain' } : {}) } });

export async function handle(req: Request, store: Store, cfg: Config, now = new Date()): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname !== '/v1/attempt') return reply(404, cfg);
  if (req.method === 'OPTIONS') return reply(204, cfg);
  if (req.method !== 'POST') return reply(405, cfg);
  if (req.headers.get('Origin') !== cfg.origin) return reply(403, cfg);
  const len = Number(req.headers.get('Content-Length') ?? 'NaN');
  if (Number.isFinite(len) && len > MAX_BYTES) return reply(413, cfg);
  const text = await readCapped(req, MAX_BYTES);
  if (text === null) return reply(413, cfg);
  let body: unknown;
  try { body = JSON.parse(text); } catch { return reply(400, cfg, 'json'); }
  const rec = checkRecord(body);
  if (typeof rec === 'string') return reply(400, cfg, rec);
  const day = now.toISOString().slice(0, 10);
  if ((await store.accepted(day)) >= cfg.cap) return reply(429, cfg);
  await store.put(rec, day);
  return reply(204, cfg);
}

/** The body as text, or null when it is longer than `max` bytes (stops reading there). */
async function readCapped(req: Request, max: number): Promise<string | null> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { void reader.cancel(); return null; }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.byteLength; }
  return new TextDecoder().decode(all);
}

/** Days ago, as YYYY-MM-DD. */
export function dayBefore(today: string, days: number): string {
  return new Date(Date.parse(`${today}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

/** Raw rows are kept this many days, then only `totals`. */
export const KEEP_DAYS = 90;

// ---- D1 -----------------------------------------------------------------------------------------

export interface D1Stmt { bind(...v: unknown[]): D1Stmt; run(): Promise<unknown>; first<T>(): Promise<T | null> }
export interface D1 { prepare(sql: string): D1Stmt; batch(s: D1Stmt[]): Promise<unknown> }
export interface Env { DB: D1; ALLOWED_ORIGIN: string; DAILY_CAP: string }

/** Column of each record field in collector/schema.sql. */
const COLUMN: Record<(typeof FIELDS)[number], string> = Object.fromEntries(FIELDS.map((f) => [f, f])) as never;
COLUMN.from = 'src';
COLUMN.firstTest = 'first_test';

export function d1Store(db: D1): Store {
  const cols = ['day', ...FIELDS.map((f) => COLUMN[f])];
  const insert = `INSERT INTO attempts (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
    ON CONFLICT(attempt) DO UPDATE SET ${cols.filter((c) => c !== 'attempt' && c !== 'day').map((c) => `${c} = excluded.${c}`).join(', ')}`;
  return {
    async accepted(day) {
      return (await db.prepare('SELECT n FROM daily_count WHERE day = ?').bind(day).first<{ n: number }>())?.n ?? 0;
    },
    async put(rec, day) {
      const values = [day, ...FIELDS.map((f) => (f === 'tools' ? rec.tools.join(',') : rec[f]))];
      await db.batch([
        db.prepare(insert).bind(...values),
        db.prepare('INSERT INTO daily_count (day, n) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1').bind(day),
      ]);
    },
    async maintain(today) {
      const tokenCut = dayBefore(today, 1), keepCut = dayBefore(today, KEEP_DAYS);
      await db.batch([
        db.prepare('UPDATE attempts SET attempt = NULL WHERE attempt IS NOT NULL AND day < ?').bind(tokenCut),
        db.prepare(`INSERT INTO totals (day, puzzle, src, layout, outcome, n)
          SELECT day, puzzle, src, layout, outcome, COUNT(*) FROM attempts WHERE day < ? GROUP BY day, puzzle, src, layout, outcome
          ON CONFLICT(day, puzzle, src, layout, outcome) DO UPDATE SET n = n + excluded.n`).bind(keepCut),
        db.prepare('DELETE FROM attempts WHERE day < ?').bind(keepCut),
        db.prepare('DELETE FROM daily_count WHERE day < ?').bind(keepCut),
      ]);
    },
  };
}

export const config = (env: Env): Config => ({ origin: env.ALLOWED_ORIGIN, cap: Math.max(0, Number(env.DAILY_CAP) || 0) });
