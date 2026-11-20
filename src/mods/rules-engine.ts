// The fault-candidate engine (see rules.ts for the rules as data): observe what differs from the
// working board, rank the parts the rules point at, and the recall test. Loaded on demand (the
// «Where to look?» button, the bench check), so it isn't in the app's first download.
import type { Board, Component, Objective, SwitchMap } from '../types';
import { buildConnectivity, pinNet, type Conn } from '../connectivity';
import { rolePadName } from '../model';
import { evaluateObjectives, runSolver, type Solver } from '../verify';
import { measureOhmsSpice } from '../spice/adapter';
import { applicableFaults, injectFault, rng, seedOf, type FaultClass } from '../faults';
import type { RuleDef } from './rules';

// ---------------- observing ----------------

export interface NetObs { net: number; name: string; state: 'dead' | 'low' | 'high'; expected: number; measured: number }
export interface Observation {
  nets: NetObs[];
  shorts: { net: number; name: string; ohms: number; expected: number }[];
  hot: { ref: string; watts: number; expected: number }[];
  dark: string[];
  /** Parts the failing tests name (an LED, a probed part). */
  tested: string[];
  /** Expected volts per net of the bench board (from the working board). */
  expected: Map<number, number>;
  /** Hops from the supply per net of the bench board (for "feeds-net": the side nearer the supply). */
  hops: Map<number, number>;
  ground: number;
}

const pinKey = (c: Component, pad: string) => `${c.ref}:${pad}`;

function groundNet(board: Board, conn: Conn): number {
  const bat = board.components.find((c) => c.kind === 'battery' && c.state.populated);
  if (bat) { const n = pinNet(conn, bat, '-'); if (n >= 0) return n; }
  const i = conn.netNames.findIndex((n) => /^(A|D|P)?GND$/i.test(n ?? ''));
  return i;
}

/** Volts at every pin (ref:pad) of a solved board. */
function pinVolts(board: Board, conn: Conn, solver: Solver, sw?: SwitchMap): { pins: Map<string, number>; comps: Map<string, { p: number; on: boolean }> } {
  const sim = runSolver(solver, board, conn, { ...(sw && { switches: sw }), ...(solver === 'spice-power' && { powerState: 'S0SW' as const }) });
  const pins = new Map<string, number>();
  for (const c of board.components) {
    const items = conn.padItem.get(c) ?? [];
    c.pads.forEach((p, i) => {
      const net = items[i] === undefined ? -1 : conn.net[items[i]];
      const k = sim.nodeOfNet.get(net);
      if (net >= 0 && k !== undefined && sim.source) pins.set(pinKey(c, p.name), sim.V[k]);
    });
  }
  const comps = new Map<string, { p: number; on: boolean }>();
  for (const c of board.components) { const r = sim.comps.get(c.id); if (r) comps.set(c.ref, { p: r.p, on: r.on && !r.over }); }
  return { pins, comps };
}

/**
 * What differs between the bench board and its known-good version, under every switch setting the
 * tests use. Uses the simulator only (as a player's meter would), with the solver the tests use.
 */
