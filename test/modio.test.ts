// mod.io client (src/mods/modio.ts) against a fake mod.io: build settings, the request it sends,
// reading mod.io's JSON defensively, errors, download checks, update detection, and a real mod
// .zip going from a mod.io download into the mod loader. No network.
import { ModioError, downloadMod, forgetModioInstall, installedFromModio, listMods, MAX_MOD_BYTES, modioConfig, modioState, rememberModioInstall, type ModioMod } from '../src/mods/modio';
import { loadMod, zipSource } from '../src/mods/mods';

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
async function rejects(p: Promise<unknown>, check: (e: unknown) => boolean, m: string) {
  try { await p; } catch (e) { assert(check(e), `${m}: wrong error ${e instanceof Error ? e.message : String(e)}`); return; }
  throw new Error(`${m}: did not throw`);
}

interface Fs { readFileSync(p: string): Uint8Array }
const fsName = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ fsName)) as Fs;
const root = new URL('..', import.meta.url).pathname;

const KEY = '0123456789abcdef0123456789abcdef';

// ---- build settings ----
assert(modioConfig({}) === null, 'unset: off');
assert(modioConfig({ gameId: '12', apiKey: 'short' }) === null, 'bad key: off');
assert(modioConfig({ gameId: 'x', apiKey: KEY }) === null, 'bad game id: off');
assert(modioConfig({ gameId: '12', apiKey: KEY, apiUrl: 'http://insecure/v1' }) === null, 'plain HTTP refused');
const cfg = modioConfig({ gameId: '12', apiKey: KEY })!;
assert(cfg.apiUrl === 'https://g-12.modapi.io/v1', `default API path: ${cfg.apiUrl}`);
assert(modioConfig({ gameId: '12', apiKey: KEY, apiUrl: 'https://g-12.test.mod.io/v1/' })!.apiUrl === 'https://g-12.test.mod.io/v1', 'test site path, trailing slash dropped');

// ---- a fake mod.io ----
const zip = new Uint8Array(readFileSync(`${root}public/examples/starter-kit.zip`));
const modJson = (id: number, extra: Record<string, unknown> = {}) => ({
  id, game_id: 12, name: `Mod ${id}`, name_id: `mod-${id}`, summary: 'A board', profile_url: `https://mod.io/g/deadboard/m/mod-${id}`,
  submitted_by: { username: 'maker', name_id: 'maker' },
  logo: { thumb_320x180: `https://thumb.modcdn.io/${id}.png` },
  stats: { downloads_total: 42, ratings_display_text: 'Positive' },
  tags: [{ name: 'Beginner', name_localized: 'Beginner' }],
  date_updated: 1763600000,
  modfile: { id: id * 10, filesize: zip.length, filename: `mod-${id}.zip`, version: '1.0.0', download: { binary_url: `https://files.modcdn.io/${id}.zip`, date_expires: 0 } },
  ...extra,
});
const calls: string[] = [];
const fake = (handler: (url: URL) => Response) => (async (u: string | URL | Request) => {
  const url = new URL(String(u));
  calls.push(url.toString());
  return handler(url);
}) as typeof fetch;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

// ---- listing: the request ----
{
  const f = fake(() => json({ data: [modJson(1), modJson(2, { modfile: null }), modJson(3, { logo: { thumb_320x180: 'javascript:alert(1)' }, profile_url: 'http://x' }), { bogus: true }], result_count: 4, result_offset: 20, result_limit: 20, result_total: 47 }));
  const page = await listMods(cfg, { q: '  reform  ', sort: 'newest', offset: 20, limit: 500 }, f);
  const url = new URL(calls.at(-1)!);
  assert(url.origin + url.pathname === 'https://g-12.modapi.io/v1/games/12/mods', `endpoint: ${url}`);
  const p = url.searchParams;
  assert(p.get('api_key') === KEY && p.get('_offset') === '20' && p.get('_limit') === '100' && p.get('_sort') === '-date_live' && p.get('_q') === 'reform', `query: ${p}`);
  // ---- listing: the answer ----
  assert(page.total === 47 && page.offset === 20, 'paging numbers');
  assert(page.mods.map((m) => m.id).join() === '1,3', `mods without a file or an id are left out: ${page.mods.map((m) => m.id)}`);
  const m = page.mods[0];
  assert(m.name === 'Mod 1' && m.author === 'maker' && m.downloads === 42 && m.rating === 'Positive' && m.tags.join() === 'Beginner', 'fields');
  assert(m.file?.id === 10 && m.file.url === 'https://files.modcdn.io/1.zip' && m.file.version === '1.0.0', 'file');
  assert(page.mods[1].logo === null && page.mods[1].profileUrl === '', 'only https links are kept (they become src / href)');
  await listMods(cfg, {}, f);
  const d = new URL(calls.at(-1)!).searchParams;
  assert(d.get('_sort') === '-downloads_total' && !d.has('_q') && d.get('_limit') === '20', `defaults: ${d}`);
}

