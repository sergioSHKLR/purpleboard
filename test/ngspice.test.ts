// SPICE engine vs ngspice: a suite of small decks (R/C/L, diodes incl. breakdown, BJT, MOSFET,
// switch, controlled and behavioral sources, subcircuit; .op, .dc and .tran) runs through our
// engine (src/spice/engine.ts) and through ngspice in batch mode, and every saved node voltage
// and source current must agree. Skips (passes) when ngspice is not installed; NGSPICE=<path>
// picks a binary, NGSPICE_VERBOSE=1 prints every comparison.
//
// Tolerances: .op / .dc  |Δ| ≤ 1 mV + 0.2 % (V), 1 nA + 0.5 % (I)   (both reltol 1e-3)
//             .tran      |Δ| ≤ 2 % of the signal's swing + 1 mV / 1 nA, compared on a 200-point
//                        grid (both integrate with error control; ngspice trapezoidal, ours BE/trap)
import { parseSpice } from '../src/spice/netlist';
import { Engine, sampleAt, type AnalysisResult } from '../src/spice/engine';

interface Cp { spawnSync(cmd: string, args: string[], o: { encoding: 'utf8'; env?: Record<string, string | undefined>; cwd?: string; timeout?: number }): { status: number | null; error?: Error; stdout: string; stderr: string } }
interface Fs { mkdtempSync(p: string): string; writeFileSync(p: string, d: string): void; readFileSync(p: string, e: 'utf8'): string; rmSync(p: string, o: { recursive: boolean; force: boolean }): void }
interface Os { tmpdir(): string }
const proc = (globalThis as unknown as { process: { env: Record<string, string | undefined>; exitCode: number } }).process;

/** One plot of an ASCII rawfile: variable names (lower case) → values per point. */
interface RawPlot { name: string; vars: string[]; data: number[][] }

function parseRaw(text: string): RawPlot[] {
  const plots: RawPlot[] = [];
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith('Title:')) { i++; continue; }
    let name = '', nv = 0, np = 0;
    const vars: string[] = [];
    for (; i < lines.length && !lines[i].startsWith('Values:'); i++) {
      const l = lines[i];
      if (l.startsWith('Plotname:')) name = l.slice(9).trim();
      else if (l.startsWith('No. Variables:')) nv = +l.split(':')[1];
      else if (l.startsWith('No. Points:')) np = +l.split(':')[1];
      else if (l.startsWith('Variables:')) {
        for (let k = 0; k < nv; k++) vars.push(lines[++i].trim().split(/\s+/)[1].toLowerCase());
      }
    }
    i++; // past "Values:"
    const nums: number[] = [];
    while (nums.length < nv * np && i < lines.length) {
      const tok = lines[i++].trim().split(/\s+/).filter(Boolean);
      // the first line of each point starts with its index
      for (let k = nums.length % nv === 0 && tok.length > 1 ? 1 : 0; k < tok.length; k++) nums.push(parseFloat(tok[k].split(',')[0]));
    }
    const data = vars.map((_, v) => Array.from({ length: np }, (_, p) => nums[p * nv + v]));
    plots.push({ name, vars, data });
  }
  return plots;
}

/** ngspice raw names → ours: v(n) / n → node n; i(v1) / v1#branch → i(V1). */
function rawKey(v: string): { node?: string; branch?: string } {
  let m = /^v\((.+)\)$/.exec(v);
  if (m) return { node: m[1] };
  m = /^i\((.+)\)$/.exec(v) ?? /^(.+)#branch$/.exec(v);
  if (m) return { branch: m[1] };
  return { node: v };
}

interface Deck { name: string; text: string; note?: string }