export function observe(board: Board, reference: Board, objectives: Objective[], solver: Solver): Observation {
  const conn = buildConnectivity(board);
  const rconn = buildConnectivity(reference);
  const ground = groundNet(board, conn);
  const rground = groundNet(reference, rconn);
  const settings = new Map<string, SwitchMap | undefined>([['', undefined]]);
  for (const o of objectives) if (o.switches) settings.set(JSON.stringify(o.switches), o.switches);
  const nets = new Map<string, NetObs>();
  const expected = new Map<number, number>();
  const hot = new Map<string, { ref: string; watts: number; expected: number }>();
  const dark = new Set<string>();
  const netName = (n: number, c: Component, pad: string) => conn.netNames[n] || `${c.ref}.${pad}`;
  for (const sw of settings.values()) {
    const got = pinVolts(board, conn, solver, sw);
    const want = pinVolts(reference, rconn, solver, sw);
    // per bench net: measured volts and what its pins read on the working board
    const per = new Map<number, { name: string; exp: number[] }>();
    for (const c of board.components) {
      const items = conn.padItem.get(c) ?? [];
      c.pads.forEach((p, i) => {
        const net = items[i] === undefined ? -1 : conn.net[items[i]];
        const e = want.pins.get(pinKey(c, p.name));
        if (net < 0 || net === ground || e === undefined) return;
        const x = per.get(net) ?? { name: netName(net, c, p.name), exp: [] };
        x.exp.push(e);
        per.set(net, x);
      });
    }
    const someMeasured = (net: number) => {
      for (const c of board.components) {
        const items = conn.padItem.get(c) ?? [];
        for (let i = 0; i < c.pads.length; i++) if (items[i] !== undefined && conn.net[items[i]] === net) { const v = got.pins.get(pinKey(c, c.pads[i].name)); if (v !== undefined) return v; }
      }
      return 0;
    };
    for (const [net, { name, exp }] of per) {
      const e = exp.sort((a, b) => a - b)[Math.floor(exp.length / 2)];
      const m = someMeasured(net);
      if (!expected.has(net) || Math.abs(e) > Math.abs(expected.get(net)!)) expected.set(net, e);
      const tol = Math.max(0.1, 0.1 * Math.abs(e));
      const state = Math.abs(m) < 0.05 && Math.abs(e) > 0.3 ? 'dead' : m < e - tol ? 'low' : m > e + tol ? 'high' : null;
      const key = `${net}:${state}`;
      if (state && !nets.has(key)) nets.set(key, { net, name, state, expected: e, measured: m });
    }
    for (const [ref, r] of got.comps) {
      const w = want.comps.get(ref);
      if (r.p > Math.max(0.05, 3 * (w?.p ?? 0)) && !hot.has(ref)) hot.set(ref, { ref, watts: r.p, expected: w?.p ?? 0 });
      if (w?.on && !r.on) dark.add(ref);
    }
  }
  // shorts: power off, each powered net to ground, against the working board's reading
  const shorts: Observation['shorts'] = [];
  if (ground >= 0 && rground >= 0) {
    for (const [net, e] of expected) {
      if (Math.abs(e) < 0.3) continue;
      const pin = board.components.flatMap((c) => c.pads.map((p, i) => ({ c, p, i }))).find(({ c, i }) => { const it = conn.padItem.get(c)?.[i]; return it !== undefined && conn.net[it] === net; });
      if (!pin) continue;
      const rc = reference.components.find((x) => x.id === pin.c.id);
      const rit = rc && rconn.padItem.get(rc)?.[pin.i];
      if (rit === undefined) continue;
      const ohms = measureOhmsSpice(board, conn, net, ground);
      const want = measureOhmsSpice(reference, rconn, rconn.net[rit], rground);
      if (ohms < Math.min(want / 3, 1000)) shorts.push({ net, name: conn.netNames[net] || `${pin.c.ref}.${pin.p.name}`, ohms, expected: want });
    }
  }
  // hops from the supply: from the copper at the supply's + terminal (a joint there may be open),
  // else the nets the working board holds highest; through any part, never through ground
  const hops = new Map<number, number>();
  const queue: number[] = [];
  for (const c of board.components) {
    if (c.kind !== 'battery' || !c.state.populated) continue;
    const pad = rolePadName(c, '+');
    const pi = c.pads.findIndex((p) => p.name === pad);
    const it = pi >= 0 ? conn.padItem.get(c)?.[pi] : undefined;
    if (it !== undefined && conn.net[it] !== ground) queue.push(conn.net[it]);
  }
  if (!queue.length) {
    const top = Math.max(0, ...[...expected.values()].map(Math.abs));
    queue.push(...[...expected].filter(([, v]) => top > 0.3 && Math.abs(Math.abs(v) - top) < 0.05).map(([n]) => n));
  }
  for (const n of queue) hops.set(n, 0);
  const partNets = board.components.map((c) => netsOf(c, conn).filter((n) => n !== ground));
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i];
    for (const ns of partNets) if (ns.includes(n)) for (const m of ns) if (!hops.has(m)) { hops.set(m, hops.get(n)! + 1); queue.push(m); }
  }
  // parts the failing tests name
  const ev = evaluateObjectives(board, conn, objectives, solver);
  const tested = [...new Set(ev.results.filter((r) => !r.passed).flatMap((r) => (r.objective.type === 'led' ? [r.objective.ref] : [r.objective.a, ...(r.objective.b ? [r.objective.b] : [])])))];
  return { nets: [...nets.values()], shorts, hot: [...hot.values()], dark: [...dark], tested, expected, hops, ground };
}

