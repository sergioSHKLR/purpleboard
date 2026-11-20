// Random repair problems on a board the player has just fixed. The fixed board is a verified
// known-good reference (it passed every bench check and unlocked the flag), so a new problem is
// that board plus fresh faults, with the flag re-locked to its topology. Every fault has to fail a
// bench check on its own (an invisible fault is no puzzle) and none may overload a part (the app
// burns overloaded parts on power-up, which would turn one fault into an unannounced cascade).
// Universal: only part kinds, pads, nets, copper and the objectives are used, never refdes.
import type { Board, Component, Objective, Scenario, Side } from '../types';
import { buildConnectivity, pinNet, type Conn } from '../connectivity';
import { lockFlag, topology } from '../crypto';
import { evaluateObjectives, type Solver } from '../verify';
import { addBlob, cutTrace, installPart, removeBlob, removePart, toggleCold } from '../ops';
import { cleanWithIpa } from '../residue';
import { E12, fmtSI, padMask, padShape, padWorld } from '../model';
import { dist, shapeGap } from '../geom';
import { clearFault, injectFault, rng, seedOf, type FaultClass } from '../faults';
import { setReference } from './reference';
import { t } from '../i18n';

export type GenKind =
  | 'cut-trace' | 'solder-bridge' | 'cold-joint' | 'reversed' | 'wrong-value' | 'missing' | 'open-part'
  | 'mlcc-dead-short' | 'cap-partial-short' | 'liquid-leakage' | 'resistor-drift' | 'ic-rail-short' | 'net-break';

export interface GenFault {
  kind: GenKind;
  /** The part the fault is on (or nearest to, for a cut trace). */
  ref: string;
  /** Where to look, without giving the fault away (a net). */
  where: string;
  /** What is wrong and how to repair it. */
  fix: string;
  /** The repair, done the way the player's tools do it (tests, automation). */
  repair: (b: Board) => void;
}

interface Candidate {
  kind: GenKind;
  /** Component id or trace id: one fault per target. */
  target: string;
  /** Hops from the nets the objectives measure (1 = on them). */
  hops: number;
  /**
   * Breaks `b` and says what was done; null when it does not apply. `ctx.conn` is b's connectivity
   * before the fault: a fault that changes copper leaves the new one there, one that changes only
   * which pads join (cold, missing) marks it `padsChanged`.
   */
  apply: (b: Board, r: () => number, ctx: Ctx) => GenFault | null;
}

/** Connectivity of the board being broken (building it dominates the time on big boards). */
interface Ctx { conn: Conn; padsChanged?: boolean }

export interface GenerateOptions {
  solver: Solver;
  /** Faults wanted (1–3); fewer when the board has fewer that show on the bench. */
  faults: number;
  seed?: number;
  /** Stop trying candidates after this long (big boards solve slowly). */
  budgetMs?: number;
  /** Called between solves, so a UI can stay responsive. */
  yieldFn?: () => Promise<void>;
}

export interface Generated { scenario: Scenario; faults: GenFault[] }

const SPICE_CLASSES: (FaultClass & GenKind)[] = ['mlcc-dead-short', 'cap-partial-short', 'liquid-leakage', 'resistor-drift', 'ic-rail-short'];
/** Kinds only a SPICE solver shows (the open cold joint generated here is not one: Fast DC sees it). */
const isSpiceKind = (k: GenKind) => (SPICE_CLASSES as GenKind[]).includes(k);
const GROUND = /^(A|D|P|S)?GND(_.*)?$|^VSS(_.*)?$|_GND$/i;
/** Boards with more parts than this search near the checks only, and screen with cached connectivity. */
const BIG = 80;
/** Nets with more parts than this are buses / planes: the search does not spread through them. */
const FANOUT = 12;
const PRIMARY: ReadonlySet<string> = new Set(['resistor', 'led', 'diode', 'fuse', 'capacitor']);

const byId = (b: Board, id: string) => b.components.find((c) => c.id === id)!;
const nearE12 = (v: number) => {
  const dec = 10 ** Math.floor(Math.log10(v));
  return E12.map((m) => m * dec).concat(10 * dec).reduce((a, x) => (Math.abs(Math.log(x / v)) < Math.abs(Math.log(a / v)) ? x : a));
};

/** Nets each objective measures: an LED's two pins, a voltage objective's probe points. */
function objectiveNets(b: Board, conn: Conn, objectives: Objective[]): Set<number> {
  const out = new Set<number>();
  const comp = (ref: string) => b.components.find((c) => c.ref === ref);
  for (const o of objectives) {
    const refs = o.type === 'led' ? [o.ref] : [o.a, ...(o.b ? [o.b] : [])];
    for (const ref of refs) {
      const c = comp(ref);
      if (!c) continue;
      for (const role of Object.keys(c.pins)) { const n = pinNet(conn, c, role); if (n >= 0) out.add(n); }
    }
  }
  return out;
}

