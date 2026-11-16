// Board (+ connectivity) → SPICE Circuit.
//
// Works for every board source (built-in, KiCad, boardview .brd) and honours the
// game state: burnt parts are open, cold joints float their pad, reversed parts swap
// their pins, open switches are open, unpopulated footprints are omitted. Electrical
// nodes are the copper islands found by `buildConnectivity`, so cuts, solder blobs and
// jumper wires change the netlist exactly as they change the copper.
//
// Boardview files carry refdes, pin XY and net names but no part values, part numbers
// or pinouts. Values therefore come from (in priority order) a per-board part library,
// the board model, or — with `infer` — net-name heuristics; parts nobody can model
// (ICs, connectors, unknown transistors) become high-impedance stubs that keep their
// connectivity visible in the netlist and can be replaced by real `.subckt` models.
import type { Board, Component, SwitchMap } from '../types';
import { pinNet, type Conn } from '../connectivity';
import { LED_INFO, MODELED, batteryRint, parseValue, rolePadName, twoRoles } from '../model';
import type { Analysis, Circuit, Element, Model, ModelType, Subckt } from './types';
import { emptyCircuit } from './types';
import { parseSpice } from './netlist';
import { parseSpiceNumber } from './units';
import { VT_300K } from './devices';

// ---------------- part library ----------------

export type PartType =
  | 'R' | 'C' | 'L' | 'D' | 'LED' | 'NMOS' | 'PMOS' | 'NPN' | 'PNP' | 'V'
  | 'short' | 'open' | 'subckt' | 'stub' | 'fuse';

export interface PartSpec {
  type: PartType;
  /** Ohms / farads / henries / volts; numbers or SPICE strings ("4.7k", "10u"). */
  value?: number | string;
  /** Inductor DC resistance (Ω). */
  dcr?: number | string;
  /** Capacitor equivalent series resistance (Ω). */
  esr?: number | string;
  /** Electrical role → pad name. R/C/L/short: 1,2 · D/LED: A,K · MOS: D,G,S · BJT: C,B,E · V: +,- */
  pins?: Record<string, string>;
  /** Model: name of an entry in `library.models`, or inline parameters. */
  model?: string | Record<string, number>;
  /** For `subckt`: pad names in port order, and the subcircuit body (SPICE cards). */
  ports?: string[];
  spice?: string;
  note?: string;
}

export interface PartLibrary {
  /** Shared device models, e.g. { "AON7403": { type: "PMOS", params: { vto: -1.8, kp: 30 } } } */
  models?: Record<string, { type: ModelType; params: Record<string, number> }>;
  /** Exact refdes → part. */
  parts?: Record<string, PartSpec>;
  /** Regex on refdes → part, first match wins (applied when `parts` has no entry). */
  patterns?: { match: string; spec: PartSpec }[];
}

export type Provenance = 'board' | 'library' | 'inferred' | 'stub' | 'omitted';

export interface PartReport {
  ref: string;
  as: string;
  source: Provenance;
  note?: string;
}

export interface PartMap {
  comp: Component;
  /** Primary SPICE device for current/power read-back (flattened name). */
  device?: string;
  /** Roles (first → second) that define the sign of the reported current. */
  roles?: [string, string];
  type: PartType | 'battery' | 'fuse' | 'switch';
}

export interface BoardSpiceOptions {
  title?: string;
  library?: PartLibrary;
  switches?: SwitchMap;
  /** Parts without any model: 'stub' (hi-Z subckt, default) or 'omit'. */
  unmodeled?: 'stub' | 'omit';
  /** Stub pin-to-ground resistance. */
  stubOhms?: number;
  /**
   * Model unmodelled ICs' pins with their ESD protection: a diode from the IC's ground to every
   * other pin (standard CMOS I/O structure). Gives realistic diode-mode readings to ground.
   */
  esdPins?: boolean;
  /** Replace the .brd importer's placeholder values (R = 1 kΩ, C = 100 nF) using net-name heuristics. */
  infer?: boolean;
  /** Include supplies (battery parts) as voltage sources. Default true. */
  sources?: boolean;
  /** Treat diodes/LEDs as open (low-power ohmmeter). */
  diodesOpen?: boolean;
  /** Force this connectivity net to be SPICE ground. */
  groundNet?: number;
  /** Refdes to leave out entirely. */
  exclude?: string[];
  analyses?: Analysis[];
  /** Extra header lines. */
  comments?: string[];
}