// ---------------- ranking ----------------

export interface Reason { rule: string; observation: string; confirm: string }
export interface Candidate { ref: string; score: number; reasons: Reason[] }

const twoTerminal = (c: Component) => new Set(c.pads.map((p) => p.name)).size >= 2;
function netsOf(c: Component, conn: Conn): number[] {
  const items = conn.padItem.get(c) ?? [];
  return [...new Set(c.pads.map((_, i) => (items[i] === undefined ? -1 : conn.net[items[i]])).filter((n) => n >= 0))];
}

/** Parts that could explain the observation, best first. Every candidate is a part of `board`. */
export function rankCandidates(obs: Observation, board: Board, rules: readonly RuleDef[]): Candidate[] {
  const conn = buildConnectivity(board);
  const nets = new Map(board.components.map((c) => [c.ref, netsOf(c, conn)]));
  const byRef = new Map(board.components.map((c) => [c.ref, c]));
  const out = new Map<string, Candidate>();
  /** Best contribution per (rule, part): a rule counts once per part, at its strongest. */
  const best = new Map<string, number>();
  const bad = obs.nets.filter((x) => x.state === 'dead' || x.state === 'low');
  const firstBad = Math.min(Infinity, ...bad.map((x) => obs.hops.get(x.net) ?? Infinity));
  const kindOk = (r: RuleDef, c: Component) => !r.suspect.kinds || r.suspect.kinds.includes(c.kind);
  const credit = (r: RuleDef, refs: string[], what: string, fill: { net?: string }, boost: Set<string> = new Set(), factor = 1) => {
    const n = refs.length;
    if (!n) return;
    for (const ref of refs) {
      const cand = out.get(ref) ?? { ref, score: 0, reasons: [] };
      // a rule that singles out one part counts more; a part on the live / dead boundary most
      const v = ((r.weight ?? 5) / Math.sqrt(n)) * (boost.has(ref) ? 2.5 : 1) * factor;
      const key = `${r.id}|${ref}`;
      const prev = best.get(key) ?? 0;
      if (v > prev) { cand.score += v - prev; best.set(key, v); }
      cand.reasons.push({ rule: r.id, observation: what, confirm: r.confirm.replace(/\{net\}/g, fill.net ?? '').replace(/\{ref\}/g, ref) });
      out.set(ref, cand);
    }
  };
  const forNet = (r: RuleDef, net: number, name: string, what: string) => {
    const here = board.components.filter((c) => nets.get(c.ref)!.includes(net) && kindOk(r, c));
    let refs: string[] = [];
    if (r.suspect.where === 'on-net') refs = here.map((c) => c.ref);
    else {
      const h = obs.hops.get(net) ?? Infinity;
      refs = here.filter((c) => twoTerminal(c) && nets.get(c.ref)!.some((n) => n !== net && n !== obs.ground && (r.suspect.where === 'series' || (obs.hops.get(n) ?? Infinity) < h)))
        .map((c) => c.ref);
      // an open joint leaves a part on only one net: it can still be the one feeding this net
      if (r.suspect.where === 'feeds-net') for (const c of here) if (twoTerminal(c) && nets.get(c.ref)!.length === 1 && !refs.includes(c.ref)) refs.push(c.ref);
    }
    // the boundary: a part whose supply side reads fine while this side doesn't
    const badNets = new Set(bad.map((x) => x.net));
    const boost = new Set(r.suspect.where === 'feeds-net' ? refs.filter((ref) => nets.get(ref)!.some((n) => n !== net && n !== obs.ground && !badNets.has(n) && (obs.hops.get(n) ?? Infinity) < (obs.hops.get(net) ?? Infinity))) : []);
    // the first net to go wrong (nearest the supply) points at the cause; later ones follow from it
    const first = badNets.has(net) && (obs.hops.get(net) ?? Infinity) === firstBad;
    credit(r, refs, what, { net: name }, boost, first ? 1.5 : 1);
  };
  const forPart = (r: RuleDef, ref: string, what: string) => {
    const c = byRef.get(ref);
    if (!c) return;
    if (r.suspect.where === 'the-part') { if (kindOk(r, c)) credit(r, [ref], what, {}); return; }
    const mine = nets.get(ref)!.filter((n) => n !== obs.ground);
    const refs = board.components.filter((x) => x.ref !== ref && kindOk(r, x) && nets.get(x.ref)!.some((n) => mine.includes(n)) && (r.suspect.where === 'on-net' || twoTerminal(x))).map((x) => x.ref);
    credit(r, refs, what, {});
  };
  for (const r of rules) {
    if (r.when === 'short') for (const s of obs.shorts) forNet(r, s.net, s.name, `${s.name} reads ${s.ohms.toPrecision(2)} Ω to ground (working board ${s.expected >= 1e6 ? 'open' : `${s.expected.toPrecision(2)} Ω`})`);
    else if (r.when === 'hot') for (const h of obs.hot) forPart(r, h.ref, `${h.ref} dissipates ${(h.watts * 1000).toFixed(0)} mW (working board ${(h.expected * 1000).toFixed(0)} mW)`);
    else if (r.when === 'dark') for (const ref of obs.dark) forPart(r, ref, `${ref} stays dark`);
    else if (r.when === 'tested') for (const ref of obs.tested) forPart(r, ref, `a test fails at ${ref}`);
    else for (const n of obs.nets.filter((x) => x.state === r.when)) forNet(r, n.net, n.name, `${n.name} reads ${n.measured.toFixed(2)} V (working board ${n.expected.toFixed(2)} V)`);
  }
  return [...out.values()].sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref));
}