/** Hops from the objective nets to every net, spreading through parts but not through ground or buses. */
function netHops(b: Board, conn: Conn, start: Set<number>): Int32Array {
  const compsOf = new Map<number, Component[]>();
  const netsOf = new Map<Component, number[]>();
  for (const c of b.components) {
    const idx = conn.padItem.get(c);
    if (!idx || !c.state.populated) continue;
    const nets = [...new Set(idx.map((i) => conn.net[i]))];
    netsOf.set(c, nets);
    for (const n of nets) { let l = compsOf.get(n); if (!l) compsOf.set(n, (l = [])); l.push(c); }
  }
  const hops = new Int32Array(conn.netCount).fill(-1);
  let frontier = [...start];
  for (const n of frontier) hops[n] = 0;
  for (let d = 1; frontier.length; d++) {
    const next: number[] = [];
    for (const n of frontier) {
      const comps = compsOf.get(n) ?? [];
      if (d > 1 && (GROUND.test(conn.netNames[n]) || comps.length > FANOUT)) continue;
      for (const c of comps) for (const m of netsOf.get(c)!) if (hops[m] < 0) { hops[m] = d; next.push(m); }
    }
    frontier = next;
  }
  return hops;
}

const netLabel = (conn: Conn, n: number) => (n >= 0 && !/^Net-\d+$/.test(conn.netNames[n]) ? conn.netNames[n] : '');
const whereNet = (net: string, ref: string) => (net ? t('One fault is on the {net} net.', { net }) : t('One fault is near {ref}.', { ref }));

