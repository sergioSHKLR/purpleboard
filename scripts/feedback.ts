// Downloads every feedback report from FormSubmit and shows what each one holds.
//
//   npm run feedback                 # fetch, save new reports, print the overview
//   npm run feedback -- --repro      # …and run scripts/repro.ts on every report with a snapshot
//   npm run feedback -- --from x.json   # read a saved API response instead of fetching
//
// Needs FORMSUBMIT_API_KEY in .env.local (git-ignored). Get one once by opening
// https://formsubmit.co/api/get-apikey/<the address the form emails> in a browser: FormSubmit
// emails the key to that address. The API returns the fields exactly as the form posted them, so
// a long snapshot code is complete here even when the email client clipped the message.
//
// Reports land in .feedback/ (git-ignored, they can hold a player's contact): one <id>.json per
// report with the raw fields, plus <id>.repro.txt after --repro.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { decodeSnapshot } from '../src/snapshot';

const DIR = '.feedback';
const args = process.argv.slice(2);
const fromAt = args.indexOf('--from');
const from = fromAt >= 0 ? args[fromAt + 1] : undefined;
const repro = args.includes('--repro');

function loadEnvLocal() {
  if (!existsSync('.env.local')) return;
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

interface Submission { form_url?: string; form_data: Record<string, string>; submitted_at?: { date?: string; timezone?: string } }
interface Report extends Submission { id: string }

async function fetchAll(): Promise<Submission[]> {
  if (from) return (JSON.parse(readFileSync(from, 'utf8')) as { submissions: Submission[] }).submissions;
  loadEnvLocal();
  const key = process.env.FORMSUBMIT_API_KEY;
  if (!key) {
    console.error('No FORMSUBMIT_API_KEY in .env.local.\nOpen https://formsubmit.co/api/get-apikey/<the address the form emails> in a browser,\n'
      + 'then add the key from that email as a line FORMSUBMIT_API_KEY=… to .env.local.');
    process.exit(1);
  }
  const res = await fetch(`https://formsubmit.co/api/get-submissions/${encodeURIComponent(key)}`, { headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => null) as { success?: boolean | string; submissions?: Submission[]; message?: string } | null;
  if (!res.ok || !body || !Array.isArray(body.submissions)) throw new Error(`FormSubmit: ${body?.message ?? `HTTP ${res.status}`}`);
  return body.submissions;
}

const idOf = (s: Submission) => {
  const at = (s.submitted_at?.date ?? '').replace(/\D/g, '').slice(0, 14) || 'undated';
  return `${at}-${createHash('sha1').update(JSON.stringify(s.form_data)).digest('hex').slice(0, 6)}`;
};

/** One line of the `details` field, e.g. line(d, 'Browser'). */
const line = (details: string, key: string) => details.split('\n').find((l) => l.startsWith(key + ': '))?.slice(key.length + 2);

function browserShort(ua = ''): string {
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '?';
  const br = /; wv\)|FBAN|FBAV|Instagram|Barcelona/.test(ua) ? 'in-app' : /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '?';
  return `${br}/${os}`;
}

const noWebGpu = (details: string) => (line(details, 'View') ?? '').startsWith('WebGPU error screen');

async function snapshotState(r: Report): Promise<string> {
  const f = r.form_data, details = f.details ?? '';
  // the WebGPU error screen has no bench, so it never sends a snapshot
  const promised = /Bench snapshot/.test(details) && !noWebGpu(details);
  if (!f.snapshot) return promised ? 'MISSING (promised)' : details.startsWith('(not included)') || !details ? 'off' : 'none';
  try {
    const s = await decodeSnapshot(f.snapshot);
    return `ok ${(f.snapshot.length / 1000).toFixed(1)}k${s.diffDropped ? ' diff-dropped' : ''}${s.errors?.length ? ` ${s.errors.length}err` : ''}`;
  } catch (e) {
    return `BROKEN (${((e instanceof Error && e.message) || String(e) || 'decode failed').slice(0, 40)})`;
  }
}

async function main() {
  const subs = await fetchAll();
  mkdirSync(DIR, { recursive: true });
  const known = new Set(readdirSync(DIR).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)));
  const reports: Report[] = subs.map((s) => ({ id: idOf(s), ...s }));
  let fresh = 0;
  for (const r of reports) {
    if (known.has(r.id)) continue;
    writeFileSync(`${DIR}/${r.id}.json`, JSON.stringify(r, null, 2));
    fresh++;
  }
  console.log(`${reports.length} reports from FormSubmit, ${fresh} new, saved in ${DIR}/\n`);

  const rows: string[][] = [['id', 'type', 'build', 'browser', 'view', 'description', 'contact', 'details', 'snapshot']];
  const tally: Record<string, number> = {};
  const count = (k: string) => { tally[k] = (tally[k] ?? 0) + 1; };
  const gpuFail = new Map<string, number>();
  for (const r of [...reports].reverse()) {
    const f = r.form_data, details = f.details ?? '';
    const msg = (f.message ?? '').trim();
    const described = msg && !msg.startsWith('(no description');
    const snap = await snapshotState(r);
    if (!described) count('no description');
    if (noWebGpu(details) || /WebGPU|WebGPU adapter/.test(line(details, 'Error') ?? '')) {
      count('player stuck: no WebGPU');
      const key = `${line(details, 'Error') ?? '?'}  ${browserShort(line(details, 'Browser'))}`;
      gpuFail.set(key, (gpuFail.get(key) ?? 0) + 1);
    }
    if (!details || details === '(not included)') count('no technical details');
    if (snap.startsWith('MISSING')) count('snapshot promised but missing');
    if (snap.startsWith('BROKEN')) count('snapshot does not decode');
    if (snap.includes('diff-dropped')) count('board changes dropped (too big)');
    if (!described && !snap.startsWith('ok')) count('nothing to go on (no text, no snapshot)');
    rows.push([
      r.id, f.type === 'Suggestion' ? 'idea' : f.type === 'Bug report' ? 'bug' : f.type ?? '?',
      line(details, 'Build') ?? '-', browserShort(line(details, 'Browser')), noWebGpu(details) ? 'NO WEBGPU' : line(details, 'View') ?? '-',
      described ? JSON.stringify(msg.length > 40 ? msg.slice(0, 39) + '…' : msg) : '-',
      f.contact && f.contact !== '(none)' ? 'yes' : '-', details && details !== '(not included)' ? 'yes' : '-', snap,
    ]);
  }
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  for (const r of rows) console.log(r.map((c, i) => c.padEnd(w[i])).join('  ').trimEnd());
  console.log('\nGaps:');
  for (const [k, n] of Object.entries(tally)) console.log(`  ${String(n).padStart(3)}  ${k}`);
  if (!Object.keys(tally).length) console.log('  none');
  if (gpuFail.size) {
    console.log('\nNo WebGPU, by error and browser:');
    for (const [k, n] of [...gpuFail].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${k}`);
  }

  if (repro) {
    console.log('\nRunning scripts/repro.ts on each report with a snapshot…');
    for (const r of reports) {
      if (!r.form_data.snapshot) continue;
      const out = `${DIR}/${r.id}.repro.txt`;
      const run = spawnSync('npx', ['tsx', 'scripts/repro.ts', `${DIR}/${r.id}.json`, '--out', `${DIR}/${r.id}.pcbfix.json`], { encoding: 'utf8' });
      writeFileSync(out, (run.stdout ?? '') + (run.stderr ? `\n--- stderr ---\n${run.stderr}` : ''));
      const flags = (/## Flags\n([\s\S]*)/.exec(run.stdout ?? '')?.[1] ?? '').split('\n').filter((l) => l.trim() && !l.startsWith('(none'));
      console.log(`  ${r.id}: ${run.status !== 0 ? 'repro failed' : flags.length ? `${flags.length} flag(s)` : 'no flags'} → ${out}`);
    }
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