export interface BoardNetlist {
  circuit: Circuit;
  /** Connectivity net index → SPICE node name. */
  netNode: Map<number, string>;
  /** Connectivity net mapped to node "0" (-1 if none). */
  groundNet: number;
  parts: Map<string, PartMap>;
  report: PartReport[];
  warnings: string[];
}

// ---------------- device model helpers ----------------

/** LED model whose forward drop at 1 mA matches the game's colour Vf. */
export function ledModel(color: keyof typeof LED_INFO): Model {
  const vf = LED_INFO[color].vf;
  const N = 2, RS = 10;
  const IS = 1e-3 * Math.exp(-(vf + 0.005 - RS * 1e-3) / (N * VT_300K));
  return { name: `LED_${color.toUpperCase()}`, type: 'D', params: { is: +IS.toPrecision(4), n: N, rs: RS } };
}
export const DIODE_MODEL: Model = { name: 'DGEN', type: 'D', params: { is: 1e-14, n: 1, rs: 0.5 } };

const isGndName = (n: string) => /^(GND|VSS|AGND|DGND|PGND|GND_\w+|0)$/i.test(n);
const isRailName = (n: string) => /^(PP|VCC|VDD|VBAT|VIN|VBUS|\+?\d+V\d*|P\d+V\d*)/i.test(n);

function sanitize(name: string): string {
  const s = name.replace(/[^A-Za-z0-9_.+\-/]/g, '_');
  return s || 'N';
}

const toNum = (v: number | string | undefined, d: number): number => {
  if (v === undefined) return d;
  if (typeof v === 'number') return v;
  const a = parseSpiceNumber(v);
  if (isFinite(a)) return a;
  const b = parseValue(v);
  return isFinite(b) ? b : d;
};

// ---------------- value inference (boardview placeholders) ----------------

function baseName(n: string): string {
  return n.replace(/(_R|_RC|_CONN|_C|_F|_FILT|_L|_R\d|_BUF|_ESD)$/i, '');
}

function inferR(a: string, b: string): [number, string] {
  const ga = isGndName(a), gb = isGndName(b), ra = isRailName(a), rb = isRailName(b);
  if ((ga && rb) || (gb && ra)) return [100e3, 'rail↔GND bleeder'];
  if (ra && rb) return [0.01, 'rail↔rail power-path / sense'];
  if (ga || gb) return [/(DIV|FB)/i.test(ga ? b : a) ? 47e3 : 100e3, /(DIV|FB)/i.test(ga ? b : a) ? 'divider bottom' : 'pull-down'];
  if (ra || rb) return [100e3, 'pull-up'];
  if (baseName(a) === baseName(b) || a.startsWith(b) || b.startsWith(a)) return [33, 'series termination'];
  return [10e3, 'signal↔signal'];
}

function inferC(a: string, b: string): [number, string] {
  const ga = isGndName(a), gb = isGndName(b), ra = isRailName(a), rb = isRailName(b);
  if ((ga && rb) || (gb && ra)) {
    const rail = ga ? b : a;
    return /(BUS|VIN|VBAT|DCIN|HV|CHGR)/i.test(rail) ? [10e-6, 'bulk decoupling'] : [1e-6, 'decoupling'];
  }
  if (ga || gb) return [1e-9, 'signal filter'];
  return [100e-9, 'AC coupling'];
}

// ---------------- converter ----------------