const DECKS: Deck[] = [
  { name: 'linear: divider + current source + VCVS/VCCS', text: `lin
V1 in 0 10
R1 in a 1k
R2 a 0 3k
I1 0 b 2m
R3 b 0 2.2k
E1 e 0 a 0 2
RE e 0 10k
G1 0 g a 0 1m
RG g 0 1k
.op
.dc V1 0 10 1
.end` },
  { name: 'behavioral source + subcircuit', text: `beh
.subckt half in out
R1 in out 1k
R2 out 0 1k
.ends
V1 in 0 6
X1 in mid half
B1 sq 0 V=v(mid)*v(mid)/3
RB sq 0 1k
.op
.dc V1 0 6 0.5
.end` },
  { name: 'diode forward (IS, N, RS)', text: `dfwd
V1 in 0 5
R1 in a 1k
D1 a 0 DX
.model DX D(IS=2.5n N=1.8 RS=0.04)
.op
.dc V1 -2 5 0.1
.end` },
  { name: 'LED-like diode (N=2, tiny IS, RS=10)', text: `led
V1 in 0 5
R1 in a 220
D1 a 0 DL
.model DL D(IS=1.2e-18 N=2 RS=10)
.op
.dc V1 0 5 0.1
.end` },
  { name: 'zener breakdown (BV, IBV)', text: `zen
V1 in 0 12
R1 in k 1k
D1 0 k DZ
.model DZ D(IS=1e-14 N=1 RS=1 BV=5.1 IBV=5m)
.op
.dc V1 0 12 0.25
.end` },
  { name: 'NPN common emitter with Early effect', text: `npn
VCC vcc 0 12
VB vb 0 0.9
RB vb b 10k
RC vcc c 2.2k
Q1 c b 0 QN
.model QN NPN(IS=1e-14 BF=150 BR=2 VAF=80)
.op
.dc VB 0 1.5 0.02
.end` },
  { name: 'PNP high-side, saturating', text: `pnp
VCC vcc 0 5
VIN in 0 0
RB in b 4.7k
Q1 c b vcc QP
RL c 0 470
.model QP PNP(IS=5e-15 BF=120 BR=3)
.op
.dc VIN 0 5 0.1
.end` },
  { name: 'NMOS output curve (triode → saturation, LAMBDA)', text: `nmos
VD d 0 5
VG g 0 3
M1 d g 0 0 NM W=20u L=2u
.model NM NMOS(VTO=1.2 KP=50u LAMBDA=0.02)
.op
.dc VD 0 5 0.1
.end` },
  { name: 'NMOS transfer + load resistor', text: `nmos2
VDD vdd 0 5
VG g 0 0
RD vdd d 1k
M1 d g 0 0 NM2
.model NM2 NMOS(VTO=2 KP=0.5)
.op
.dc VG 0 5 0.1
.end` },
  { name: 'PMOS high-side switch', text: `pmos
VDD vdd 0 5
VG g 0 0
M1 out g vdd vdd PM
RL out 0 100
.model PM PMOS(VTO=-1.5 KP=2)
.op
.dc VG 0 5 0.1
.end` },
  { name: 'NMOS reverse drain bias (bulk junction)', note: 'body diode', text: `nrev
VD d 0 0
M1 d 0 0 0 NM3
RS d x 0.001
.model NM3 NMOS(VTO=2 KP=0.5)
.dc VD -1 0.5 0.05
.end` },
  { name: 'PMOS body diode (drain above source)', text: `prev
VS s 0 5
VD x 0 5
RD x d 10
M1 d 0 s s PM2
.model PM2 PMOS(VTO=-1 KP=0.2 IS=5e-14)
.dc VD 4 7 0.05
.end` },
  { name: 'NMOS with its own bulk node', text: `n4
VDD vdd 0 5
VG g 0 2.5
VB b 0 -2
RD vdd d 2k
RS s 0 100
M1 d g s b NM4
.model NM4 NMOS(VTO=1 KP=1m LAMBDA=0.01)
.op
.dc VG 0 5 0.1
.end` },
  { name: 'voltage-controlled switch with hysteresis', text: `sw
VC c 0 0
V1 in 0 5
R1 in o 1k
S1 o 0 c 0 SWM
.model SWM SW(VT=2.45 VH=0.5 RON=1 ROFF=1meg)
.dc VC 0 5 0.1
.end` },
  { name: 'switch hysteresis, sweeping down', text: `swdn
VC c 0 5
V1 in 0 5
R1 in o 1k
S1 o 0 c 0 SWM
.model SWM SW(VT=2.45 VH=0.5 RON=1 ROFF=1meg)
.dc VC 5 0 -0.1
.end` },
  { name: 'RC low-pass, pulse', text: `rc
V1 in 0 PULSE(0 5 1u 10n 10n 50u 100u)
R1 in out 10k
C1 out 0 1n
.tran 0.1u 150u
.end` },
  { name: 'RL step, inductor current', text: `rl
V1 in 0 PULSE(0 1 0 1n 1n 1 2)
R1 in a 100
L1 a 0 10m
.tran 1u 500u
.end` },
  { name: 'series RLC ringing (underdamped)', text: `rlc
V1 in 0 PULSE(0 1 0 1n 1n 1 2)
R1 in a 10
L1 a b 100u
C1 b 0 100n
.tran 0.05u 60u
.end` },
  { name: 'half-wave rectifier + reservoir cap (sin)', text: `rect
V1 in 0 SIN(0 10 50)
D1 in out DR
C1 out 0 100u
RL out 0 1k
.model DR D(IS=10n N=1.9 RS=0.05)
.tran 50u 60m 0 5u
.end` },
  { name: 'PWL source into diode-clamped RC', text: `pwl
V1 in 0 PWL(0 0 1m 5 2m -5 3m 0)
R1 in out 1k
C1 out 0 100n
D1 out c DX
VC c 0 2
.model DX D(IS=1e-14)
.tran 5u 3m
.end` },
];

