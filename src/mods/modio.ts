// mod.io: the online mod hub (https://mod.io). Browsing and downloading need only the game's
// read-only API key, no player account. The game is set at build time, never in the source:
//   VITE_MODIO_GAME_ID   the game's numeric id on mod.io
//   VITE_MODIO_API_KEY   its read-only API key (32 characters; mod.io issues it for client use)
//   VITE_MODIO_API_URL   optional: the "API path" from the mod.io dashboard. Default
//                        https://g-<id>.modapi.io/v1; for the test site use https://g-<id>.test.mod.io/v1
// Unset: the Browse tab is not shown and the app never contacts mod.io.
// mod.io's API answers browsers from any origin (Access-Control-Allow-Origin: *), so the website,
// the desktop app and the iOS app all call it directly. Mods are DEADBOARD .zip files
// (deadboard-mod/1), installed through the same path as a .zip the player picks.

export interface ModioConfig { gameId: number; apiKey: string; apiUrl: string }

const env = (k: string) => ((import.meta.env?.[k] as string | undefined) ?? '').trim();

/** Build-time settings, or null when mod.io is not set up for this build. */
export function modioConfig(vars: Record<string, string | undefined> = {
  gameId: env('VITE_MODIO_GAME_ID'), apiKey: env('VITE_MODIO_API_KEY'), apiUrl: env('VITE_MODIO_API_URL'),
}): ModioConfig | null {
  const gameId = Number(vars.gameId);
  const apiKey = vars.apiKey ?? '';
  if (!Number.isInteger(gameId) || gameId <= 0 || !/^[0-9a-f]{32}$/i.test(apiKey)) return null;
  const apiUrl = (vars.apiUrl || `https://g-${gameId}.modapi.io/v1`).replace(/\/+$/, '');
  if (!/^https:\/\//.test(apiUrl)) return null; // mod.io refuses plain HTTP
  return { gameId, apiKey, apiUrl };
}

export interface ModioMod {
  id: number;
  nameId: string;
  name: string;
  summary: string;
  author: string;
  /** 320×180 logo, when the mod has one. */
  logo: string | null;
  profileUrl: string;
  downloads: number;
  /** mod.io's own rating summary ("Very Positive", …), when it has one. */
  rating: string;
  updated: number;
  tags: string[];
  /** The live file; null while a mod has none (nothing to install). */
  file: { id: number; url: string; size: number; version: string; name: string } | null;
}

export type ModioSort = 'downloads' | 'newest' | 'rating' | 'updated';
const SORT: Record<ModioSort, string> = {
  downloads: '-downloads_total',
  newest: '-date_live',
  rating: '-ratings_weighted_aggregate',
  updated: '-date_updated',
};

export interface ModioPage { mods: ModioMod[]; total: number; offset: number }

/** A request mod.io refused or that never reached it; `status` 0 = network / blocked by the browser. */
export class ModioError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter?: number) { super(message); }
}

type Fetch = typeof fetch;

// mod.io JSON, read field by field (anything missing or of the wrong type becomes empty)
const str = (v: any) => (typeof v === 'string' ? v : '');
const num = (v: any) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function toMod(m: any): ModioMod {
  const f = m?.modfile;
  const url = str(f?.download?.binary_url);
  return {
    id: num(m?.id),
    nameId: str(m?.name_id),
    name: str(m?.name) || `#${num(m?.id)}`,
    summary: str(m?.summary),
    author: str(m?.submitted_by?.username),
    logo: /^https:\/\//.test(str(m?.logo?.thumb_320x180)) ? str(m.logo.thumb_320x180) : null,
    profileUrl: /^https:\/\//.test(str(m?.profile_url)) ? str(m.profile_url) : '',
    downloads: num(m?.stats?.downloads_total),
    rating: str(m?.stats?.ratings_display_text),
    updated: num(m?.date_updated),
    tags: Array.isArray(m?.tags) ? m.tags.map((x: any) => str(x?.name)).filter(Boolean) : [],
    file: f && /^https:\/\//.test(url) ? { id: num(f.id), url, size: num(f.filesize), version: str(f.version), name: str(f.filename) } : null,
  };
}

async function errorOf(res: Response): Promise<ModioError> {
  let msg = `HTTP ${res.status}`;
  try {
    const j = (await res.json()) as { error?: { message?: string } };
    if (j.error?.message) msg = j.error.message;
  } catch { /* not JSON */ }
  const ra = Number(res.headers.get('retry-after'));
  return new ModioError(msg, res.status, res.status === 429 ? (ra > 0 ? ra : 60) : undefined);
}