export function boardToCircuit(board: Board, conn: Conn, opts: BoardSpiceOptions = {}): BoardNetlist {
  const lib = opts.library ?? {};
  const circuit = emptyCircuit(opts.title ?? 'pcbfix board');
  const warnings: string[] = [];
  const report: PartReport[] = [];
  const parts = new Map<string, PartMap>();
  const exclude = new Set(opts.exclude ?? []);
  const withSources = opts.sources !== false;

  // --- ground net ---
  let groundNet = opts.groundNet ?? -1;
  if (groundNet < 0) {
    const named = conn.netNames.findIndex((n) => /^GND$/i.test(n));
    groundNet = named >= 0 ? named : conn.netNames.findIndex((n) => isGndName(n));
  }
  if (groundNet < 0) {
    for (const c of board.components) {
      if (c.kind === 'battery' && c.state.populated && c.pins['-']) {
        const n = pinNet(conn, c, '-');
        if (n >= 0) { groundNet = n; break; }
      }
    }
  }
  if (groundNet < 0) warnings.push('No GND net or supply found; node voltages are referenced to gshunt only.');

  // --- node naming ---
  const netNode = new Map<number, string>();
  const used = new Set<string>(['0', 'gnd']);
  const node = (net: number): string => {
    if (net === groundNet) return '0';
    let s = netNode.get(net);
    if (s) return s;
    s = sanitize(conn.netNames[net] ?? `N${net}`);
    if (used.has(s.toLowerCase())) s = `${s}_n${net}`;
    used.add(s.toLowerCase());
    netNode.set(net, s);
    return s;
  };
  if (groundNet >= 0) netNode.set(groundNet, '0');
  const floating = (c: Component, what: string) => {
    const s = sanitize(`NC_${c.ref}_${what}`);
    let name = s, k = 1;
    while (used.has(name.toLowerCase())) name = `${s}_${k++}`;
    used.add(name.toLowerCase());
    return name;
  };
  // A cold joint with a known resistance is a series resistor between the part's terminal and
  // its copper; without one it is open (terminal floats).
  const coldJoint = (c: Component, padName: string, what: string): string | null => {
    const idx = conn.padItem.get(c);
    if (!idx) return null;
    for (let pi = 0; pi < c.pads.length; pi++) {
      if (c.pads[pi].name !== padName || !c.state.cold.includes(pi)) continue;
      const ohms = c.state.coldOhms?.[pi];
      if (ohms === undefined || !(ohms > 0)) continue;
      // copper side of the joint: the pad's island, or — on name-connected boards where the cold
      // pad was left out of its net — the net it is declared on
      let net = conn.net[idx[pi]];
      const declared = c.pads[pi].net;
      if (conn.netItems[net].length === 1 && declared) {
        const alt = conn.netNames.findIndex((nm, k) => nm === declared && k !== net);
        if (alt >= 0) net = alt;
      }
      const term = floating(c, what);
      els.push({ kind: 'R', name: elName('R', c.ref, `_COLD${pi}`), n: [term, node(net)], value: ohms, note: `${c.ref} pad ${padName}: cold joint ${ohms} Ω` });
      return term;
    }
    return null;
  };
  const roleNode = (c: Component, role: string) => {
    const n = pinNet(conn, c, role);
    if (n >= 0) return node(n);
    const pad = c.state.populated ? rolePadName(c, role) : undefined;
    return (pad !== undefined && coldJoint(c, pad, role)) || floating(c, role);
  };
  const padNode = (c: Component, pad: string) => {
    const idx = conn.padItem.get(c);
    if (idx) {
      for (let pi = 0; pi < c.pads.length; pi++) {
        if (c.pads[pi].name === pad && !c.state.cold.includes(pi)) return node(conn.net[idx[pi]]);
      }
    }
    if (!c.pads.some((p) => p.name === pad)) warnings.push(`${c.ref}: library pin refers to missing pad "${pad}"`);
    return coldJoint(c, pad, pad) || floating(c, pad);
  };
  const drift = (c: Component) => (c.state.drift && c.state.drift > 0 ? c.state.drift : 1);

  // --- element naming ---
  const names = new Set<string>();
  const elName = (letter: string, ref: string, suffix = '') => {
    const base = sanitize((ref[0]?.toUpperCase() === letter ? ref : letter + ref) + suffix);
    let s = base, k = 1;
    while (names.has(s.toLowerCase())) s = `${base}_${k++}`;
    names.add(s.toLowerCase());
    return s;
  };
  const els = circuit.elements;
  const models = new Map<string, Model>();
  const useModel = (m: Model) => { if (!models.has(m.name.toLowerCase())) models.set(m.name.toLowerCase(), m); return m.name; };
  const subckts = new Map<string, Subckt>();

  const libModel = (spec: PartSpec, fallbackType: ModelType, ref: string): string => {
    if (typeof spec.model === 'string') {
      const m = lib.models?.[spec.model];
      if (!m) { warnings.push(`${ref}: unknown library model "${spec.model}", using defaults`); return useModel({ name: `${ref}_M`, type: fallbackType, params: {} }); }
      return useModel({ name: sanitize(spec.model), type: m.type, params: lowerKeys(m.params) });
    }
    return useModel({ name: sanitize(`${ref}_M`), type: fallbackType, params: lowerKeys(spec.model ?? {}) });
  };

  const specFor = (ref: string): PartSpec | undefined => {
    const p = lib.parts?.[ref];
    if (p) return p;
    for (const pat of lib.patterns ?? []) if (new RegExp(pat.match).test(ref)) return pat.spec;
    return undefined;
  };

  const esd = (c: Component) => {
    if (!opts.esdPins || !/^U\d/.test(c.ref)) return;
    const nodes = new Set<string>();
    let gnd: string | undefined;
    c.pads.forEach((p) => {
      const n = padNode(c, p.name);
      // the IC's ground is its declared ground net (node 0 may just be the meter's COM probe)
      if (isGndName(p.net ?? '')) gnd ??= n; else if (!n.startsWith('NC_')) nodes.add(n);
    });
    if (!gnd || nodes.size === 0) return;
    nodes.delete(gnd);
    const model = useModel({ name: 'DESD', type: 'D', params: { is: 1e-12, n: 1.05, rs: 5 } });
    let k = 0;
    for (const n of nodes) els.push({ kind: 'D', name: elName('D', c.ref, `_ESD${++k}`), n: [gnd, n], model, note: `${c.ref} pin ESD diode (generic CMOS I/O)` });
  };
  const stub = (c: Component, why: string) => {
    esd(c);
    if (opts.unmodeled === 'omit') { report.push({ ref: c.ref, as: 'omitted', source: 'omitted', note: why }); return; }
    const nodes: string[] = [];
    const seen = new Set<string>();
    c.pads.forEach((p) => {
      const n = padNode(c, p.name);
      if (n === '0' || seen.has(n.toLowerCase())) return;
      seen.add(n.toLowerCase());
      nodes.push(n);
    });
    if (!nodes.length) { report.push({ ref: c.ref, as: 'omitted', source: 'omitted', note: 'all pins on ground' }); return; }
    const sname = `HIZ${nodes.length}`;
    if (!subckts.has(sname)) {
      const r = opts.stubOhms ?? 100e6;
      subckts.set(sname, {
        name: sname,
        ports: nodes.map((_, i) => `p${i + 1}`),
        elements: nodes.map((_, i) => ({ kind: 'R', name: `R${i + 1}`, n: [`p${i + 1}`, '0'], value: r } as Element)),
        models: [],
        note: `High-impedance placeholder for an unmodelled ${nodes.length}-net part (replace with a real model)`,
      });
    }
    els.push({ kind: 'X', name: elName('X', c.ref), n: nodes, subckt: sname, note: `${c.ref}: ${why}; ${c.pads.length} pads, ${nodes.length} non-ground nets` });
    report.push({ ref: c.ref, as: sname, source: 'stub', note: why });
  };

  const two = (c: Component): [string, string] | null => twoRoles(c);

  for (const c of board.components) {
    if (exclude.has(c.ref)) continue;
    if (!c.state.populated) { report.push({ ref: c.ref, as: 'unpopulated', source: 'omitted' }); continue; }

    if (c.state.leak && c.state.leak.ohms > 0) {
      const pads = [...new Set(c.pads.map((p) => p.name))];
      const pa = c.state.leak.a ?? pads[0], pb = c.state.leak.b ?? pads[1];
      if (pa && pb && pa !== pb) els.push({ kind: 'R', name: elName('R', c.ref, '_LEAK'), n: [padNode(c, pa), padNode(c, pb)], value: c.state.leak.ohms, note: `${c.ref}: fault, ${c.state.leak.ohms} Ω between pads ${pa} and ${pb}` });
    }
    const spec = specFor(c.ref);
    if (spec) {
      if (c.state.burnt) { report.push({ ref: c.ref, as: 'burnt (open)', source: 'omitted' }); continue; }
      emitSpec(c, spec);
      continue;
    }

    if (!MODELED.has(c.kind)) {
      if (c.kind === 'testpoint') continue;
      stub(c, c.kind === 'ic' ? 'IC (no model)' : c.kind === 'connector' ? 'connector' : 'unknown part');
      continue;
    }
    const roles = two(c);
    if (!roles) { stub(c, 'missing pin roles'); continue; }
    const a = roleNode(c, roles[0]), b = roleNode(c, roles[1]);
    const note = (extra = '') => `${c.ref}${extra ? ' ' + extra : ''}`;
    if (c.state.burnt) {
      report.push({ ref: c.ref, as: 'burnt (open)', source: 'omitted' });
      parts.set(c.id, { comp: c, roles, type: c.kind === 'fuse' ? 'fuse' : 'R' });
      continue;
    }
    switch (c.kind) {
      case 'resistor': {
        if (c.label === 'Inductor') {
          // The board model only knows the DC resistance; inductance is a placeholder.
          const dcr = Math.max(c.value, 1e-4);
          const mid = elName('L', c.ref);
          const midNode = floating(c, 'dcr');
          els.push({ kind: 'L', name: mid, n: [a, midNode], value: 1e-6, note: note('inductor, L assumed 1uH') });
          els.push({ kind: 'R', name: elName('R', c.ref, '_DCR'), n: [midNode, b], value: dcr, note: note('DCR') });
          parts.set(c.id, { comp: c, device: mid, roles, type: 'L' });
          report.push({ ref: c.ref, as: `L 1uH + ${dcr}Ω DCR`, source: 'inferred' });
          break;
        }
        let r = Math.max(c.value * drift(c), 1e-3), src: Provenance = 'board', why = '';
        if (opts.infer && c.value === 1000) {
          [r, why] = inferR(conn.netNames[pinNet(conn, c, roles[0])] ?? '', conn.netNames[pinNet(conn, c, roles[1])] ?? '');
          src = 'inferred';
        }
        const name = elName('R', c.ref);
        els.push({ kind: 'R', name, n: [a, b], value: r, note: note(src === 'inferred' ? `inferred: ${why}` : c.label ?? '') });
        parts.set(c.id, { comp: c, device: name, roles, type: 'R' });
        report.push({ ref: c.ref, as: `R ${r}`, source: src, note: why || undefined });
        break;
      }
      case 'capacitor': {
        let v = c.value * drift(c), src: Provenance = 'board', why = '';
        if (opts.infer && Math.abs(c.value - 1e-7) < 1e-12) {
          [v, why] = inferC(conn.netNames[pinNet(conn, c, roles[0])] ?? '', conn.netNames[pinNet(conn, c, roles[1])] ?? '');
          src = 'inferred';
        }
        const name = elName('C', c.ref);
        els.push({ kind: 'C', name, n: [a, b], value: v > 0 ? v : 1e-12, note: note(src === 'inferred' ? `inferred: ${why}` : '') });
        parts.set(c.id, { comp: c, device: name, roles, type: 'C' });
        report.push({ ref: c.ref, as: `C ${v}`, source: src, note: why || undefined });
        break;
      }
      case 'fuse': {
        const name = elName('R', c.ref);
        els.push({ kind: 'R', name, n: [a, b], value: 0.1, note: note(`fuse ${c.value} A (0.1 Ω cold resistance)`) });
        parts.set(c.id, { comp: c, device: name, roles, type: 'fuse' });
        report.push({ ref: c.ref, as: 'fuse 0.1Ω', source: 'board' });
        break;
      }
      case 'switch': {
        const closed = opts.switches?.[c.ref] ?? !!c.state.closed;
        parts.set(c.id, { comp: c, roles, type: 'switch' });
        if (closed) {
          const name = elName('R', c.ref);
          els.push({ kind: 'R', name, n: [a, b], value: 0.02, note: note('switch closed') });
          parts.get(c.id)!.device = name;
        }
        report.push({ ref: c.ref, as: closed ? 'switch closed (20 mΩ)' : 'switch open', source: 'board' });
        break;
      }
      case 'led': case 'diode': {
        parts.set(c.id, { comp: c, roles, type: c.kind === 'led' ? 'LED' : 'D' });
        if (opts.diodesOpen) break;
        const model = useModel(c.kind === 'led' ? ledModel(c.color ?? 'red') : DIODE_MODEL);
        const name = elName('D', c.ref);
        els.push({ kind: 'D', name, n: [a, b], model, note: note(c.kind === 'led' ? `${c.color ?? 'red'} LED` : '') });
        parts.get(c.id)!.device = name;
        report.push({ ref: c.ref, as: `D ${model}`, source: 'board' });
        break;
      }
      case 'battery': {
        parts.set(c.id, { comp: c, roles, type: 'battery' });
        if (!withSources) break;
        const rint = batteryRint(c.value);
        const vname = elName('V', c.ref);
        const mid = floating(c, 'int');
        els.push({ kind: 'R', name: elName('R', c.ref, '_RINT'), n: [a, mid], value: rint, note: note('source internal resistance') });
        els.push({ kind: 'V', name: vname, n: [mid, b], wave: { type: 'dc', v: c.value }, note: note(c.label ?? 'supply') });
        parts.get(c.id)!.device = vname;
        report.push({ ref: c.ref, as: `V ${c.value} V + ${rint} Ω`, source: 'board' });
        break;
      }
    }
  }

  function emitSpec(c: Component, spec: PartSpec) {
    const pin = (role: string, dflt: string) => padNode(c, spec.pins?.[role] ?? dflt);
    const note = `${c.ref} [library]${spec.note ? ' ' + spec.note : ''}`;
    switch (spec.type) {
      case 'R': case 'short': {
        const v = spec.type === 'short' ? 1e-3 : toNum(spec.value, 1e3) * drift(c);
        const name = elName('R', c.ref);
        els.push({ kind: 'R', name, n: [pin('1', '1'), pin('2', '2')], value: v, note });
        parts.set(c.id, { comp: c, device: name, roles: ['1', '2'], type: 'R' });
        break;
      }
      case 'C': {
        const name = elName('C', c.ref);
        const esr = toNum(spec.esr, 0);
        const a = pin('1', '1'), b = pin('2', '2');
        if (esr > 0) {
          const mid = floating(c, 'esr');
          els.push({ kind: 'C', name, n: [a, mid], value: toNum(spec.value, 1e-7) * drift(c), note });
          els.push({ kind: 'R', name: elName('R', c.ref, '_ESR'), n: [mid, b], value: esr, note: `${c.ref} ESR` });
        } else els.push({ kind: 'C', name, n: [a, b], value: toNum(spec.value, 1e-7) * drift(c), note });
        parts.set(c.id, { comp: c, device: name, roles: ['1', '2'], type: 'C' });
        break;
      }
      case 'fuse': {
        // Cold resistance of small SMD fuses is tens of mΩ; the rating (A) is kept for the trip model.
        const name = elName('R', c.ref);
        els.push({ kind: 'R', name, n: [pin('1', '1'), pin('2', '2')], value: 0.03, note: `${note}; rated ${toNum(spec.value, 3)} A, 30 mΩ cold resistance assumed` });
        parts.set(c.id, { comp: c, device: name, roles: ['1', '2'], type: 'fuse' });
        break;
      }
      case 'L': {
        const name = elName('L', c.ref);
        const dcr = toNum(spec.dcr, 0);
        const b = pin('2', '2');
        if (dcr > 0) {
          const mid = floating(c, 'dcr');
          els.push({ kind: 'L', name, n: [pin('1', '1'), mid], value: toNum(spec.value, 1e-6) * drift(c), note });
          els.push({ kind: 'R', name: elName('R', c.ref, '_DCR'), n: [mid, b], value: dcr, note: `${c.ref} DCR` });
        } else els.push({ kind: 'L', name, n: [pin('1', '1'), b], value: toNum(spec.value, 1e-6) * drift(c), note });
        parts.set(c.id, { comp: c, device: name, roles: ['1', '2'], type: 'L' });
        break;
      }
      case 'D': case 'LED': {
        const name = elName('D', c.ref);
        const model = spec.model ? libModel(spec, 'D', c.ref) : useModel(spec.type === 'LED' ? ledModel(c.color ?? 'red') : DIODE_MODEL);
        els.push({ kind: 'D', name, n: [pin('A', '1'), pin('K', '2')], model, note });
        parts.set(c.id, { comp: c, device: name, roles: ['A', 'K'], type: spec.type });
        break;
      }
      case 'NMOS': case 'PMOS': {
        const name = elName('M', c.ref);
        const model = libModel(spec, spec.type, c.ref);
        const s = pin('S', '3');
        els.push({ kind: 'M', name, n: [pin('D', '1'), pin('G', '2'), s, s], model, note });
        parts.set(c.id, { comp: c, device: name, roles: ['D', 'S'], type: spec.type });
        break;
      }
      case 'NPN': case 'PNP': {
        const name = elName('Q', c.ref);
        const model = libModel(spec, spec.type, c.ref);
        els.push({ kind: 'Q', name, n: [pin('C', '1'), pin('B', '2'), pin('E', '3')], model, note });
        parts.set(c.id, { comp: c, device: name, roles: ['C', 'E'], type: spec.type });
        break;
      }
      case 'V': {
        if (!withSources) break;
        const name = elName('V', c.ref);
        els.push({ kind: 'V', name, n: [pin('+', '1'), pin('-', '2')], wave: { type: 'dc', v: toNum(spec.value, 0) }, note });
        parts.set(c.id, { comp: c, device: name, roles: ['+', '-'], type: 'V' });
        break;
      }
      case 'open': report.push({ ref: c.ref, as: 'open', source: 'library' }); return;
      case 'stub': stub(c, spec.note ?? 'library stub'); return;
      case 'subckt': {
        const ports = spec.ports ?? c.pads.map((p) => p.name).filter((n, i, a) => a.indexOf(n) === i);
        const sname = sanitize(`SUB_${c.ref}`);
        const parsed = parseSpice(`${sname}\n${spec.spice ?? ''}`);
        warnings.push(...parsed.warnings.map((w) => `${c.ref}: ${w}`));
        const inner = parsed.subckts[0];
        const body: Subckt = inner && !parsed.elements.length
          ? { ...inner, name: sname }
          : { name: sname, ports: ports.map((_, i) => `p${i + 1}`), elements: parsed.elements, models: parsed.models };
        if (body.ports.length !== ports.length) {
          warnings.push(`${c.ref}: subckt has ${body.ports.length} ports but ${ports.length} pads were mapped; stubbing`);
          stub(c, 'bad subckt');
          return;
        }
        subckts.set(sname, body);
        els.push({ kind: 'X', name: elName('X', c.ref), n: ports.map((p) => padNode(c, p)), subckt: sname, note });
        break;
      }
    }
    report.push({ ref: c.ref, as: spec.type, source: 'library', note: spec.note });
  }

  circuit.models = [...models.values()];
  circuit.subckts = [...subckts.values()];
  circuit.analyses = opts.analyses ?? [{ type: 'op' }];
  circuit.options = { rshunt: 1e12 };
  const counts = report.reduce<Record<string, number>>((m, r) => ((m[r.source] = (m[r.source] ?? 0) + 1), m), {});
  circuit.comments = [
    'Generated by DEADBOARD boardview → SPICE converter (ngspice compatible).',
    `${els.length} elements, ${netNode.size} nodes; parts by provenance: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ')}`,
    'Boardview files store no part values: elements tagged "inferred" are heuristics, X…HIZn are hi-Z placeholders.',
    ...(opts.comments ?? []),
  ];
  return { circuit, netNode, groundNet, parts, report, warnings };
}

function lowerKeys(p: Record<string, number>): Record<string, number> {
  const o: Record<string, number> = {};
  for (const [k, v] of Object.entries(p)) o[k.toLowerCase()] = v;
  return o;
}
