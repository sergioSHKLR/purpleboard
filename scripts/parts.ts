// Local part-data pipeline for realistic testing of any board (developer tool, never shipped).
// Everything it downloads stays in .parts-cache/ (git-ignored): datasheets are copyrighted and
// only read locally to verify the device library (src/spice/devicelib.ts, src/spice/regulators.ts).
//
//   npm run parts -- fetch-db                      # jlcparts catalogue (JLCPCB / LCSC, ~330 MB download, needs 7zz)
//   npm run parts -- lookup <board file | MPN…>    # catalogue match, datasheet link, library coverage
//   npm run parts -- datasheets <board file | MPN…># download the matched datasheets (plain requests)
//   npm run parts -- extract <pdf> [MPN]          # table rows (Min/Typ/Max kept apart) + a draft devicelib entry to review
//
// Lookup order: jlcparts (local) → Digi-Key API → Mouser API, the APIs only for parts the catalogue
// lacks or has no datasheet link for, and only when their keys are in .env.local (git-ignored):
//   DIGIKEY_CLIENT_ID=…  DIGIKEY_CLIENT_SECRET=…   (developer.digikey.com, Product Information v4 app)
//   MOUSER_API_KEY=…                               (mouser.com/api-hub, Search API key)
// The APIs receive part numbers only. No VITE_ prefix: Vite never puts these in the app bundle.
//
// Catalogue: https://yaqwsx.github.io/jlcparts (MIT code; data from JLCPCB's parts list). Its
// "attributes" are distributor summaries that mix typical and maximum values: use them to identify
// a part, never as typicals; numbers for the library come from the datasheet PDF.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { importScenarioOrPcb } from '../src/io/kicad';
import { boardPartNumbers, rankCatalogue, searchPrefixes, type BoardPart } from '../src/io/partNumbers';
import { findDevice } from '../src/spice/devicelib';
import { findRegulator } from '../src/spice/regulators';
import { draftEntry, extractRows, seriesRows } from '../src/io/datasheetTable';
import { DIGIKEY, MOUSER, cleanUrl, parseDigikey, parseMouser, type PartRecord } from '../src/io/distributors';

const CACHE = '.parts-cache';
const DB_DIR = join(CACHE, 'jlcparts');
const DB = join(DB_DIR, 'cache.sqlite3');
const SHEETS = join(CACHE, 'datasheets');
const REPORTS = join(CACHE, 'reports');
const DATA_URL = 'https://yaqwsx.github.io/jlcparts/data';

type Match = PartRecord;
interface Row extends BoardPart { match: Match | null; library: string; sheet?: string; note?: string }

/** KEY=VALUE lines of .env.local (no shell expansion), without overriding the real environment. */
function loadEnvLocal() {
  if (!existsSync('.env.local')) return;
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

let dkToken: { value: string; until: number } | null = null;
async function digikeyToken(): Promise<string | null> {
  const id = process.env.DIGIKEY_CLIENT_ID, secret = process.env.DIGIKEY_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (dkToken && Date.now() < dkToken.until) return dkToken.value;
  const r = await fetch(DIGIKEY.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'client_credentials' }) });
  if (!r.ok) throw new Error(`Digi-Key token: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as { access_token: string; expires_in?: number };
  dkToken = { value: j.access_token, until: Date.now() + Math.max(60, (j.expires_in ?? 600) - 60) * 1000 };
  return dkToken.value;
}

async function lookupDigikey(pn: string): Promise<Match | null> {
  const token = await digikeyToken();
  if (!token) return null;
  const headers = { Authorization: `Bearer ${token}`, 'X-DIGIKEY-Client-Id': process.env.DIGIKEY_CLIENT_ID!, 'X-DIGIKEY-Locale-Site': 'US', 'X-DIGIKEY-Locale-Language': 'en', 'X-DIGIKEY-Locale-Currency': 'USD', Accept: 'application/json' };
  const d = await fetch(DIGIKEY.details(pn), { headers });
  if (d.ok) { const m = parseDigikey(await d.json(), pn); if (m) return m; }
  else if (d.status !== 404) throw new Error(`Digi-Key: HTTP ${d.status} ${(await d.text()).slice(0, 200)}`);
  const k = await fetch(DIGIKEY.keyword, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ Keywords: pn, Limit: 10 }) });
  if (!k.ok) throw new Error(`Digi-Key search: HTTP ${k.status} ${(await k.text()).slice(0, 200)}`);
  return parseDigikey(await k.json(), pn);
}

async function lookupMouser(pn: string): Promise<Match | null> {
  const key = process.env.MOUSER_API_KEY;
  if (!key) return null;
  const r = await fetch(MOUSER.partnumber(key), { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(MOUSER.body(pn)) });
  if (!r.ok) throw new Error(`Mouser: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return parseMouser(await r.json(), pn);
}

