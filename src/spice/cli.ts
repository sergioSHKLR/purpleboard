// Command-line boardview → SPICE converter and SPICE runner.
//
//   npm run spice -- path/to/board.kicad_pcb -o out.cir --op --print +3V3,+5V
//   npm run spice -- deck.cir                      # run the deck's .op/.dc/.tran with the built-in engine
//
// Options
//   -o, --out <file>      write the netlist (default: print to stdout unless --quiet)
//   --lib <file.json>     part library (see PartLibrary in board.ts); "<input>.spice.json" is picked up automatically
//   --no-infer            keep the importer's placeholder values instead of net-name heuristics (.brd default: infer)
//   --stubs omit          drop unmodelled ICs/connectors instead of hi-Z stubs
//   --no-supply           leave out the importer's synthetic bench supply
//   --op                  run a DC operating point and print node voltages
//   --tran <tstep> <tstop>  add/run a transient analysis
//   --powerup <trise>     ramp every DC supply from 0 V over trise (with --tran: power-on inrush)
//   --print a,b,c         nodes to print (default: rails, or all nodes for small circuits)
//   --report              print the per-part provenance table
//   --quiet               do not echo the netlist
import { buildConnectivity } from '../connectivity';
import { importScenarioOrPcb } from '../io/kicad';
import { boardToCircuit, type PartLibrary } from './board';
import { discoverPowerTree, railVoltage } from './powertree';
import { powerTreeElements } from './powermodels';
import { POWER_STATES, enablesForState, expectedUp } from './sequencer';
import type { Element } from './types';
import { Engine, sampleAt, type OpResult } from './engine';
import { parseSpice, writeSpice } from './netlist';
import type { Analysis, Circuit } from './types';
import { parseSpiceNumber } from './units';

interface Fs {
  readFileSync(p: string): Uint8Array;
  writeFileSync(p: string, d: string): void;
  existsSync(p: string): boolean;
}
interface Proc { argv: string[]; exitCode?: number; stdout: { write(s: string): void } }

const proc = (globalThis as unknown as { process: Proc }).process;
const out = (s: string) => proc.stdout.write(s + '\n');