/** One page of the game's mods. Mods without a file are left out (there is nothing to install). */
export async function listMods(cfg: ModioConfig, o: { q?: string; sort?: ModioSort; offset?: number; limit?: number; signal?: AbortSignal } = {}, f: Fetch = fetch): Promise<ModioPage> {
  const p = new URLSearchParams({
    api_key: cfg.apiKey,
    _limit: String(Math.min(100, Math.max(1, o.limit ?? 20))),
    _offset: String(Math.max(0, o.offset ?? 0)),
    _sort: SORT[o.sort ?? 'downloads'],
  });
  const q = o.q?.trim();
  if (q) p.set('_q', q.slice(0, 100));
  let res: Response;
  try {
    res = await f(`${cfg.apiUrl}/games/${cfg.gameId}/mods?${p}`, { signal: o.signal, headers: { Accept: 'application/json' } });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    throw new ModioError(e instanceof Error ? e.message : String(e), 0);
  }
  if (!res.ok) throw await errorOf(res);
  const j = (await res.json()) as { data?: unknown[]; result_total?: number; result_offset?: number };
  const mods = (Array.isArray(j.data) ? j.data : []).map(toMod).filter((m) => m.id > 0 && m.file);
  return { mods, total: num(j.result_total), offset: num(j.result_offset) };
}

/** Largest mod file the app downloads (boards, BOMs and schematic PDFs; mod.io allows 500 MB). */
export const MAX_MOD_BYTES = 100 * 1024 * 1024;

/** The mod's live .zip. Throws ModioError(status 0) when the download is blocked or offline. */
export async function downloadMod(m: ModioMod, f: Fetch = fetch): Promise<Uint8Array> {
  if (!m.file) throw new ModioError('this mod has no file yet', 404);
  if (m.file.size > MAX_MOD_BYTES) throw new ModioError(`the file is ${(m.file.size / 1048576).toFixed(0)} MB; the limit is ${MAX_MOD_BYTES / 1048576} MB`, 413);
  let res: Response;
  try {
    res = await f(m.file.url);
  } catch (e) {
    throw new ModioError(e instanceof Error ? e.message : String(e), 0);
  }
  if (!res.ok) throw await errorOf(res);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_MOD_BYTES) throw new ModioError('the file is too big', 413);
  if (m.file.size && bytes.length !== m.file.size) throw new ModioError(`download incomplete (${bytes.length} of ${m.file.size} bytes)`, 0);
  return bytes;
}

// ---- which mod.io file each installed mod came from (to offer updates) ----

const STORE_KEY = 'deadboard_modio_installed';
/** mod.io mod id → the DEADBOARD mod id it installed and the mod.io file it came from. */
export type InstalledFromModio = Record<string, { modId: string; fileId: number }>;

interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void }
const store = (): KV | null => { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } };

export function installedFromModio(kv: KV | null = store()): InstalledFromModio {
  try { return JSON.parse(kv?.getItem(STORE_KEY) ?? '{}') as InstalledFromModio; } catch { return {}; }
}

export function rememberModioInstall(modioId: number, modId: string, fileId: number, kv: KV | null = store()) {
  const all = installedFromModio(kv);
  // one mod.io entry per DEADBOARD mod: a re-upload under a new mod.io page replaces the old link
  for (const k of Object.keys(all)) if (all[k].modId === modId) delete all[k];
  all[modioId] = { modId, fileId };
  try { kv?.setItem(STORE_KEY, JSON.stringify(all)); } catch { /* storage unavailable: no update hints */ }
}

export function forgetModioInstall(modId: string, kv: KV | null = store()) {
  const all = installedFromModio(kv);
  for (const k of Object.keys(all)) if (all[k].modId === modId) delete all[k];
  try { kv?.setItem(STORE_KEY, JSON.stringify(all)); } catch { /* storage unavailable */ }
}

/** A mod.io listing's state here: not installed, installed and current, or an update waiting. */
export function modioState(m: ModioMod, installedIds: ReadonlySet<string>, kv: KV | null = store()): 'new' | 'installed' | 'update' {
  const rec = installedFromModio(kv)[m.id];
  if (!rec || !installedIds.has(rec.modId)) return 'new';
  return m.file && m.file.id !== rec.fileId ? 'update' : 'installed';
}
