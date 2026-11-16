// Drop-in replacement for `simulate` / `measureOhms` / `measureDiode` (src/sim.ts) that
// solves the board with the SPICE engine instead of the piecewise-linear DC solver.
import type { Board } from '../types';
import type { Conn } from '../connectivity';
import { batteryRint } from '../model';
import { LED_MAX_I, LED_ON_I, type CompSim, type Sim, type SimOpts } from '../sim';
import { boardToCircuit, type BoardNetlist, type BoardSpiceOptions } from './board';
import { Engine, type EngineOptions, type OpResult } from './engine';
import { discoverPowerTree } from './powertree';
import { powerTreeElements } from './powermodels';
import { POWER_STATES, enablesForState, type PowerStateName } from './sequencer';
import { estimateRailLoads, loadWatts } from './loads';

/** Last solution by unknown name: warm start for the next solve of a similar circuit. */
let warm: Map<string, number> | null = null;

export interface SpiceSim extends Sim {
  netlist: BoardNetlist;
  op: OpResult;
  /** Injection supply operating point (set voltage after current limiting, current). */
  injected?: { v: number; i: number };
  /** Current through the ammeter (red → black), when one was attached. */
  ammeterAmps?: number;
}

export interface SpiceSimOpts extends SimOpts {
  library?: BoardSpiceOptions['library'];
  engine?: Partial<EngineOptions>;
  /** Voltmeters attached during the solve: [red net, black net (-1 = supply ground)]. */
  meters?: [number, number][];
  /** Voltmeter input impedance (default 10 MΩ). */
  meterOhms?: number;
  /** Add behavioral regulators discovered from the board's power tree (needs only net names). */
  powerTree?: boolean;
  /**
   * With powerTree: emulate the power controller in this machine state — drive the enables the
   * state asserts (push-pull through 1 kΩ, others de-asserted) and load each rail with its
   * estimated consumption for the state (src/spice/loads.ts).
   */
  powerState?: PowerStateName;
  /** Multiplier on the estimated rail loads (from a calibration against a real board; default 1). */
  loadScale?: number;
  /**
   * Voltage injection: a current-limited bench supply clipped onto `net` (vs ground) with the
   * board's own supply removed — the standard way to make a shorted rail's culprit heat up.
   */
  inject?: { net: number; volts: number; amps: number };
  /** Ammeter between two nets (red, black): a low-ohm shunt; its current is returned as `ammeterAmps`. */
  ammeter?: { a: number; b: number; ohms: number };
}

const ENGINE_DEFAULTS: Partial<EngineOptions> = { gshunt: 1e-12 };

function emptySim(): Sim {
  return { nodeOfNet: new Map(), V: new Float64Array(0), ground: -1, comps: new Map(), source: false };
}