async function main() {
  const fsName = 'node:fs';
  const fs = (await import(/* @vite-ignore */ fsName)) as Fs;
  const args = proc.argv.slice(2);
  const flag = (n: string) => { const i = args.indexOf(n); if (i >= 0) { args.splice(i, 1); return true; } return false; };
  const value = (...ns: string[]) => {
    for (const n of ns) { const i = args.indexOf(n); if (i >= 0) { const v = args[i + 1]; args.splice(i, 2); return v; } }
    return undefined;
  };
  const outFile = value('-o', '--out');
  const libFile = value('--lib');
  const stubs = value('--stubs');
  const powerup = value('--powerup');
  const printList = value('--print')?.split(',').map((s) => s.trim()).filter(Boolean);
  let tran: [number, number] | null = null;
  const ti = args.indexOf('--tran');
  if (ti >= 0) { tran = [parseSpiceNumber(args[ti + 1]), parseSpiceNumber(args[ti + 2])]; args.splice(ti, 3); }
  const runOp = flag('--op');
  const showTree = flag('--power-tree');
  const behavioral = flag('--behavioral');
  const enableAll = flag('--enable-all');
  const states = flag('--states');
  const multi = (k: string) => { const out: string[] = []; for (let i = args.indexOf(k); i >= 0; i = args.indexOf(k)) { out.push(args[i + 1]); args.splice(i, 2); } return out; };
  const supplies = multi('--supply').map((s) => { const m = /^([^=]+)=([\d.]+)(?::([\d.]+))?$/.exec(s); if (!m) throw new Error(`bad --supply ${s} (NET=V[:R])`); return { net: m[1], v: +m[2], r: m[3] ? +m[3] : 0.05 }; });
  const setpoints = Object.fromEntries(multi('--set').map((x) => { const m = /^([^=]+)=([\d.]+)$/.exec(x); if (!m) throw new Error(`bad --set ${x} (RAIL=V)`); return [m[1], +m[2]]; }));
  const drives = multi('--drive').map((s) => { const m = /^([^=]+)=([\d.]+)$/.exec(s); if (!m) throw new Error(`bad --drive ${s} (NET=V)`); return { net: m[1], v: +m[2] }; });
  const noInfer = flag('--no-infer');
  const noSupply = flag('--no-supply');
  const showReport = flag('--report');
  const quiet = flag('--quiet');
  const input = args[0];
  if (!input) {
    out('usage: npm run spice -- <board.brd|.kicad_pcb|.pcbfix.json|deck.cir> [-o out.cir] [--lib lib.json] [--op] [--tran 1u 1m] [--print n1,n2] [--report]');
    proc.exitCode = 2;
    return;
  }

  const bytes = fs.readFileSync(input);
  let circuit: Circuit;
  let railNodes: [string, string][] = [];
  let seq: { tree: ReturnType<typeof discoverPowerTree>; nodeOf: (n: string) => string | undefined } | null = null;
  if (/\.(cir|sp|spice|net|ckt)$/i.test(input)) {
    const parsed = parseSpice(new TextDecoder().decode(bytes));
    for (const w of parsed.warnings) out(`warning: ${w}`);
    circuit = parsed;
  } else {
    const sc = importScenarioOrPcb(input.replace(/^.*[\\/]/, ''), bytes);
    const conn = buildConnectivity(sc.board);
    const autoLib = input.replace(/\.[^.\\/]+$/, '') + '.spice.json';
    // Libraries stack: "<board>.spice.json" (auto) first, then each --lib (comma separated) overrides it.
    const libPaths = [...(fs.existsSync(autoLib) ? [autoLib] : []), ...(libFile ? libFile.split(',') : [])];
    const libPath = libPaths.length ? libPaths.join(', ') : undefined;
    let library: PartLibrary | undefined;
    const partNumbers: Record<string, string> = {};
    for (const p of libPaths) {
      const l = JSON.parse(new TextDecoder().decode(fs.readFileSync(p))) as PartLibrary & { partNumbers?: Record<string, string> };
      Object.assign(partNumbers, l.partNumbers ?? {});
      library = {
        models: { ...library?.models, ...l.models },
        parts: { ...library?.parts, ...l.parts },
        patterns: [...(l.patterns ?? []), ...(library?.patterns ?? [])],
      };
    }
    const isBrd = /\.brd$/i.test(input);
    const nl = boardToCircuit(sc.board, conn, {
      title: `${sc.meta.title} (${input.replace(/^.*[\\/]/, '')})`,
      library,
      infer: isBrd && !noInfer,
      unmodeled: stubs === 'omit' ? 'omit' : 'stub',
      exclude: noSupply || supplies.length ? sc.board.components.filter((c) => c.ref.startsWith('J_') && c.kind === 'battery').map((c) => c.ref) : [],
      comments: [
        `Source: ${input.replace(/^.*[\\/]/, '')}; ${sc.board.components.length} parts, ${conn.netCount} copper islands.`,
        ...(libPath ? [`Part libraries: ${libPath}`] : []),
        ...(isBrd ? ['Supply J_* (if present) is the importer\'s synthetic bench supply, not a real part.'] : []),
      ],
    });
    for (const w of nl.warnings) out(`warning: ${w}`);
    if (showReport) {
      out('ref\tas\tsource\tnote');
      for (const r of nl.report) out(`${r.ref}\t${r.as}\t${r.source}\t${r.note ?? ''}`);
    }
    circuit = nl.circuit;
    const nameToNode = new Map<string, string>();
    for (const [net, node] of nl.netNode) if (!nameToNode.has(conn.netNames[net])) nameToNode.set(conn.netNames[net], node);
    const nodeOf = (n: string) => nameToNode.get(n);
    if (showTree || behavioral) {
      const parts = library?.parts ?? {};
      const notFitted = new Set(Object.entries(parts).filter(([, sp]) => sp.type === 'open').map(([r]) => r));
      const ohms: Record<string, number> = {};
      for (const [r, sp] of Object.entries(parts)) if (sp.type === 'short') ohms[r] = 0; else if (sp.type === 'R' && typeof sp.value === 'number') ohms[r] = sp.value; else if (sp.type === 'subckt' && /KELVIN/.test(sp.spice ?? '')) ohms[r] = 0.001;
      const tree = discoverPowerTree(sc.board, conn, { partNumbers, notFitted, ohms });
      seq = { tree, nodeOf };
      if (showTree) {
        out(`power tree: ${tree.sources.length} sources over ${tree.rails.size} rails, ${tree.roots.length} rails without a producer`);
        for (const s of tree.sources) out(`  ${s.kind.padEnd(12)} ${s.ref.padEnd(7)} ${String(s.input).padEnd(28)} → ${s.output.padEnd(28)} ${s.enable ? 'EN=' + s.enable : ''} [${s.confidence}]`);
        out(`  roots: ${tree.roots.join(' ')}`);
      }
      if (behavioral) {
        const pm = powerTreeElements(tree, nodeOf, { setpoints });
        const checks = pm.report.filter((r) => r.divider);
        if (checks.length) {
          out(`feedback dividers vs rail names (implied Vref):`);
          for (const r of checks) out(`  ${r.ref.padEnd(7)} ${r.output.padEnd(28)} implied ${r.divider!.implied.toFixed(3)} V → nearest standard ${r.divider!.nearest} V ${r.divider!.consistent ? 'consistent' : 'SUSPECT'}`);
        }
        circuit.elements.push(...pm.elements);
        const ok = pm.report.filter((r) => r.modelled);
        out(`behavioral converters: ${ok.length} modelled, ${pm.report.length - ok.length} skipped`);
        for (const r of pm.report.filter((x) => !x.modelled)) out(`  skipped ${r.ref} → ${r.output}: ${r.why}`);
        if (enableAll) {
          let k = 0;
          for (const s of tree.sources) {
            const en = s.enable && nodeOf(s.enable);
            if (!en || drives.some((d) => d.net === s.enable)) continue;
            const low = /_L$|_N$/i.test(s.enable!);
            circuit.elements.push({ kind: 'V', name: `V_ENALL${++k}`, n: [`enall${k}`, '0'], wave: { type: 'dc', v: low ? 0 : 3.3 } }, { kind: 'R', name: `R_ENALL${k}`, n: [`enall${k}`, en], value: 1e3, note: `assert ${s.enable}` });
          }
          out(`--enable-all: asserted ${k} enables through 1 kΩ`);
        }
      }
    }
    supplies.forEach((sp, i) => {
      const n = nodeOf(sp.net);
      if (!n) throw new Error(`--supply: net ${sp.net} not found`);
      circuit.elements.push({ kind: 'V', name: `V_SUPPLY${i + 1}`, n: [`sup${i + 1}`, '0'], wave: { type: 'dc', v: sp.v } }, { kind: 'R', name: `R_SUPPLY${i + 1}`, n: [`sup${i + 1}`, n], value: sp.r });
    });
    drives.forEach((d, i) => {
      const n = nodeOf(d.net);
      if (!n) throw new Error(`--drive: net ${d.net} not found`);
      circuit.elements.push({ kind: 'V', name: `V_DRIVE${i + 1}`, n: [`drv${i + 1}`, '0'], wave: { type: 'dc', v: d.v } }, { kind: 'R', name: `R_DRIVE${i + 1}`, n: [`drv${i + 1}`, n], value: 100 });
    });
    railNodes = [...nameToNode].filter(([nm]) => railVoltage(nm) !== null && /^(PP|VCC|VDD|\+)/i.test(nm)).map(([nm, nd]) => [nm, nd]);
  }

  if (powerup) {
    const tr = parseSpiceNumber(powerup);
    for (const e of circuit.elements) {
      if (e.kind === 'V' && e.wave.type === 'dc') e.wave = { type: 'pwl', pts: [[0, 0], [tr, e.wave.v]] };
    }
  }
  if (tran) circuit.analyses = [...circuit.analyses.filter((a) => a.type !== 'tran'), { type: 'tran', tstep: tran[0], tstop: tran[1] }];
  if (!runOp && circuit.analyses.length === 0) circuit.analyses = [{ type: 'op' }];

  if (states) {
    if (!seq || !behavioral) throw new Error('--states needs a board input and --behavioral');
    // The controller drives every enable push-pull: asserted level in states that need it,
    // de-asserted otherwise. One engine; each state warm-starts from the previous solution.
    const all = enablesForState(seq.tree, 'S0SW');
    const c: typeof circuit = { ...circuit, elements: [...circuit.elements] };
    all.forEach((d, i) => {
      const n = seq!.nodeOf(d.net);
      if (!n) return;
      c.elements.push({ kind: 'V', name: `V_EC${i}`, n: [`ec${i}`, '0'], wave: { type: 'dc', v: 0 } } as Element, { kind: 'R', name: `R_EC${i}`, n: [`ec${i}`, n], value: 1e3 } as Element);
    });
    const eng = new Engine(c);
    const table = new Map<string, string[]>();
    let agree = 0, checked = 0;
    let prev: Float64Array | undefined;
    for (const st of POWER_STATES) {
      const on = new Set(enablesForState(seq.tree, st.name).map((d) => d.net));
      all.forEach((d, i) => { if (seq!.nodeOf(d.net)) eng.setDc(`V_EC${i}`, on.has(d.net) === (d.level === 'high') ? 3.3 : 0); });
      const t0 = performance.now();
      const op = eng.op(prev);
      prev = op.x;
      out(`state ${st.name.padEnd(4)}: ${on.size}/${all.length} enables asserted, op ${op.converged ? 'ok' : 'FAILED'} (${op.strategy}, ${(performance.now() - t0).toFixed(0)} ms)`);
      for (const [nm, nd] of railNodes) {
        const nom = railVoltage(nm)!, v = eng.voltage(op.x, nd) ?? 0;
        const up = Math.abs(v - nom) / nom <= 0.05, exp = expectedUp(nm, st.name);
        if (exp !== undefined) { checked++; if (exp === up) agree++; }
        (table.get(nm) ?? table.set(nm, []).get(nm)!).push(exp === undefined ? (up ? ' up ' : ' -- ') : up === exp ? (up ? ' UP ' : ' .. ') : up ? ' UP!' : ' ..!');
      }
    }
    out(`\npower-state sequencing vs rail names (UP/.. as expected, ! = contradicts the name):`);
    out(`  ${'rail'.padEnd(34)} ${POWER_STATES.map((p) => p.name.padEnd(4)).join(' ')}`);
    for (const [nm, cells] of table) out(`  ${nm.padEnd(34)} ${cells.join(' ')}`);
    out(`\nagreement with design intent: ${agree}/${checked} (${((100 * agree) / Math.max(1, checked)).toFixed(1)} %)`);
    return;
  }

  const deck = writeSpice(circuit);
  if (outFile) { fs.writeFileSync(outFile, deck); out(`wrote ${outFile} (${circuit.elements.length} elements)`); }
  else if (!quiet && !runOp && !tran && !/\.(cir|sp|spice|net|ckt)$/i.test(input)) out(deck);

  const isDeck = /\.(cir|sp|spice|net|ckt)$/i.test(input);
  if (!(runOp || tran || isDeck)) return;

  const t0 = performance.now();
  const engine = new Engine(circuit);
  out(`engine: ${engine.size} unknowns, ${engine.devices.length} devices (elaborated in ${(performance.now() - t0).toFixed(0)} ms)`);
  const analyses: Analysis[] = runOp ? [{ type: 'op' }, ...circuit.analyses.filter((a) => a.type !== 'op')] : circuit.analyses;
  const nodesToShow = (op: OpResult) => {
    if (printList) return printList;
    const all = [...op.nodes.keys()].filter((n) => !n.includes('#') && !n.startsWith('NC_'));
    if (all.length <= 40) return all;
    return all.filter((n) => /^(PP|VCC|VDD|\+)/i.test(n)).slice(0, 40);
  };
  for (const a of analyses) {
    const t1 = performance.now();
    const [res] = engine.run([a]);
    const ms = (performance.now() - t1).toFixed(1);
    if (res.type === 'op') {
      const op = res.result;
      out(`\n.op: ${op.converged ? 'converged' : 'FAILED'} via ${op.strategy} in ${op.iterations} iterations (${ms} ms)`);
      for (const n of nodesToShow(op)) {
        const v = engine.voltage(op.x, n);
        out(`  v(${n}) = ${v === undefined ? 'n/a' : v.toFixed(6)}`);
      }
      for (const [k, v] of op.branches) if (/^i\(v/i.test(k)) out(`  ${k} = ${v.toExponential(4)}`);
      if (railNodes.length && (behavioral || showTree)) {
        let up = 0, ok = 0;
        const rows: string[] = [];
        for (const [nm, nd] of railNodes) {
          const nom = railVoltage(nm)!, sim = engine.voltage(op.x, nd) ?? 0;
          const on = sim > 0.5 * nom;
          if (on) up++;
          const err = (sim - nom) / nom;
          if (on && Math.abs(err) <= 0.05) ok++;
          rows.push(`  ${nm.padEnd(34)} nominal ${nom.toFixed(3).padStart(7)}  sim ${sim.toFixed(3).padStart(7)}  ${on ? (Math.abs(err) <= 0.05 ? 'OK' : `OFF-TARGET ${(err * 100).toFixed(1)}%`) : 'down'}`);
        }
        out(`\ndesign-intent rails: ${railNodes.length} named, ${up} up, ${ok} within ±5 % of nominal`);
        for (const r of rows) out(r);
      }
    } else if (res.type === 'dc') {
      const r = res.result;
      out(`\n.dc ${r.src} (${ms} ms)`);
      const cols = printList ?? [...(r.points[0]?.nodes.keys() ?? [])].slice(0, 8);
      out(['  ' + r.src, ...cols].join('\t'));
      r.points.forEach((p, i) => out(['  ' + r.values[i].toPrecision(4), ...cols.map((c) => (engine.voltage(p.x, c) ?? NaN).toPrecision(5))].join('\t')));
    } else {
      const r = res.result;
      out(`\n.tran: ${r.converged ? 'ok' : 'FAILED: ' + r.message}, ${r.steps} steps, ${r.rejected} rejected (${ms} ms)`);
      const tranA = a as Extract<Analysis, { type: 'tran' }>;
      const cols = (printList ?? [...r.signals.keys()].slice(0, 6)).map((c) => (c.includes('(') ? c : `v(${c})`));
      const present = cols.filter((c) => [...r.signals.keys()].some((k) => k.toLowerCase() === c.toLowerCase()));
      out(['  time', ...present].join('\t'));
      const rows = 20;
      for (let k = 0; k <= rows; k++) {
        const t = (tranA.tstop * k) / rows;
        const vals = present.map((c) => {
          const key = [...r.signals.keys()].find((x) => x.toLowerCase() === c.toLowerCase())!;
          return sampleAt(r.time, r.signals.get(key)!, t).toPrecision(5);
        });
        out(['  ' + t.toExponential(3), ...vals].join('\t'));
      }
    }
  }
}

main().catch((e: unknown) => {
  out(`error: ${e instanceof Error ? e.message : String(e)}`);
  proc.exitCode = 1;
});