// ---- errors ----
await rejects(listMods(cfg, {}, fake(() => json({ error: { code: 429, message: 'Too many requests' } }, 429, { 'retry-after': '30' }))),
  (e) => e instanceof ModioError && e.status === 429 && e.retryAfter === 30, 'rate limit with retry-after');
await rejects(listMods(cfg, {}, fake(() => json({ error: { code: 429 } }, 429, { 'retry-after': '0' }))),
  (e) => e instanceof ModioError && e.retryAfter === 60, 'rolling rate limit: retry after a minute');
await rejects(listMods(cfg, {}, fake(() => json({ error: { code: 401, message: 'Invalid api key' } }, 401))),
  (e) => e instanceof ModioError && e.status === 401 && e.message === 'Invalid api key', 'mod.io message passed on');
await rejects(listMods(cfg, {}, (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch),
  (e) => e instanceof ModioError && e.status === 0, 'offline / blocked = status 0');
{
  const ac = new AbortController();
  ac.abort();
  await rejects(listMods(cfg, { signal: ac.signal }, (async (_u: unknown, init?: RequestInit) => { if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' }); return json({}); }) as typeof fetch),
    (e) => (e as Error).name === 'AbortError', 'a superseded search stays an abort, not an error');
}

// ---- download → the mod loader ----
const listed = (await listMods(cfg, {}, fake(() => json({ data: [modJson(7)], result_total: 1 })))).mods[0];
{
  const bytes = await downloadMod(listed, fake((u) => (u.host === 'files.modcdn.io' ? new Response(zip) : json({}, 404))));
  const mod = await loadMod(await zipSource(bytes, listed.file!.name, 'Installed'));
  assert(mod.boards.length > 0 && mod.manifest.id, 'a mod.io download loads as a mod');
  await rejects(downloadMod(listed, fake(() => new Response(zip.slice(0, 100)))), (e) => e instanceof ModioError && /incomplete/.test(e.message), 'truncated download refused');
  await rejects(downloadMod(listed, fake(() => json({ error: { message: 'gone' } }, 404))), (e) => e instanceof ModioError && e.status === 404, 'missing file');
  await rejects(downloadMod({ ...listed, file: { ...listed.file!, size: MAX_MOD_BYTES + 1 } }, fake(() => new Response(zip))), (e) => e instanceof ModioError && e.status === 413, 'too big: not even fetched');
  await rejects(downloadMod(listed, (async () => { throw new TypeError('CORS'); }) as typeof fetch), (e) => e instanceof ModioError && e.status === 0, 'blocked download = status 0 (the app offers the mod page)');
}

// ---- installed / update state ----
{
  const mem = new Map<string, string>();
  const kv = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  const m = (fileId: number): ModioMod => ({ ...listed, file: { ...listed.file!, id: fileId } });
  assert(modioState(m(70), new Set(), kv) === 'new', 'not installed');
  rememberModioInstall(7, 'starter-kit', 70, kv);
  assert(modioState(m(70), new Set(['starter-kit']), kv) === 'installed', 'installed, same file');
  assert(modioState(m(71), new Set(['starter-kit']), kv) === 'update', 'a newer file: update');
  assert(modioState(m(70), new Set(), kv) === 'new', 'removed from the app: installable again');
  rememberModioInstall(8, 'starter-kit', 80, kv); // same mod, re-uploaded under a new mod.io page
  assert(Object.keys(installedFromModio(kv)).join() === '8', 'one mod.io link per mod');
  forgetModioInstall('starter-kit', kv);
  assert(Object.keys(installedFromModio(kv)).length === 0, 'forgotten on remove');
  assert(Object.keys(installedFromModio({ getItem: () => '{broken', setItem: () => {} })).length === 0, 'damaged storage reads as empty');
}

console.log('modio: ok (settings, request, defensive parsing, errors, download → loader, update state)');