export function simulateSpice(board: Board, conn: Conn, opt: SpiceSimOpts = {}): Sim | SpiceSim {
  const probe = opt.ohm ?? opt.diode;
  const nl = boardToCircuit(board, conn, {
    switches: opt.switches,
    library: opt.library,
    unmodeled: 'omit',
    sources: !probe && !opt.inject,
    diodesOpen: !!opt.ohm,
    groundNet: probe ? probe[1] : undefined,
  });
  const ckt = nl.circuit;

  if (probe) {
    if (probe[0] === probe[1]) return emptySim();
    const aNode = nl.netNode.get(probe[0]);
    if (!aNode || !nl.netNode.has(probe[1])) return emptySim();
    if (opt.ohm) {
      ckt.elements.push({ kind: 'I', name: 'I_OHMMETER', n: ['0', aNode], wave: { type: 'dc', v: 1e-3 } });
    } else {
      ckt.elements.push({ kind: 'V', name: 'V_DIODETEST', n: ['dmm_src', '0'], wave: { type: 'dc', v: 3.3 } });
      ckt.elements.push({ kind: 'R', name: 'R_DIODETEST', n: ['dmm_src', aNode], value: 3300 });
    }
  } else if (opt.inject) {
    const n = nl.netNode.get(opt.inject.net);
    if (!n || n === '0') return emptySim();
    ckt.elements.push({ kind: 'V', name: 'V_INJECT', n: ['inj_src', '0'], wave: { type: 'dc', v: opt.inject.volts } }, { kind: 'R', name: 'R_INJECT', n: ['inj_src', n], value: 0.05 });
  } else {
    const anySupply = [...nl.parts.values()].some((p) => p.type === 'battery' && p.device);
    if (!anySupply) return emptySim();
    // A real DMM loads the node it measures; this matters on high-impedance nets
    // (e.g. an unloaded diode output, where an ideal probe would read the open-circuit EMF).
    const seen = new Set<string>();
    for (const [red, black] of opt.meters ?? []) {
      const a = nl.netNode.get(red);
      const b = black < 0 ? '0' : nl.netNode.get(black);
      if (!a || !b || a === b || seen.has(a + '|' + b)) continue;
      seen.add(a + '|' + b);
      ckt.elements.push({ kind: 'R', name: `R_DMM${seen.size}`, n: [a, b], value: opt.meterOhms ?? 10e6, note: 'voltmeter input impedance' });
    }
    if (opt.ammeter) {
      const a = nl.netNode.get(opt.ammeter.a), b = nl.netNode.get(opt.ammeter.b);
      if (a && b && a !== b) ckt.elements.push({ kind: 'R', name: 'R_AMMETER', n: [a, b], value: opt.ammeter.ohms, note: 'ammeter shunt + leads' });
    }
  }

  if (opt.powerTree && !probe) {
    const tree = discoverPowerTree(board, conn);
    const nameToNode = new Map<string, string>();
    for (const [net, node] of nl.netNode) if (!nameToNode.has(conn.netNames[net])) nameToNode.set(conn.netNames[net], node);
    const simulatedRefs = new Set([...nl.parts.values()].filter((p) => p.device).map((p) => p.comp.ref));
    const stateRank = opt.powerState ? POWER_STATES.find((s) => s.name === opt.powerState)!.rank : undefined;
    const deadRefs = new Set(board.components.filter((c) => c.state.burnt).map((c) => c.ref));
    const on = opt.powerState ? new Set(enablesForState(tree, opt.powerState).map((d) => d.net)) : null;
    const managed = opt.powerState ? new Set(enablesForState(tree, 'S0SW').map((d) => d.net)) : null;
    const enableAsserted = on && managed ? (net: string) => (managed.has(net) ? on.has(net) : undefined) : undefined;
    ckt.elements.push(...powerTreeElements(tree, (n) => nameToNode.get(n), { simulatedRefs, stateRank, deadRefs, enableAsserted }).elements);
    // A resistor the power tree sees linking two rails (PPBUS → PPBUS_R, sense resistors, 0 Ω
    // links) whose value is only an importer placeholder would choke the power path; such
    // links are near 0 Ω on real boards, so model them so (the note says it was assumed).
    for (const s of tree.sources) {
      if (s.kind !== 'pass-through') continue;
      const c = board.components.find((x) => x.ref === s.ref);
      if (!c || c.kind !== 'resistor' || !c.valueGuessed || c.value <= 0.1) continue;
      const dev = [...nl.parts.values()].find((p) => p.comp === c)?.device;
      const el = dev ? ckt.elements.find((e) => e.name === dev && e.kind === 'R') : undefined;
      if (el && el.kind === 'R') { el.value = 0.01; el.note = `${c.ref}: value unknown; assumed ~0 Ω (power link ${s.input} → ${s.output})`; }
    }
    if (opt.powerState && on) {
      enablesForState(tree, 'S0SW').forEach((d, i) => {
        const n = nameToNode.get(d.net);
        if (!n || n === '0') return;
        const high = on.has(d.net) === (d.level === 'high');
        ckt.elements.push(
          { kind: 'V', name: `V_EC${i}`, n: [`ec${i}`, '0'], wave: { type: 'dc', v: high ? 3.3 : 0 }, note: `controller drives ${d.net}` },
          { kind: 'R', name: `R_EC${i}`, n: [`ec${i}`, n], value: 50, note: 'controller push-pull output' },
        );
      });
      estimateRailLoads(board, conn, tree).forEach((l, i) => {
        const n = nameToNode.get(l.rail);
        const w = loadWatts(l, opt.powerState!) * (opt.loadScale ?? 1);
        if (!n || n === '0' || !(w > 0)) return;
        ckt.elements.push({ kind: 'R', name: `R_LOAD${i}`, n: [n, '0'], value: (l.v * l.v) / w, note: `${l.rail}: estimated load ${w.toFixed(3)} W (${l.caps} decoupling caps)` });
      });
    }
  }
  const engine = new Engine(ckt, { ...ENGINE_DEFAULTS, ...opt.engine });
  let x0: Float64Array | undefined;
  if (warm && !probe) {
    x0 = new Float64Array(engine.size);
    engine.unknownNames.forEach((n, i) => { x0![i] = warm!.get(n) ?? 0; });
  }
  let op = engine.op(x0);
  if (op.converged && !probe) warm = new Map(engine.unknownNames.map((n, i) => [n, op.x[i]]));

  // Bench-supply constant-current limit: lower the source EMF until its current is at the limit.
  let ccLimited = false;
  if (opt.currentLimit && !probe) {
    for (let iter = 0; iter < 8; iter++) {
      let adjusted = false;
      for (const p of nl.parts.values()) {
        if (p.type !== 'battery' || !p.device) continue;
        const emf = (op.devices.get(p.device)?.v ?? 0);
        const ib = -(op.branches.get(`i(${p.device})`) ?? 0);
        if (ib > opt.currentLimit * 1.02) {
          ccLimited = true;
          const rint = batteryRint(p.comp.value);
          const vterm = emf - ib * rint;
          const rLoad = Math.max(0, vterm / Math.max(1e-6, ib));
          const next = Math.min(p.comp.value, opt.currentLimit * (rLoad + rint));
          if (Math.abs(next - emf) > 1e-3) { engine.setDc(p.device, next); adjusted = true; }
        }
      }
      if (!adjusted) break;
      op = engine.op();
    }
  }

  // Injection supply: constant-current limit (lower the set voltage until I = limit).
  let injected: { v: number; i: number } | undefined;
  if (opt.inject) {
    let vset = opt.inject.volts;
    for (let k = 0; k < 12; k++) {
      const i = -(op.branches.get('i(V_INJECT)') ?? 0);
      if (i <= opt.inject.amps * 1.01 || vset < 1e-3) { injected = { v: vset, i }; break; }
      const vterm = vset - i * 0.05;
      const rload = Math.max(1e-4, vterm / i);
      vset = Math.max(0, opt.inject.amps * (rload + 0.05));
      engine.setDc('V_INJECT', vset);
      op = engine.op(op.x);
      ccLimited = true;
      injected = { v: vset, i: -(op.branches.get('i(V_INJECT)') ?? 0) };
    }
  }

  // Map SPICE node voltages back onto connectivity nets.
  const nodeOfNet = new Map<number, number>();
  const vals: number[] = [];
  let ground = -1;
  for (const [net, name] of nl.netNode) {
    if (name !== '0' && !engine.hasNode(name)) continue;
    const k = vals.length;
    nodeOfNet.set(net, k);
    vals.push(name === '0' ? 0 : engine.voltage(op.x, name) ?? 0);
    if (name === '0') ground = k;
  }
  const V = Float64Array.from(vals);

  const comps = new Map<string, CompSim>();
  const netV = (net: number) => { const k = nodeOfNet.get(net); return k === undefined ? 0 : V[k]; };
  for (const p of nl.parts.values()) {
    const c = p.comp;
    const dev = p.device ? op.devices.get(p.device) : undefined;
    let i = dev?.i ?? 0;
    let v = dev?.v ?? 0;
    if (p.type === 'battery') {
      i = dev ? -(op.branches.get(`i(${p.device})`) ?? 0) : 0;
      const a = c.pins['+'], b = c.pins['-'];
      v = a && b ? netVForRole(conn, c, '+', netV) - netVForRole(conn, c, '-', netV) : v;
    } else if (!dev && p.roles) {
      v = netVForRole(conn, c, p.roles[0], netV) - netVForRole(conn, c, p.roles[1], netV);
    }
    const r: CompSim = { i, v, p: Math.abs(v * i), on: false, bright: 0, over: false };
    if (c.kind === 'led') {
      r.on = i >= LED_ON_I;
      r.bright = i > 3e-4 ? Math.min(1, Math.max(0.12, i / 0.015)) : 0;
      if (i > LED_MAX_I) { r.over = true; r.overMsg = `burned out — ${(i * 1000).toFixed(0)} mA through an LED rated ${LED_MAX_I * 1000} mA`; }
    } else if (c.kind === 'diode' && Math.abs(i) > 1) {
      r.over = true; r.overMsg = `overheated at ${i.toFixed(2)} A`;
    } else if (c.kind === 'resistor' && r.p > (c.rating ?? 0.5)) {
      r.over = true; r.overMsg = `went up in smoke dissipating ${r.p.toFixed(2)} W (rated ${c.rating ?? 0.5} W)`;
    } else if (c.kind === 'fuse' && Math.abs(i) > c.value) {
      r.over = true; r.overMsg = `blew at ${Math.abs(i).toFixed(2)} A (rated ${c.value} A)`;
    }
    comps.set(c.id, r);
  }

  // Power burned inside a fault (leak across a part, resistive cold joint) heats that part.
  const devName = (ref: string, suffix: string) => ((ref[0]?.toUpperCase() === 'R' ? ref : 'R' + ref) + suffix).replace(/[^A-Za-z0-9_.+\-/]/g, '_');
  for (const c of board.components) {
    if (!c.state.leak && !c.state.coldOhms) continue;
    let extra = op.devices.get(devName(c.ref, '_LEAK'))?.p ?? 0;
    for (const pi of Object.keys(c.state.coldOhms ?? {})) extra += op.devices.get(devName(c.ref, `_COLD${pi}`))?.p ?? 0;
    if (!(extra > 0)) continue;
    const cs = comps.get(c.id) ?? { i: 0, v: 0, p: 0, on: false, bright: 0, over: false };
    cs.p += extra;
    comps.set(c.id, cs);
  }

  const amm = op.devices.get('R_AMMETER');
  const sim: SpiceSim = { nodeOfNet, V, ground, comps, source: op.converged, ccLimited, netlist: nl, op, injected, ...(opt.ammeter && { ammeterAmps: amm ? amm.i : 0 }) };
  return sim;
}