interface Cmp { what: string; ours: number; ref: number; tol: number }

async function run() {
  const load = (n: string) => import(/* @vite-ignore */ n);
  const cp = (await load('node:child_process')) as Cp;
  const fs = (await load('node:fs')) as Fs;
  const os = (await load('node:os')) as Os;
  const bin = proc.env.NGSPICE || 'ngspice';
  const probe = cp.spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10000 });
  if (probe.error || probe.status !== 0) {
    console.log(`NGSPICE TESTS SKIPPED (no ngspice: install it, or set NGSPICE=<path>)`);
    return;
  }
  const version = /ngspice-(\S+)/.exec(probe.stdout)?.[1] ?? '?';
  const verbose = !!proc.env.NGSPICE_VERBOSE;
  const dir = fs.mkdtempSync(`${os.tmpdir()}/deadboard-ngspice-`);
  const fails: string[] = [];
  let compared = 0;
  try {
    for (const deck of DECKS) {
      const cir = `${dir}/deck.cir`, raw = `${dir}/deck.raw`;
      fs.writeFileSync(cir, deck.text + '\n');
      fs.rmSync(raw, { recursive: false, force: true });
      const r = cp.spawnSync(bin, ['-b', '-r', raw, cir], { encoding: 'utf8', env: { ...proc.env, SPICE_ASCIIRAWFILE: '1' }, timeout: 60000 });
      if (r.status !== 0) { fails.push(`${deck.name}: ngspice failed: ${(r.stderr || r.stdout).slice(0, 300)}`); continue; }
      const plots = parseRaw(fs.readFileSync(raw, 'utf8'));
      const ckt = parseSpice(deck.text);
      if (ckt.warnings.length) fails.push(`${deck.name}: parse warnings ${ckt.warnings.join('; ')}`);
      const ours = new Engine(ckt).run();
      if (plots.length !== ours.length) { fails.push(`${deck.name}: ngspice gave ${plots.length} plots, we ran ${ours.length} analyses`); continue; }

      // ngspice writes the newest plot first: pair analyses with plots by kind, in order
      const kind = { op: 'Operating Point', dc: 'DC transfer characteristic', tran: 'Transient Analysis' };
      const left = [...plots].reverse();
      const cmps: Cmp[] = [];
      for (const res of ours) {
        const pi = left.findIndex((p) => p.name === kind[res.type]);
        if (pi < 0) { fails.push(`${deck.name}: no ngspice plot for .${res.type}`); continue; }
        compare(res, left.splice(pi, 1)[0], cmps);
      }
      const bad = cmps.filter((c) => !(Math.abs(c.ours - c.ref) <= c.tol));
      compared += cmps.length;
      if (verbose) {
        const worst = [...cmps].sort((a, b) => Math.abs(b.ours - b.ref) / b.tol - Math.abs(a.ours - a.ref) / a.tol)[0];
        console.log(`  ${bad.length ? '✗' : '✓'} ${deck.name}: ${cmps.length} values, worst ${worst?.what} ours ${worst?.ours.toPrecision(6)} ngspice ${worst?.ref.toPrecision(6)} (tol ${worst?.tol.toPrecision(2)})`);
      }
      if (!cmps.length) fails.push(`${deck.name}: nothing compared`);
      for (const c of bad.slice(0, 4)) fails.push(`${deck.name}: ${c.what} ours ${c.ours.toPrecision(6)} ngspice ${c.ref.toPrecision(6)} (tol ${c.tol.toPrecision(2)})`);
      if (bad.length > 4) fails.push(`${deck.name}: … ${bad.length - 4} more`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (fails.length) throw new Error(`${fails.length} engine/ngspice mismatch(es):\n  ${fails.join('\n  ')}`);
  console.log(`NGSPICE TESTS PASSED (ngspice ${version}: ${DECKS.length} decks, ${compared} values agree)`);
}

const vTol = (x: number) => 1e-3 + 2e-3 * Math.abs(x);
const iTol = (x: number) => 1e-9 + 5e-3 * Math.abs(x);

/** Adds our-vs-ngspice comparisons for one analysis. */
function compare(res: AnalysisResult, plot: RawPlot, out: Cmp[]) {
  const col = (name: string) => plot.data[plot.vars.indexOf(name)];
  if (res.type === 'op' || res.type === 'dc') {
    const points = res.type === 'op' ? [res.result] : res.result.points;
    plot.vars.forEach((v, vi) => {
      const k = rawKey(v);
      if (res.type === 'dc' && vi === 0) return; // the sweep variable
      points.forEach((op, p) => {
        const ref = plot.data[vi][p];
        const at = res.type === 'dc' ? `@${res.result.values[p].toPrecision(3)}` : '';
        if (k.node !== undefined) {
          const ours = op.nodes.get(k.node) ?? [...op.nodes].find(([n]) => n.toLowerCase() === k.node)?.[1];
          if (ours !== undefined) out.push({ what: `v(${k.node})${at}`, ours, ref, tol: vTol(ref) });
        } else if (k.branch !== undefined) {
          const ours = [...op.branches].find(([n]) => n.toLowerCase() === `i(${k.branch})`)?.[1];
          if (ours !== undefined) out.push({ what: `i(${k.branch})${at}`, ours, ref, tol: iTol(ref) });
        }
      });
    });
    return;
  }
  // transient: both signals on a common grid
  const tr = res.result;
  const tRef = col('time').map(Math.abs);
  const t1 = Math.min(tr.time[tr.time.length - 1], tRef[tRef.length - 1]);
  plot.vars.forEach((v, vi) => {
    if (v === 'time') return;
    const k = rawKey(v);
    const key = k.node !== undefined ? `v(${k.node})` : `i(${k.branch})`;
    const sig = [...tr.signals].find(([n]) => n.toLowerCase() === key)?.[1];
    if (!sig) return;
    const ref = plot.data[vi];
    const swing = Math.max(...ref) - Math.min(...ref);
    const tol = 0.02 * swing + (k.node !== undefined ? 1e-3 : 1e-9);
    for (let g = 0; g <= 200; g++) {
      const t = (t1 * g) / 200;
      out.push({ what: `${key}@${(t * 1e6).toPrecision(4)}µs`, ours: sampleAt(tr.time, sig, t), ref: sampleAt(tRef, ref, t), tol });
    }
  });
}

run().catch((e) => { console.error(e); proc.exitCode = 1; });