function candidates(g: Board, conn: Conn, objectives: Objective[], solver: Solver): Candidate[] {
  const hops = netHops(g, conn, objectiveNets(g, conn, objectives));
  const big = g.components.length > BIG;
  const hopsOfNets = (nets: number[]) => {
    const h = nets.map((n) => hops[n]).filter((x) => x >= 0);
    return h.length ? Math.min(...h) + 1 : big ? Infinity : 6;
  };
  const out: Candidate[] = [];
  const add = (c: Candidate) => { if (Number.isFinite(c.hops) && (!big || c.hops <= 3)) out.push(c); };

  for (const c of g.components) {
    if (!c.state.populated || c.state.burnt) continue;
    const idx = conn.padItem.get(c);
    if (!idx) continue;
    const padNets = idx.map((i) => conn.net[i]);
    const h = hopsOfNets([...new Set(padNets)]);
    const mainNet = netLabel(conn, padNets.find((n) => netLabel(conn, n) && !GROUND.test(conn.netNames[n])) ?? padNets[0]);
    const id = c.id;
    const value = c.value; // the reference value: closures run after other faults changed the board
    const polar = c.kind === 'led' || c.kind === 'diode';

    if (polar && !c.state.reversed) add({ kind: 'reversed', target: id, hops: h, apply: (b, _r, _ctx) => {
      byId(b, id).state.reversed = true;
      return { kind: 'reversed', ref: c.ref, where: whereNet(mainNet, c.ref), fix: t('{ref} is fitted backwards: rotate it 180° to match the silkscreen.', { ref: c.ref }),
        repair: (x) => { const p = byId(x, id); p.state.reversed = !p.state.reversed; } };
    } });

    if (c.kind === 'resistor' && value > 0) add({ kind: 'wrong-value', target: id, hops: h, apply: (b, r, _ctx) => {
      const f = [100, 0.01, 10, 0.1][Math.floor(r() * 4)];
      const bad = nearE12(value * f);
      if (bad < 1 || bad > 10e6 || bad === value) return null;
      byId(b, id).value = bad;
      return { kind: 'wrong-value', ref: c.ref, where: whereNet(mainNet, c.ref), fix: t('{ref} is the wrong value ({bad} fitted, the design needs {good}): fit the right one from the parts bin.', { ref: c.ref, bad: fmtSI(bad, 'Ω'), good: fmtSI(value, 'Ω') }),
        repair: (x) => { const p = byId(x, id); installPart(p, { value, reversed: p.state.reversed }); } };
    } });

    if (PRIMARY.has(c.kind) && !(polar && c.state.reversed)) {
      add({ kind: 'missing', target: id, hops: h, apply: (b, _r, ctx) => {
        removePart(byId(b, id));
        ctx.padsChanged = true;
        return { kind: 'missing', ref: c.ref, where: whereNet(mainNet, c.ref), fix: t('{ref} is missing: solder in a new one.', { ref: c.ref }),
          repair: (x) => installPart(byId(x, id), { value }) };
      } });
      if (c.kind !== 'capacitor') add({ kind: 'open-part', target: id, hops: h, apply: (b, _r, _ctx) => {
        byId(b, id).state.burnt = true;
        return { kind: 'open-part', ref: c.ref, where: whereNet(mainNet, c.ref), fix: t('{ref} is dead (open inside): replace it.', { ref: c.ref }),
          repair: (x) => installPart(byId(x, id), { value }) };
      } });
    }

    // an open joint on a pad that carries a net (not a test point: that is the bench's own probe)
    if (c.kind !== 'testpoint') {
      const pads = c.pads.map((_, i) => i).filter((i) => !c.state.cold.includes(i) && conn.netItems[padNets[i]].length > 1);
      for (const pi of pads.slice(0, 4)) add({ kind: 'cold-joint', target: id, hops: hopsOfNets([padNets[pi]]), apply: (b, _r, ctx) => {
        const bc = byId(b, id);
        bc.state.cold = [...bc.state.cold, pi].sort((x, y) => x - y);
        ctx.padsChanged = true;
        return { kind: 'cold-joint', ref: c.ref, where: whereNet(netLabel(conn, padNets[pi]), c.ref), fix: t('{ref} pad {pad} has a cold joint: reflow it with the soldering iron.', { ref: c.ref, pad: c.pads[pi].name }),
          repair: (x) => toggleCold(byId(x, id), pi) };
      } });
    }

    // a solder bridge between two close pads of the part on different nets
    let bridges = 0;
    for (let i = 0; i < c.pads.length && bridges < 3; i++) {
      for (let j = i + 1; j < c.pads.length && bridges < 3; j++) {
        if (padNets[i] === padNets[j]) continue;
        const shared = padMask(c.pads[i]) & padMask(c.pads[j]);
        if (!shared) continue;
        const gap = shapeGap(padShape(c, c.pads[i]), padShape(c, c.pads[j]));
        if (gap <= 0 || gap > 1.3) continue;
        const layer: Side = shared === 3 ? (c.side === 'F' ? 'B' : 'F') : shared === 1 ? 'F' : 'B';
        const a = padWorld(c, c.pads[i]).at, bb = padWorld(c, c.pads[j]).at;
        const mid: [number, number] = [(a[0] + bb[0]) / 2, (a[1] + bb[1]) / 2];
        bridges++;
        add({ kind: 'solder-bridge', target: id, hops: hopsOfNets([padNets[i], padNets[j]]), apply: (b, _r, ctx) => {
          addBlob(b, mid, layer, gap / 2 + 0.4);
          const cb = (ctx.conn = buildConnectivity(b)), pi = cb.padItem.get(byId(b, id))!;
          if (cb.net[pi[i]] !== cb.net[pi[j]]) return null;
          const repair = (x: Board) => { const bl = x.blobs.find((q) => q.layer === layer && dist(q.at, mid) < 1e-6); if (bl) removeBlob(x, bl); };
          return { kind: 'solder-bridge', ref: c.ref, where: whereNet(mainNet, c.ref), repair, fix: layer === 'F'
            ? t('Solder bridge between {ref} pads {a} and {b} on the top: remove it with the desolder wick.', { ref: c.ref, a: c.pads[i].name, b: c.pads[j].name })
            : t('Solder bridge between {ref} pads {a} and {b} on the bottom: remove it with the desolder wick.', { ref: c.ref, a: c.pads[i].name, b: c.pads[j].name }) };
        } });
      }
    }

    // broken copper near a pin: the part is fine, the board is not
    if (c.kind !== 'testpoint' && c.pads.some((p) => p.net)) add({ kind: 'net-break', target: id, hops: h, apply: (b, r, ctx) => {
      const bc = byId(b, id);
      const f = injectFault(bc, 'net-break', r);
      ctx.conn = buildConnectivity(b);
      // a jumper is the player's repair; the copper itself is what has to come back
      return { kind: 'net-break', ref: c.ref, where: whereNet(netLabel(conn, padNets[f.pad!]), c.ref), fix: f.describe, repair: (x) => clearFault(byId(x, id), `break:${f.pad}`) };
    } });

    if (solver !== 'fast') {
      const cls = SPICE_CLASSES.filter((k) => (k === 'resistor-drift' ? c.kind === 'resistor' : k === 'ic-rail-short' ? c.kind === 'ic' : k === 'liquid-leakage' ? new Set(c.pads.map((p) => p.name)).size >= 2 : c.kind === 'capacitor'));
      for (const k of cls) add({ kind: k, target: id, hops: h, apply: (b, r, _ctx) => {
        let f;
        try { f = injectFault(byId(b, id), k, r); } catch { return null; }
        const fix = k === 'liquid-leakage' ? t('Scrub the residue off {ref} with isopropyl.', { ref: c.ref }) : t('Replace {ref}.', { ref: c.ref });
        const repair = k === 'liquid-leakage'
          ? (x: Board) => { for (let n = 0; n < 6 && byId(x, id).state.residue; n++) cleanWithIpa(x, c.at[0], c.at[1], 2); }
          : (x: Board) => { const p = byId(x, id); installPart(p, { value, reversed: p.state.reversed }); };
        return { kind: k, ref: c.ref, where: whereNet(mainNet, c.ref), fix: `${f.describe} — ${fix}`, repair };
      } });
    }
  }

  // a cracked trace, away from its ends (a cut under a pad would not show)
  const nearestRef = (pt: [number, number]) => g.components.reduce((a, c) => (dist(c.at, pt) < dist(a.at, pt) ? c : a), g.components[0])?.ref ?? '';
  for (const tr of g.traces) {
    const L = dist(tr.a, tr.b);
    if (L < 2.5) continue;
    const item = conn.traceItem.get(tr);
    if (item === undefined) continue;
    const n = conn.net[item];
    add({ kind: 'cut-trace', target: tr.id, hops: hopsOfNets([n]), apply: (b, r, ctx) => {
      const bt = b.traces.find((x) => x.id === tr.id);
      if (!bt) return null;
      const u = 0.3 + r() * 0.4;
      const pt: [number, number] = [tr.a[0] + (tr.b[0] - tr.a[0]) * u, tr.a[1] + (tr.b[1] - tr.a[1]) * u];
      const before = ctx.conn.netCount;
      cutTrace(b, bt, pt, 0.7);
      ctx.conn = buildConnectivity(b);
      if (ctx.conn.netCount === before) return null; // other copper still joins both halves
      const ref = nearestRef(pt), net = netLabel(conn, n);
      const repair = (x: Board) => { addBlob(x, pt, tr.layer, 0.75); }; // the iron drops a blob across the gap
      return { kind: 'cut-trace', ref, where: whereNet(net, ref), repair, fix: tr.layer === 'F'
        ? t('A top trace{net} is cracked near {ref}: bridge the gap with solder or a jumper wire.', { net: net ? ` (${net})` : '', ref })
        : t('A bottom trace{net} is cracked near {ref}: bridge the gap with solder or a jumper wire.', { net: net ? ` (${net})` : '', ref }) };
    } });
  }
  return out;
}