function netVForRole(conn: Conn, c: Board['components'][number], role: string, netV: (n: number) => number): number {
  const idx = conn.padItem.get(c);
  const pad = c.pins[role];
  if (!idx || pad === undefined) return 0;
  const pi = c.pads.findIndex((p, k) => p.name === pad && !c.state.cold.includes(k));
  return pi < 0 ? 0 : netV(conn.net[idx[pi]]);
}

/** In-circuit resistance between two nets with the supply removed (Infinity = open). */
export function measureOhmsSpice(board: Board, conn: Conn, a: number, b: number, library?: SpiceSimOpts['library']): number {
  if (a < 0 || b < 0) return Infinity;
  if (a === b) return 0;
  const s = simulateSpice(board, conn, { ohm: [a, b], library });
  if (!s.source) return Infinity;
  const k = s.nodeOfNet.get(a);
  if (k === undefined) return Infinity;
  const r = s.V[k] / 1e-3;
  return r > 2e7 ? Infinity : r;
}

/** Diode-test mode (3.3 V through 3.3 kΩ) with the supply removed. */
export function measureDiodeSpice(board: Board, conn: Conn, a: number, b: number, library?: SpiceSimOpts['library']): { volts: number; litIds: string[] } {
  if (a < 0 || b < 0) return { volts: Infinity, litIds: [] };
  if (a === b) return { volts: 0, litIds: [] };
  const s = simulateSpice(board, conn, { diode: [a, b], library });
  if (!s.source) return { volts: Infinity, litIds: [] };
  const k = s.nodeOfNet.get(a);
  const v = k === undefined ? 3.3 : s.V[k];
  const litIds: string[] = [];
  for (const c of board.components) if (c.kind === 'led' && (s.comps.get(c.id)?.i ?? 0) > 1e-4) litIds.push(c.id);
  return { volts: v >= 3.25 ? Infinity : Math.max(0, v), litIds };
}