/** jlcparts first; the distributor APIs when it has no match or no datasheet link. */
async function lookup(value: string): Promise<{ match: Match | null; note?: string }> {
  const local = lookupOne(value);
  const notes: string[] = [];
  // the catalogue matched only a shortened number: the full ordering code names the maker
  // ("-G3-08", "-E3/61" are Vishay codes), so ask Digi-Key for exactly that first
  const full = value.toUpperCase();
  if (local && !local.mfr.toUpperCase().startsWith(full) && full !== searchPrefixes(value).at(-1)) {
    try {
      const m = await lookupDigikey(full);
      if (m?.datasheet && m.mfr.toUpperCase().startsWith(full)) return { match: m, note: `full ordering code; jlcparts only had ${local.mfr} (${local.manufacturer})` };
    } catch (e) { notes.push(String(e instanceof Error ? e.message : e)); }
  }
  if (local?.datasheet) return { match: local, ...(notes.length && { note: notes.join(' · ') }) };
  for (const [name, f] of [['Digi-Key', lookupDigikey], ['Mouser', lookupMouser]] as const) {
    for (const p of searchPrefixes(value)) {
      try {
        const m = await f(p);
        if (m) return { match: m, ...(local && { note: `jlcparts ${local.id} has no datasheet link` }) };
      } catch (e) { notes.push(String(e instanceof Error ? e.message : e)); break; }
    }
  }
  if (!process.env.MOUSER_API_KEY && !process.env.DIGIKEY_CLIENT_ID) notes.push('no distributor API keys in .env.local');
  return { match: local, ...(notes.length && { note: notes.join(' · ') }) };
}

const out = (s: string) => process.stdout.write(s + '\n');

async function fetchDb() {
  mkdirSync(DB_DIR, { recursive: true });
  if (spawnSync('7zz', ['--help'], { encoding: 'utf8' }).error) throw new Error('7-Zip is needed to join the split archive: brew install sevenzip');
  const names = ['cache.zip'];
  for (let i = 1; i < 100; i++) names.push(`cache.z${String(i).padStart(2, '0')}`);
  for (const n of names) {
    const r = await fetch(`${DATA_URL}/${n}`);
    if (r.status === 404 && n !== 'cache.zip') break;
    if (!r.ok) throw new Error(`${n}: HTTP ${r.status}`);
    writeFileSync(join(DB_DIR, n), new Uint8Array(await r.arrayBuffer()));
    out(`  ${n}`);
  }
  execFileSync('7zz', ['x', '-y', 'cache.zip'], { cwd: DB_DIR, stdio: 'ignore' });
  execFileSync('sqlite3', [DB, 'CREATE INDEX IF NOT EXISTS idx_mfr ON jlc_components(mfr);']);
  out(`catalogue ready: ${DB}`);
}