/** One note per place; faults that share one are counted in it. */
function whereHints(faults: GenFault[]): string[] {
  const n = new Map<string, number>();
  for (const f of faults) n.set(f.where, (n.get(f.where) ?? 0) + 1);
  return [...n].map(([w, k]) => (k === 1 ? w : `${w} (×${k})`));
}

/** Puts every part's state and value, the copper and the solder back as they are now. */
function snapshot(b: Board): () => void {
  const comps = b.components.map((c) => [c, c.value, structuredClone(c.state)] as const);
  const traces = b.traces.slice(), blobs = b.blobs.slice(), nextId = b.nextId;
  return () => {
    for (const [c, v, st] of comps) { c.value = v; c.state = st; }
    b.traces = traces; b.blobs = blobs; b.nextId = nextId;
  };
}

/** Fails a bench check without overloading anything. */
function breaksCleanly(b: Board, conn: Conn, objectives: Objective[], solver: Solver): boolean {
  const ev = evaluateObjectives(b, conn, objectives, solver);
  return !ev.allPassed && ev.overloads.length === 0;
}

/**
 * A new problem on `good` (a board that passes every check of `parent`): `opts.faults` faults
 * picked at random, preferring kinds not used yet and parts close to what the checks measure.
 * Null when the board does not pass its checks, or no fault shows on the bench.
 */
