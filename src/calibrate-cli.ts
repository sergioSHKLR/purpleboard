// Compares bench measurements of a real board with the simulation and fits the rail-load scale.
//
//   npm run calibrate -- <board.brd | scenario.pcbfix.json> <measurements.csv> [--gnd GND] [-o report.json]
//
// Measurements format: see src/calibrate.ts. The suggested `loadScale` goes into the scenario's
// "calibration" block ({ "loadScale": …, "source": "…" }), which the simulator then applies.
import { buildConnectivity } from './connectivity';
import { importScenarioOrPcb } from './io/kicad';
import { compareMeasurements, fitLoadScale, parseMeasurements, TOLERANCE } from './calibrate';

interface Fs { readFileSync(p: string): Uint8Array; writeFileSync(p: string, d: string): void }
interface Proc { argv: string[]; exitCode?: number; stdout: { write(s: string): void } }
const proc = (globalThis as unknown as { process: Proc }).process;
const out = (s: string) => proc.stdout.write(s + '\n');

async function main() {
  const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as Fs;
  const args = proc.argv.slice(2);
  const take = (k: string) => { const i = args.indexOf(k); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
  const gnd = take('--gnd');
  const outFile = take('-o') ?? take('--out');
  const [boardPath, csvPath] = args;
  if (!boardPath || !csvPath) {
    out('usage: npm run calibrate -- <board.brd | scenario.pcbfix.json> <measurements.csv> [--gnd GND] [-o report.json]');
    proc.exitCode = 1;
    return;
  }
  const bytes = fs.readFileSync(boardPath);
  const sc = await importScenarioOrPcb(boardPath.replace(/^.*[\\/]/, ''), bytes);
  const rows = parseMeasurements(new TextDecoder().decode(fs.readFileSync(csvPath)));
  const conn = buildConnectivity(sc.board);
  const res = compareMeasurements(sc.board, conn, rows, { groundNet: gnd, loadScale: sc.calibration?.loadScale });
  const fmt = (v: number | null) => (v === null ? 'OL' : Math.abs(v) >= 1000 ? v.toExponential(3) : v.toPrecision(4));
  out(`${sc.meta.title}: ${rows.length} measurements\n`);
  out(`  ${'kind'.padEnd(6)} ${'net'.padEnd(30)} ${'state'.padEnd(5)} ${'measured'.padStart(10)} ${'simulated'.padStart(10)} ${'error'.padStart(8)}  flag`);
  for (const r of res) {
    out(`  ${r.kind.padEnd(6)} ${(r.net || '(supply)').padEnd(30)} ${(r.kind === 'volt' || r.kind === 'amps' ? r.state : '').padEnd(5)} ${fmt(r.value).padStart(10)} ${fmt(r.sim).padStart(10)} ${(r.error === null ? '' : `${(r.error * 100).toFixed(1)}%`).padStart(8)}  ${r.flag === 'ok' ? 'ok' : r.flag.toUpperCase()}`);
  }
  const off = res.filter((r) => r.flag !== 'ok');
  out(`\n${res.length - off.length}/${res.length} within tolerance (${Object.entries(TOLERANCE).map(([k, v]) => `${k} ±${v * 100}%`).join(', ')})`);
  const scale = fitLoadScale(res);
  if (scale !== null) {
    const cur = sc.calibration?.loadScale ?? 1;
    out(`rail-load scale from supply currents: ×${scale} (currently ×${cur}) → set "calibration": { "loadScale": ${+(cur * scale).toPrecision(3)}, "source": "${csvPath.replace(/^.*[\\/]/, '')}" } in the scenario`);
  } else out('no supply-current readings: rail-load scale not fitted');
  if (off.some((r) => r.kind === 'diode' || r.kind === 'ohm')) out('diode / Ω mismatches point at part values or device-library specs on those nets (verified: false) — check them first');
  if (outFile) {
    fs.writeFileSync(outFile, JSON.stringify({ board: sc.meta.title, results: res, loadScale: scale }, null, 2));
    out(`report written to ${outFile}`);
  }
}

main().catch((e) => { out(String(e?.stack ?? e)); proc.exitCode = 1; });
