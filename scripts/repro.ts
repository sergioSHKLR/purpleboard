// Rebuilds a player's bench from the snapshot code in a feedback email and checks it.
//
//   npx tsx scripts/repro.ts report.txt          # the pasted email (or just the code) in a file
//   pbpaste | npx tsx scripts/repro.ts           # …or on stdin
//   npx tsx scripts/repro.ts report.txt --out /tmp/bench.pcbfix.json   # also save the rebuilt bench
//
// Prints what the player had and saw, re-solves the bench with the current code, and flags
// anything that does not add up: readings that differ from what the player saw, LEDs lit
// without a supply, touching copper of two nets, solvers that disagree, power that does not
// balance, errors the page caught. Only boards that ship with DEADBOARD can be rebuilt; for an
// imported board the snapshot holds readings and messages only.
import { readFileSync, writeFileSync } from 'node:fs';
import type { Board, Scenario } from '../src/types';
import { decodeSnapshot, applyBoardDiff } from '../src/snapshot';
import { builtinScenarios } from '../src/scenarios/builtin';
import { parseScenario, serializeScenario } from '../src/io/format';
import { buildConnectivity } from '../src/connectivity';
import { LED_ON_I } from '../src/sim';
import { runSolver, verifyScenario, type Solver } from '../src/verify';
import { shapeGap } from '../src/geom';
import { packText } from '../src/crypto';
import type { PowerStateName } from '../src/spice/powertree';

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const out = outAt >= 0 ? args[outAt + 1] : undefined;
const input = args.find((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1));
const text = input ? readFileSync(input, 'utf8') : readFileSync(0, 'utf8');

const flags: string[] = [];
const flag = (s: string) => flags.push(s);
const fmt = (n: number, unit: string) => `${Math.abs(n) < 1 && n !== 0 ? (n * 1000).toFixed(2) + ' m' : n.toFixed(3) + ' '}${unit}`;

async function original(id: string): Promise<Scenario | null> {
  const b = (await builtinScenarios()).find((s) => s.id === id);
  if (b) return b;
  try { return parseScenario(readFileSync(new URL(`../public/demos/${id}.pcbfix.json`, import.meta.url), 'utf8')); } catch { return null; }
}

/** Copper items of two different nets that touch (zones excluded: they keep to their own net). */
function crossNetTouches(board: Board): string[] {
  const c = buildConnectivity(board), cand: number[] = [], hits = new Set<string>();
  for (let i = 0; i < c.items.length; i++) {
    const A = c.items[i];
    c.grid.query(A.shape.bb, cand);
    for (const j of cand) {
      if (j <= i) continue;
      const B = c.items[j];
      if (A.kind === 'zone' || B.kind === 'zone' || !(A.layers & B.layers) || !A.net || !B.net || A.net === B.net) continue;
      if (A.kind === 'pad' && B.kind === 'pad' && A.comp === B.comp) continue;
      if (shapeGap(A.shape, B.shape) <= 1e-6) {
        const d = (x: typeof A) => (x.kind === 'pad' ? `${x.comp!.ref}.${x.comp!.pads[x.pi!].name}` : x.kind);
        hits.add(`${d(A)} (${A.net}) touches ${d(B)} (${B.net})`);
      }
    }
  }
  return [...hits];
}