export async function generateProblem(parent: Scenario, good: Board, opts: GenerateOptions): Promise<Generated | null> {
  const { solver } = opts;
  const seed = (opts.seed ?? Math.floor(Math.random() * 2 ** 32)) >>> 0;
  const r = rng(seed);
  const budget = opts.budgetMs ?? 8000;
  const t0 = Date.now();
  const objectives = parent.objectives;
  if (!objectives.length) return null;
  const g = structuredClone(good);
  const conn = buildConnectivity(g);
  if (!evaluateObjectives(g, conn, objectives, solver).allPassed) return null;

  const byKind = new Map<GenKind, Candidate[]>();
  for (const c of candidates(g, conn, objectives, solver)) {
    let l = byKind.get(c.kind);
    if (!l) byKind.set(c.kind, (l = []));
    l.push(c);
  }

  const want = Math.max(1, Math.min(3, opts.faults));
  const big = g.components.length > BIG;
  const root = parent.generated ?? { from: parent.id, title: parent.meta.title };
  const id = `gen-${root.from}-${seed.toString(36)}`;
  const reference = topology(g, conn, id); // g is broken in place from here on
  const faults: GenFault[] = [];
  const used = new Set<string>(), usedKinds = new Set<GenKind>();
  let gConn = conn;
  /** An unbroken copy, to check that each later fault also fails the bench on its own. */
  let alone: { b: Board; conn: Conn } | null = null;
  while (faults.length < want && byKind.size && Date.now() - t0 < budget) {
    // a kind first (unused kinds first, so two faults differ), then a part near the checks
    const kinds = [...byKind.keys()];
    const fresh = kinds.filter((k) => !usedKinds.has(k));
    const pool = fresh.length ? fresh : kinds;
    const kind = pool[Math.floor(r() * pool.length)];
    const list = byKind.get(kind)!;
    const w = list.map((c) => 1 / (c.hops * c.hops));
    let x = r() * w.reduce((a, b) => a + b, 0), k = 0;
    while (k < list.length - 1 && (x -= w[k]) > 0) k++;
    const cand = list.splice(k, 1)[0];
    if (!list.length) byKind.delete(kind);
    if (used.has(cand.target)) continue;

    const s = seedOf(`${seed}:${cand.kind}:${cand.target}`);
    // Faults go onto a board in place and come off again when rejected: a Conn is keyed by the
    // board's own objects, so a cached one stays valid only on that board. On a big board a
    // pad-level change (cold, missing) is screened with the cached one, then checked exactly.
    const attempt = (b: Board, base: Conn): { f: GenFault; conn: Conn; undo: () => void } | null => {
      const undo = snapshot(b), ctx: Ctx = { conn: base };
      const f = cand.apply(b, rng(s), ctx);
      if (f) {
        let c = ctx.padsChanged && !big ? buildConnectivity(b) : ctx.conn;
        if (breaksCleanly(b, c, objectives, solver) && (!big || !ctx.padsChanged || breaksCleanly(b, (c = buildConnectivity(b)), objectives, solver))) return { f, conn: c, undo };
      }
      undo();
      return null;
    };
    if (faults.length) {
      if (!alone) { const b = structuredClone(good); alone = { b, conn: buildConnectivity(b) }; }
      const a = attempt(alone.b, alone.conn);
      a?.undo();
      if (!a) { await opts.yieldFn?.(); continue; }
    }
    const res = attempt(g, gConn);
    await opts.yieldFn?.();
    if (!res) continue;
    gConn = res.conn;
    faults.push(res.f);
    used.add(cand.target);
    usedKinds.add(cand.kind);
  }
  if (!faults.length) return null;

  const tag = seed.toString(36).toUpperCase().padStart(7, '0').slice(-4);
  const spice = faults.some((f) => isSpiceKind(f.kind));
  const lock = await lockFlag(`PCB{r3p41r_${tag.toLowerCase()}_${faults.length}x}`, reference);
  const n = faults.length;
  const scenario: Scenario = {
    format: 'pcbfix/1',
    id,
    meta: {
      title: `${t(root.title)} · #${tag}`,
      author: t('DEADBOARD generator'),
      difficulty: Math.min(5, Math.max(parent.meta.difficulty, n + 1)),
      description: t('A new problem on the board you just fixed: same checks, {n} fresh fault.|A new problem on the board you just fixed: same checks, {n} fresh faults.', { n }),
      hints: [
        t('Start from the failing check and measure outward from it.'),
        ...whereHints(faults),
        ...faults.map((f) => f.fix),
      ],
      par: n,
      ...(parent.meta.credits && { credits: parent.meta.credits }),
      ...(parent.meta.license && { license: parent.meta.license }),
      ...(parent.meta.source && { source: parent.meta.source }),
    },
    board: g,
    objectives,
    lock,
    ...((parent.solver || (spice && solver !== 'fast')) && { solver: parent.solver ?? solver }),
    ...(parent.calibration && { calibration: parent.calibration }),
    generated: root,
  };
  setReference(scenario, structuredClone(good)); // the fixed board it was broken from («Where to look?»)
  return { scenario, faults };
}
