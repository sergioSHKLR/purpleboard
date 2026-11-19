// Local part-data pipeline for realistic testing of any board (developer tool, never shipped).
// Everything it downloads stays in .parts-cache/ (git-ignored): datasheets are copyrighted and
// only read locally to verify the device library (src/spice/devicelib.ts, src/spice/regulators.ts).
//
//   npm run parts -- fetch-db                      # jlcparts catalogue (JLCPCB / LCSC, ~330 MB download, needs 7zz)
//   npm run parts -- lookup <board file | MPN…>    # catalogue match, datasheet link, library coverage
//   npm run parts -- datasheets <board file | MPN…># download the matched datasheets (plain requests)
//
// Catalogue: https://yaqwsx.github.io/jlcparts (MIT code; data from JLCPCB's parts list). Its
// "attributes" are distributor summaries that mix typical and maximum values: use them to identify
// a part, never as typicals; numbers for the library come from the datasheet PDF.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { importScenarioOrPcb } from '../src/io/kicad';
import { boardPartNumbers, searchPrefixes, type BoardPart } from '../src/io/partNumbers';
import { findDevice } from '../src/spice/devicelib';
import { findRegulator } from '../src/spice/regulators';

const CACHE = '.parts-cache';
const DB_DIR = join(CACHE, 'jlcparts');
const DB = join(DB_DIR, 'cache.sqlite3');
const SHEETS = join(CACHE, 'datasheets');
const REPORTS = join(CACHE, 'reports');
const DATA_URL = 'https://yaqwsx.github.io/jlcparts/data';

interface Match { lcsc: string; mfr: string; manufacturer: string; package: string; datasheet: string; description: string; attributes: Record<string, string> }
interface Row extends BoardPart { match: Match | null; library: string; sheet?: string }

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
    const safe = p.replace(/[^A-Z0-9.\-/+#]/g, '');
    const rows = sql(`select lcsc, mfr, manufacturer, package, datasheet, description, attributes from jlc_components
      where mfr like '${safe}%' order by (upper(mfr) = '${safe}') desc, (datasheet != '') desc, length(mfr) limit 1`);
    if (rows.length) {
      const r = rows[0] as Record<string, string>;
      return { lcsc: `C${r.lcsc}`, mfr: r.mfr, manufacturer: r.manufacturer, package: r.package, datasheet: r.datasheet, description: r.description, attributes: JSON.parse(r.attributes || '{}') };
    }
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

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'fetch-db') return fetchDb();
  if ((cmd !== 'lookup' && cmd !== 'datasheets') || !args.length) {
    out('usage: npm run parts -- fetch-db | lookup <board file | MPN…> | datasheets <board file | MPN…>');
    process.exitCode = 1;
    return;
  }
  if (!existsSync(DB)) throw new Error(`no catalogue at ${DB}: run npm run parts -- fetch-db`);
  const { name, parts } = partsOf(args);
  const rows: Row[] = [];
  for (const p of parts) {
    const row: Row = { ...p, match: lookupOne(p.value), library: libraryCoverage(p.value) };
    if (cmd === 'datasheets' && row.match) row.sheet = await download(row.match);
    rows.push(row);
    const m = row.match;
    out(`${p.value.padEnd(24)} ${(p.refs.slice(0, 4).join(',') + (p.refs.length > 4 ? '…' : '')).padEnd(18)} ${m ? `${m.lcsc.padEnd(10)} ${m.mfr} · ${m.package}` : '— not in catalogue'}`);
    out(`${''.padEnd(24)} ${row.library}${row.sheet ? ` · ${row.sheet}` : m?.datasheet ? ` · ${m.datasheet}` : ''}`);
  }
  mkdirSync(REPORTS, { recursive: true });
  const file = join(REPORTS, `${name}.json`);
  writeFileSync(file, JSON.stringify({ generated: new Date().toISOString(), note: 'attributes are distributor summaries (mixed typical / maximum values), not datasheet typicals', rows }, null, 2));
  const found = rows.filter((r) => r.match).length;
  out(`\n${found}/${rows.length} part numbers found in the catalogue; ${rows.filter((r) => /verified|regulators/.test(r.library) && !/unverified/.test(r.library)).length} have datasheet-checked library data. Report: ${file}`);
}

main().catch((e) => { out(String(e?.stack ?? e)); process.exitCode = 1; });