async function main() {
  const s = await decodeSnapshot(text);
  const b = s.bench;
  console.log(`# Snapshot ${s.at} · build ${s.build}`);
  console.log(`Board:   ${s.scenario.shipped ? `${s.scenario.title} (${s.scenario.id})` : `imported ${s.scenario.format ?? ''}`.trim()} · ${s.scenario.parts} parts, ${s.scenario.traces} traces, ${s.scenario.vias} vias · ${s.moves} moves`);
  console.log(`Bench:   power ${b.power ? 'ON' : 'off'} · solver ${b.solver} · OCP ${b.ocpAmps ? b.ocpAmps * 1000 + ' mA' : 'off'}${b.inject ? ` · injecting ${b.inject.volts} V / ${b.inject.amps} A` : ''}${b.boot ? ` · boot ${b.boot}` : ''}`);
  console.log(`View:    ${b.view} · tool ${b.tool}${b.selected ? ` · selected ${b.selected}` : ''}`);
  console.log(`Meter:   ${b.dmm.mode}${b.dmm.red ? ` red ${b.dmm.red}` : ''}${b.dmm.black ? ` black ${b.dmm.black}` : ''}${b.dmm.reading ? ` → ${b.dmm.reading}` : ''}`);
  console.log(`Saw:     supply ${fmt(s.seen.volts, 'V')} ${fmt(s.seen.amps, 'A')}${s.seen.cc ? ' (CC)' : ''} · lit [${s.seen.lit.join(', ')}]${s.seen.tests ? ` · tests ${s.seen.tests}` : ''}`);
  if (s.toasts.length) console.log(`Messages:\n${s.toasts.map((t) => `  - ${t}`).join('\n')}`);
  if (s.errors.length) { console.log(`Errors:\n${s.errors.map((t) => `  - ${t}`).join('\n')}`); flag(`${s.errors.length} page error(s) caught — see Errors`); }

  // what the player saw, by itself
  if (s.seen.lit.length && b.power && s.seen.volts < 0.5 && !b.inject) flag(`LED(s) ${s.seen.lit.join(', ')} shown lit with the supply at ${fmt(s.seen.volts, 'V')}`);

  if (!s.scenario.shipped) {
    console.log('\n(imported board: not rebuilt, the board itself is never sent)');
  } else if (s.diffDropped) {
    console.log('\n(board changes were too large for the email and were dropped: not rebuilt)');
  } else {
    const sc = await original(s.scenario.id);
    if (!sc) { console.log(`\nunknown board id ${s.scenario.id}: not rebuilt`); }
    else {
      const board = applyBoardDiff(sc.board, s.diff ?? {});
      const changed = Object.entries(s.diff ?? {}).map(([k, v]) => `${k} +${v?.set?.length ?? 0}/−${v?.del?.length ?? 0}`).join(', ');
      console.log(`\n## Rebuilt with the current code (changes: ${changed || 'none'})`);
      const conn = buildConnectivity(board);

      for (const t of crossNetTouches(board)) flag(`copper short: ${t}`);

      if (b.power && !b.inject) {
        const opt = {
          ...(b.ocpAmps > 0 && { currentLimit: b.ocpAmps }),
          ...(b.boot && b.boot !== 'OFF' && { powerState: b.boot as PowerStateName, loadScale: sc.calibration?.loadScale }),
        };
        const sim = runSolver(b.solver as Solver, board, conn, opt);
        let volts = 0, amps = 0, pSrc = 0, pLoad = 0;
        const lit: string[] = [];
        for (const c of board.components) {
          const r = sim.comps.get(c.id);
          if (!r) continue;
          if (c.kind === 'battery') { amps += Math.max(0, r.i); volts = Math.max(volts, r.v); pSrc += Math.max(0, r.i) * r.v; }
          else pLoad += Math.max(0, r.p);
          if (c.kind === 'led' && r.i > LED_ON_I) lit.push(c.ref);
        }
        console.log(`Now:     supply ${fmt(volts, 'V')} ${fmt(amps, 'A')}${sim.ccLimited ? ' (CC)' : ''} · lit [${lit.join(', ')}]`);
        if ([...sim.V].some((x) => !Number.isFinite(x))) flag('solver produced NaN/∞ node voltages');
        if (Math.abs(volts - s.seen.volts) > Math.max(0.01, s.seen.volts * 0.02) || Math.abs(amps - s.seen.amps) > Math.max(1e-4, s.seen.amps * 0.02)) {
          flag(`supply differs from what the player saw (${fmt(s.seen.volts, 'V')} ${fmt(s.seen.amps, 'A')} → ${fmt(volts, 'V')} ${fmt(amps, 'A')}): already changed by a fix, or timing (boot / UI state)`);
        }
        const sawLit = [...s.seen.lit].sort().join(','), nowLit = [...lit].sort().join(',');
        if (sawLit !== nowLit) flag(`lit LEDs differ: player saw [${s.seen.lit.join(', ')}], current code gives [${lit.join(', ')}]`);
        if (lit.length && volts < 0.5) flag(`LED(s) ${lit.join(', ')} lit with the supply at ${fmt(volts, 'V')}`);
        if (pSrc > 1e-4 && Math.abs(pSrc - pLoad) > pSrc * 0.05 + 1e-4) flag(`power does not balance: supply ${fmt(pSrc, 'W')}, parts ${fmt(pLoad, 'W')}`);
      }

      if (sc.objectives.length) {
        const fast = await verifyScenario(sc, board, 'fast'), spice = await verifyScenario(sc, board, 'spice');
        console.log(`Tests:   fast ${fast.results.filter((r) => r.passed).length}/${fast.results.length}, spice ${spice.results.filter((r) => r.passed).length}/${spice.results.length}${fast.flag ? ' · flag unlocks' : ''}`);
        fast.results.forEach((r, i) => {
          if (r.passed !== spice.results[i].passed) flag(`solvers disagree on "${r.label}": fast ${r.detail}, spice ${spice.results[i].detail}`);
        });
      }

      if (out) {
        const rebuilt: Scenario = { ...sc, id: `${sc.id}-repro`, board };
        writeFileSync(out, serializeScenario(rebuilt));
        console.log(`Saved:   ${out}`);
        console.log(`Open:    http://localhost:5199/app.html#s=${await packText(serializeScenario(rebuilt))}`);
      }
    }
  }

  console.log(flags.length ? `\n## Flags\n${flags.map((f) => `- ${f}`).join('\n')}` : '\n## Flags\n(none: everything adds up)');
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