// ---------------- recall test ----------------

/** Faults the recall test plants (one fixed severity each, so runs are comparable). */
const RECALL: [FaultClass, number | undefined][] = [
  ['open-part', undefined], ['cold-joint', 1e6], ['resistor-drift', 25], ['mlcc-dead-short', 0.1],
  ['cap-partial-short', 10], ['liquid-leakage', 1000], ['net-break', undefined],
];

export interface RecallResult {
  /** Faults that fail the tests (only these count). */
  visible: number;
  hits: number;
  /** Visible faults with no candidate at all. */
  none: number;
  misses: { board: string; ref: string; fault: FaultClass; top: string[] }[];
  /** A candidate that isn't a part of the board (must stay 0). */
  invented: number;
}

/** For every planted fault on every working board: is the planted part among the top 3? */
export function recallTest(boards: { title: string; reference: Board; objectives: Objective[]; solver: Solver }[], rules: readonly RuleDef[], opts: { maxPerBoard?: number } = {}): RecallResult {
  const res: RecallResult = { visible: 0, hits: 0, none: 0, misses: [], invented: 0 };
  for (const b of boards) {
    let tried = 0;
    for (const part of b.reference.components) {
      for (const [cls, sev] of RECALL) {
        if (!(cls === 'open-part' || applicableFaults(part).includes(cls))) continue;
        if (opts.maxPerBoard && tried >= opts.maxPerBoard) break;
        const board = structuredClone(b.reference);
        const c = board.components.find((x) => x.id === part.id)!;
        try { injectFault(c, cls, rng(seedOf(`${b.title}|${c.ref}|${cls}`)), { ...(sev !== undefined && { severity: sev }) }); } catch { continue; }
        tried++;
        if (evaluateObjectives(board, buildConnectivity(board), b.objectives, b.solver).allPassed) continue; // doesn't show
        res.visible++;
        const ranked = rankCandidates(observe(board, b.reference, b.objectives, b.solver), board, rules);
        const refs = new Set(board.components.map((x) => x.ref));
        res.invented += ranked.filter((x) => !refs.has(x.ref)).length;
        if (!ranked.length) res.none++;
        const top = ranked.slice(0, 3).map((x) => x.ref);
        if (top.includes(c.ref)) res.hits++;
        else res.misses.push({ board: b.title, ref: c.ref, fault: cls, top });
      }
    }
  }
  return res;
}