function sql(query: string): Record<string, unknown>[] {
  const r = spawnSync('sqlite3', ['-json', DB, query], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : [];
}

function lookupOne(value: string): Match | null {
  for (const p of searchPrefixes(value)) {
    const safe = p.replace(/[^A-Z0-9.\-/+#,]/g, '');
    const rows = sql(`select lcsc, mfr, manufacturer, package, datasheet, description, attributes from jlc_components
      where mfr like '${safe}%' order by (upper(mfr) = '${safe}') desc, (datasheet != '') desc, length(mfr) limit 60`) as Record<string, string>[];
    const r = rankCatalogue(p, rows);
    if (r) return { source: 'jlcparts', id: `C${r.lcsc}`, mfr: r.mfr, manufacturer: r.manufacturer, package: r.package, datasheet: cleanUrl(r.datasheet), description: r.description, attributes: JSON.parse(r.attributes || '{}') };
  }
  return null;
}

function libraryCoverage(value: string): string {
  const d = findDevice(value);
  if (d) return d.verified ? `devicelib ${d.mpn}: datasheet-verified` : `devicelib ${d.mpn}: unverified`;
  const r = findRegulator(value);
  if (r) return `regulators ${r.mpn}: datasheet values`;
  return 'not in the library (generic model / omitted)';
}

/** Board file → its part numbers; otherwise the arguments are part numbers. */
function partsOf(args: string[]): { name: string; parts: BoardPart[] } {
  if (args.length === 1 && existsSync(args[0])) {
    const sc = importScenarioOrPcb(args[0].replace(/^.*[\\/]/, ''), readFileSync(args[0]));
    return { name: args[0].replace(/^.*[\\/]/, '').replace(/(\.pcbfix\.json|\.[^.]+)$/i, ''), parts: boardPartNumbers(sc.board) };
  }
  return { name: 'parts', parts: args.map((v) => ({ value: v, refs: [], kind: '?' })) };
}

async function download(m: Match): Promise<string> {
  mkdirSync(SHEETS, { recursive: true });
  const file = join(SHEETS, `${m.mfr.replace(/[^A-Za-z0-9.\-]/g, '_')}.pdf`);
  if (existsSync(file)) return `cached ${file}`;
  if (!m.datasheet) return 'no datasheet link in the catalogue';
  const r = await fetch(m.datasheet, { redirect: 'follow' });
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (!r.ok) return `HTTP ${r.status}`;
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') return `link is not a PDF (${m.datasheet}): open it in a browser`;
  writeFileSync(file, bytes);
  return `saved ${file}`;
}

/** Datasheet → table rows and a draft library entry, for a person to check against the PDF. */
function extract(file: string, mpnArg?: string) {
  const text = file.endsWith('.txt') ? readFileSync(file, 'utf8') : execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
  const mpn = mpnArg ?? file.replace(/^.*[\\/]/, '').replace(/\.(pdf|txt)$/i, '').replace(/_\d+$/, '');
  const rows = extractRows(text);
  out(`${file}: ${rows.length} table rows (values scaled to SI; hot = not at 25 °C, left out of the draft)`);
  for (const r of rows) {
    const f = (v?: number) => (v === undefined ? '—' : String(v)).padStart(10);
    out(`  ${String(r.line).padStart(4)}  ${r.quantity.padEnd(6)} ${r.symbol.padEnd(9)} min${f(r.min)} typ${f(r.typ)} max${f(r.max)} ${(r.unit || '-').padEnd(5)} ${r.unitSource.startsWith('assumed') ? '(unit assumed) ' : ''}${r.hot ? 'HOT ' : ''}${r.condText.slice(0, 70)}`);
  }
  const series = seriesRows(text, mpn);
  if (series.length) {
    out(`\nseries-table rows naming ${mpn} (map the columns by hand):`);
    for (const s of series.slice(0, 3)) out([...s.header.map((h) => `        ${h.trimEnd()}`), `  ${String(s.line).padStart(4)}  ${s.row.trimEnd()}`].join('\n'));
  }
  const d = draftEntry(mpn, text, rows);
  out(`\ndraft (${d.kind}; verified stays false until every TODO and review item is checked against the PDF):\n${d.entry}\nreview:\n${d.review.map((x) => `  - ${x}`).join('\n')}`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'fetch-db') return fetchDb();
  if (cmd === 'extract' && args.length) return extract(args[0], args[1]);
  if ((cmd !== 'lookup' && cmd !== 'datasheets') || !args.length) {
    out('usage: npm run parts -- fetch-db | lookup <board file | MPN…> | datasheets <board file | MPN…> | extract <pdf|txt> [MPN]');
    process.exitCode = 1;
    return;
  }
  if (!existsSync(DB)) throw new Error(`no catalogue at ${DB}: run npm run parts -- fetch-db`);
  loadEnvLocal();
  const { name, parts } = partsOf(args);
  const rows: Row[] = [];
  for (const p of parts) {
    const found = await lookup(p.value);
    const row: Row = { ...p, match: found.match, library: libraryCoverage(p.value), ...(found.note && { note: found.note }) };
    if (cmd === 'datasheets' && row.match) row.sheet = await download(row.match);
    rows.push(row);
    const m = row.match;
    out(`${p.value.padEnd(24)} ${(p.refs.slice(0, 4).join(',') + (p.refs.length > 4 ? '…' : '')).padEnd(18)} ${m ? `${m.source.padEnd(9)} ${m.id.padEnd(14)} ${m.mfr} · ${m.package}` : '— not found'}`);
    out(`${''.padEnd(24)} ${row.library}${row.sheet ? ` · ${row.sheet}` : m?.datasheet ? ` · ${m.datasheet}` : ''}${row.note ? ` · (${row.note})` : ''}`);
  }
  mkdirSync(REPORTS, { recursive: true });
  const file = join(REPORTS, `${name}.json`);
  writeFileSync(file, JSON.stringify({ generated: new Date().toISOString(), note: 'attributes are distributor summaries (mixed typical / maximum values), not datasheet typicals', rows }, null, 2));
  const found = rows.filter((r) => r.match).length;
  out(`\n${found}/${rows.length} part numbers found (${['jlcparts', 'digikey', 'mouser'].map((s) => `${s} ${rows.filter((r) => r.match?.source === s).length}`).join(', ')}); ${rows.filter((r) => /verified|regulators/.test(r.library) && !/unverified/.test(r.library)).length} have datasheet-checked library data. Report: ${file}`);
}

main().catch((e) => { out(String(e?.stack ?? e)); process.exitCode = 1; });
