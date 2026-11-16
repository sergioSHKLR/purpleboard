// Universal power-tree discovery: which part produces each power rail, from what input,
// gated by which enable — derived from netlist topology plus net-name semantics. Works on
// any board whose nets carry conventional names; part numbers refine it when available.
import type { Board, Component } from '../types';
import type { Conn } from '../connectivity';
import { findDevice, type MosSpec } from './devicelib';

// ---------------- net semantics ----------------

export type NetRole = 'ground' | 'rail' | 'switch' | 'enable' | 'pgood' | 'feedback' | 'boot' | 'gate' | 'sense' | 'signal';

export const isGroundName = (n: string) => /^(GND|VSS|AGND|DGND|PGND|SGND|GND_[A-Z0-9_]+|[A-Z0-9_]+_GND|0)$/i.test(n);

/** Last segment of a hierarchical net name (KiCad sheets: "/Power/USB/VBUS_3V3" → "VBUS_3V3"). */
export const netBase = (name: string) => name.replace(/^.*\//, '');

/** Nominal voltage encoded in a rail name (PP3V3_S0 → 3.3, PP1V05 → 1.05, +5V → 5, VCC_1V8 → 1.8, +3.3V → 3.3). */
export function railVoltage(name: string): number | null {
  name = netBase(name);
  // decimal-point form: +3.3V, 1.1V_SYS, VCC_1.8V, 3.3VD
  const d = /^(?:PP|P|VCC_?|VDD_?|V_?)?(\d+)\.(\d+)V/i.exec(name.replace(/^\+/, ''));
  if (d) { const v = parseFloat(`${d[1]}.${d[2]}`); return v > 0 && v < 60 ? v : null; }
  // Voltage must directly follow the rail prefix: PP3V3_S0, P1V8S3, +5V, VCC_1V8, 3V3_AUX.
  // ("PPVIN_G3H_P3V42G3H" is the *input* of a 3.42 V regulator and carries no voltage.)
  const m = /^(?:PP|P|\+|VCC_?|VDD_?|V_?)?(\d+)V(\d*)/i.exec(name.replace(/^\+/, '')) ?? /^(?:PP|P|\+)?(\d+)V(\d*)/i.exec(name);
  if (!m) return null;
  const v = parseFloat(`${m[1]}.${m[2] || 0}`);
  return v > 0 && v < 60 ? v : null;
}

const RAIL_RE = /^(PP|VCC|VDD|VIN|VBAT|VBUS|VSYS|VMAIN|\+\d|P\d+V\d*|\d+V\d*_|\d+\.\d+V)/i;
/** Whole-token role keywords; they override a voltage-like prefix except on PP… rails. */
const ROLE_TOKENS: [NetRole, RegExp][] = [
  ['pgood', /^(PGOOD|PGD|PWRGD|PG|PWR_GOOD|PGOOD_L)$/],
  ['boot', /^(BOOT|BST|BOOTSTRAP|BOOST_CAP|BOOST)$/],
  ['gate', /^(DRVH|DRVL|UGATE\d*|LGATE\d*|HGATE|HDRV|LDRV|GATE|[A-Z]?GATE|DRV)$/],
  ['switch', /^(LL|SW|LX|PHASE\d*|SWN|SWNODE)$/],
  ['feedback', /^(FB|VFB|FBK)$/],
  ['sense', /^(ISNS|CSP|CSN|CS|SNS|SENSE|IMON|VSENSE|VMON|MON)$/],
  ['enable', /^(EN|ENA|ENABLE|ON|PWREN|EN_L|ON_L|ONOFF)$/],
];

export function netRole(name: string): NetRole {
  name = netBase(name);
  if (isGroundName(name)) return 'ground';
  const n = name.toUpperCase();
  const toks = n.split(/[_\-.]/);
  const pp = /^PP/.test(n);
  // "30V_GATE": a gated rail (input after a protection FET), not a gate drive
  if (/^\d+V\d*_GATED?$/.test(n)) return 'rail';
  // role decided by the last role token in the name (EN in "..._EN", GATE in "..._GATE_DIV")
  for (let i = toks.length - 1; i >= 1; i--) {
    const tok = toks[i].replace(/\d+$/, ''); // channel suffixes: VFB1, CSP2, LGATE1
    for (const [role, re] of ROLE_TOKENS) if ((re.test(toks[i]) || re.test(tok)) && !pp) return role;
    if (!pp && /^(COMP|VREF|VREG|FUNC|SKIPSEL|SS|TRK|ILIM|RT|FREQ|MODE|IOUT|RF)$/.test(tok)) return 'signal';
  }
  if (/(GATE|_DIV(_L)?$)/.test(n) && !pp) return 'gate';
  if (RAIL_RE.test(n) && !/(_DIV|_L$|_R_L$)/.test(n.replace(/^PP.*/, ''))) return 'rail';
  return 'signal';
}

/**
 * Availability rank of a rail from ACPI-style power-state tokens (lower = on earlier / more often):
 * G3H (always) < S5 < S4 < S3 < S0 < S0SW (switched). Unknown → undefined.
 */
export function powerStateRank(name: string): number | undefined {
  const n = netBase(name).toUpperCase();
  const m = /(?:^|_)(G3H?|S5|S4|S3|S0)(SW)?(?:_|$|RS|[A-Z])/.exec(n);
  if (!m) return undefined;
  const base = { G3: 0, G3H: 0, S5: 1, S4: 2, S3: 3, S0: 4 }[m[1] as 'G3'] ?? 5;
  return base + (m[2] || /S\dSW/.test(n) ? 0.5 : 0);
}

// ---------------- power tree ----------------

export type ConverterKind = 'buck' | 'boost' | 'ldo' | 'load-switch' | 'fet-switch' | 'diode-or' | 'pass-through' | 'external';

export interface PowerSource {
  kind: ConverterKind;
  /** Producing part (controller IC, FET, diode, sense resistor…). */
  ref: string;
  /** Additional parts of the converter (power FETs, inductor). */
  parts: string[];
  input: string | null;
  output: string;
  enable?: string;
  pgood?: string;
  feedback?: string;
  switchNode?: string;
  /** Feedback divider found on the controller's FB pin (output → FB → GND). */
  divider?: { top: string; bottom: string; rTop: number; rBot: number; ratio: number };
  /** Target output voltage and where it came from. */
  vTarget: number | null;
  vSource: 'rail-name' | 'input' | 'unknown';
  confidence: 'high' | 'medium' | 'low';
  why: string;
  /** fet-switch: P-channel (conducts with gate pulled below source). */
  pmos?: boolean;
}

export interface PowerTree {
  rails: Map<string, { v: number | null; sources: PowerSource[]; loads: number }>;
  sources: PowerSource[];
  /** Rails with no identified producer (inputs from connectors/battery, or detection gaps). */
  roots: string[];
}

interface NetIndex {
  name: (net: number) => string;
  pins: Map<string, { c: Component; pad: string }[]>;
}

function indexNets(board: Board, conn: Conn): NetIndex {
  const pins = new Map<string, { c: Component; pad: string }[]>();
  const name = (n: number) => (n >= 0 ? conn.netNames[n] : '');
  for (const c of board.components) {
    if (!c.state.populated) continue;
    const idx = conn.padItem.get(c);
    if (!idx) continue;
    c.pads.forEach((p, pi) => {
      if (c.state.cold.includes(pi)) return;
      const nm = name(conn.net[idx[pi]]);
      if (!nm) return;
      const l = pins.get(nm) ?? [];
      if (!l.some((x) => x.c === c && x.pad === p.name)) l.push({ c, pad: p.name });
      pins.set(nm, l);
    });
  }
  return { name, pins };
}

const prefixOf = (ref: string) => ref.replace(/\d.*$/, '').toUpperCase();
const isIc = (c: Component) => /^(U|IC|PMIC|VR)$/.test(prefixOf(c.ref)) || c.kind === 'ic' && !/^(Q|D)$/.test(prefixOf(c.ref));
const isFet = (c: Component) => prefixOf(c.ref) === 'Q' || prefixOf(c.ref) === 'M';
const isInductor = (c: Component) => prefixOf(c.ref) === 'L' && new Set(c.pads.map((p) => p.name)).size === 2;

export interface PowerTreeOptions {
  /** Refdes → manufacturer part number (enables exact FET terminal roles). */
  partNumbers?: Record<string, string>;
  /** Library specs: refs known to be not fitted are ignored. */
  notFitted?: Set<string>;
  /** Resolved resistances (Ω) by refdes (e.g. from a part library); 0 = short / net tie. */
  ohms?: Record<string, number>;
}

export function discoverPowerTree(board: Board, conn: Conn, opts: PowerTreeOptions = {}): PowerTree {
  const ix = indexNets(board, conn);
  const comps = board.components.filter((c) => c.state.populated && !opts.notFitted?.has(c.ref));
  const netsOf = (c: Component) => {
    const idx = conn.padItem.get(c)!;
    const m = new Map<string, string>(); // pad → net name
    c.pads.forEach((p, pi) => { if (!c.state.cold.includes(pi) && idx) m.set(p.name, ix.name(conn.net[idx[pi]])); });
    return m;
  };
  const sources: PowerSource[] = [];
  const isRail = (n: string | undefined): n is string => !!n && netRole(n) === 'rail';

  // FET terminal roles: device library when known, else by net semantics.
  const fetRoles = (c: Component): { D?: string; G?: string; S?: string; pmos?: boolean } | null => {
    const nets = netsOf(c);
    const dev = findDevice(opts.partNumbers?.[c.ref]);
    if (dev && dev.units.length === 1 && (dev.units[0].kind === 'nmos' || dev.units[0].kind === 'pmos')) {
      const u = dev.units[0] as MosSpec;
      return { D: nets.get(u.pins.D), G: nets.get(u.pins.G), S: nets.get(u.pins.S), pmos: u.kind === 'pmos' };
    }
    const distinct = [...new Set(nets.values())];
    if (distinct.length !== 3) return null;
    const g = distinct.find((n) => ['gate', 'enable'].includes(netRole(n)) || /DIV|_G$|_GATE/.test(n));
    if (!g) return null;
    const [a, b] = distinct.filter((n) => n !== g);
    return { D: a, G: g, S: b };
  };

  // 1. Switching converters: an inductor between a non-rail switch node and a rail.
  for (const L of comps.filter(isInductor)) {
    const nets = [...new Set(netsOf(L).values())];
    if (nets.length !== 2) continue;
    const [n1, n2] = nets;
    // Switch node = the side with no capacitors to ground but power-switch pins (FET/IC/diode);
    // the regulated side carries the bulk capacitors. Names are only a tie-breaker.
    const capsToGnd = (n: string) => (ix.pins.get(n) ?? []).filter((p) => prefixOf(p.c.ref) === 'C' && [...netsOf(p.c).values()].some((m) => isGroundName(m))).length;
    const switchy = (n: string) => (ix.pins.get(n) ?? []).some((p) => p.c !== L && (isFet(p.c) || isIc(p.c) || prefixOf(p.c.ref) === 'D'));
    const score = (n: string) => (capsToGnd(n) === 0 ? 2 : 0) + (switchy(n) ? 1 : 0) + (netRole(n) === 'switch' ? 2 : 0) - (isRail(n) && /^PP/.test(n) ? 3 : 0);
    const s1 = score(n1), s2 = score(n2);
    if (Math.abs(s1 - s2) < 2) continue; // symmetric: a filter inductor between two rails (pass-through below)
    const sw = s1 > s2 ? n1 : n2, rail = s1 > s2 ? n2 : n1;
    const swPins = (ix.pins.get(sw) ?? []).filter((p) => p.c !== L);
    // controller: an IC on the switch node, or the IC driving the gates of FETs on the switch node
    const fets = [...new Set(swPins.filter((p) => isFet(p.c)).map((p) => p.c))];
    let ctrl = swPins.find((p) => isIc(p.c))?.c;
    const gateNets = fets.flatMap((f) => [...new Set(netsOf(f).values())].filter((n) => netRole(n) === 'gate'));
    if (!ctrl) for (const g of gateNets) { ctrl = (ix.pins.get(g) ?? []).find((p) => isIc(p.c))?.c; if (ctrl) break; }
    const diodes = swPins.filter((p) => prefixOf(p.c.ref) === 'D').map((p) => p.c);
    // Boost: switch node → diode → higher rail; rail on inductor is the INPUT.
    const boostDiode = diodes.find((d) => [...netsOf(d).values()].some((n) => n !== sw && isRail(n)));
    const ctrlNets = ctrl ? [...new Set(netsOf(ctrl).values())] : [];
    const pick = (role: NetRole) => ctrlNets.find((n) => netRole(n) === role);
    if (boostDiode) {
      const out = [...netsOf(boostDiode).values()].find((n) => n !== sw && isRail(n))!;
      sources.push({
        kind: 'boost', ref: ctrl?.ref ?? boostDiode.ref, parts: [L.ref, boostDiode.ref, ...fets.map((f) => f.ref)],
        input: rail, output: out, enable: pick('enable'), pgood: pick('pgood'), feedback: pick('feedback'), switchNode: sw,
        vTarget: railVoltage(out), vSource: railVoltage(out) !== null ? 'rail-name' : 'unknown',
        confidence: ctrl ? 'high' : 'medium', why: `${L.ref} from ${rail} to switch node ${sw}, rectified by ${boostDiode.ref} into ${out}`,
      });
      continue;
    }
    // Buck: input rail = rail on the high-side FET drain or on a controller pin, highest voltage.
    const inCands = new Set<string>();
    for (const f of fets) for (const n of netsOf(f).values()) if (isRail(n) && n !== rail) inCands.add(n);
    for (const n of ctrlNets) if (isRail(n) && n !== rail) inCands.add(n);
    const vOut = railVoltage(rail);
    // highest voltage first; on a tie a net named as an input (VIN / PVIN) beats a bias or VCC pin
    const inputNamed = (n: string) => (/(^|_)P?VIN($|_)|_IN$/i.test(netBase(n)) ? 1 : 0);
    const input = [...inCands].sort((a, b) => (railVoltage(b) ?? 99) - (railVoltage(a) ?? 99) || inputNamed(b) - inputNamed(a))[0] ?? null;
    sources.push({
      kind: 'buck', ref: ctrl?.ref ?? fets[0]?.ref ?? L.ref, parts: [L.ref, ...fets.map((f) => f.ref)],
      input, output: rail, enable: pick('enable'), pgood: pick('pgood'), feedback: pick('feedback'), switchNode: sw,
      vTarget: vOut, vSource: vOut !== null ? 'rail-name' : 'unknown',
      confidence: ctrl && input ? 'high' : ctrl || input ? 'medium' : 'low',
      why: `${L.ref} from switch node ${sw} into ${rail}${fets.length ? ` (power stage ${fets.map((f) => f.ref).join(', ')})` : ''}${ctrl ? `, controller ${ctrl.ref}` : ''}`,
    });
  }

  const produced = new Set(sources.map((s) => s.output));

  // 2. Discrete FET switches between two rails (gate on an enable/divider net).
  for (const q of comps.filter(isFet)) {
    const r = fetRoles(q);
    if (!r?.D || !r.S || !isRail(r.D) || !isRail(r.S) || r.D === r.S) continue;
    // Output = the side whose name carries the more specific power-state suffix, else the drain for P-FETs.
    const pm = r.pmos ?? true;
    const out = pm ? r.D : r.S, inp = pm ? r.S : r.D;
    sources.push({
      kind: 'fet-switch', ref: q.ref, parts: [], input: inp, output: out, enable: r.G, pmos: pm,
      vTarget: null, vSource: 'input', confidence: findDevice(opts.partNumbers?.[q.ref]) ? 'high' : 'medium',
      why: `${q.ref} ${pm ? 'P' : 'N'}-FET between ${inp} and ${out}, gate ${r.G}`,
    });
  }

  // 3. ICs passing one rail to another: LDOs and integrated load switches (small pin count, enable pin).
  for (const u of comps.filter(isIc)) {
    const nets = [...new Set(netsOf(u).values())];
    if (nets.length > 12) continue; // large ICs are consumers, not regulators
    const rails = nets.filter((n) => isRail(n));
    // A chip with no enable-named pin whose only control net is a power-good is being *enabled*
    // by that upstream PG (common "PG of stage N enables stage N+1" sequencing).
    const en0 = nets.find((n) => netRole(n) === 'enable');
    const pg0 = nets.find((n) => netRole(n) === 'pgood');
    const en = en0 ?? pg0;
    const pg = en0 ? pg0 : undefined;
    if (rails.length < 2 || sources.some((s) => s.ref === u.ref)) continue;
    // output: a rail not produced elsewhere, preferring lower voltage / power-state-suffixed names
    const cand = rails.filter((n) => !produced.has(n));
    for (const out of cand) {
      const others = rails.filter((n) => n !== out);
      const vo = railVoltage(out);
      const higher = others.filter((n) => (railVoltage(n) ?? 99) > (vo ?? 0) + 0.05);
      const same = others.filter((n) => vo !== null && railVoltage(n) !== null && Math.abs(railVoltage(n)! - vo) < 0.05);
      // load switch: same-voltage rail in → out (e.g. PP3V3_S5 → PP3V3_S0); LDO: higher rail in
      const isSwitch = same.length > 0 && !!en;
      // a load switch passes the more-available rail to the less-available one
      const sameIn = same.filter((n) => (powerStateRank(n) ?? 9) <= (powerStateRank(out) ?? 9));
      if (isSwitch && !sameIn.length) continue;
      const input = isSwitch ? sameIn[0] : higher.sort((a, b) => (railVoltage(a) ?? 99) - (railVoltage(b) ?? 99))[0];
      if (!input || (!en && !pg && !isSwitch)) continue;
      // the output rail must be "owned": ≥1 decoupling cap on it, and this IC has few rails
      sources.push({
        kind: isSwitch ? 'load-switch' : 'ldo', ref: u.ref, parts: [], input, output: out, enable: en, pgood: pg,
        vTarget: isSwitch ? null : vo, vSource: isSwitch ? 'input' : vo !== null ? 'rail-name' : 'unknown',
        confidence: en ? 'medium' : 'low', why: `${u.ref} (${nets.length} nets) has ${input} and ${out}${en ? `, enable ${en}` : ''}`,
      });
      produced.add(out);
      break;
    }
  }

  // 4. Diode OR-ing / reverse protection between rails.
  for (const d of comps.filter((c) => prefixOf(c.ref) === 'D')) {
    const nets = [...new Set(netsOf(d).values())];
    const rails = nets.filter((n) => isRail(n));
    if (rails.length < 2) continue;
    // common-cathode duals: the cathode net is shared by both diodes → output; single: pad 2 heuristic
    const counts = new Map<string, number>();
    for (const n of netsOf(d).values()) counts.set(n, (counts.get(n) ?? 0) + 1);
    const out = rails.find((n) => !produced.has(n) && (nets.length === 2 || (counts.get(n) ?? 0) >= 1 && rails.indexOf(n) === rails.length - 1)) ?? rails[rails.length - 1];
    for (const inp of rails.filter((n) => n !== out)) {
      sources.push({ kind: 'diode-or', ref: d.ref, parts: [], input: inp, output: out, vTarget: null, vSource: 'input', confidence: 'low', why: `${d.ref} between ${inp} and ${out}` });
    }
  }

  // 5. Pass-through: fuses, sense resistors, net ties, filter inductors/beads between two rails.
  //    Orientation is found by propagation: power flows from rails that already have a producer.
  const edges: { a: string; b: string; ref: string; pre: string }[] = [];
  for (const c of comps) {
    const pre = prefixOf(c.ref);
    if (!/^(F|R|L|XW|SL|FB)$/.test(pre)) continue;
    const nets = [...new Set(netsOf(c).values())].filter((n) => isRail(n));
    if (nets.length !== 2) continue;
    const [a, b] = nets;
    const related = a.startsWith(b) || b.startsWith(a) || a.replace(/_(R|FET|FET_R|REG|REG_R|ISNS)$/, '') === b.replace(/_(R|FET|FET_R|REG|REG_R|ISNS)$/, '');
    // a value that is only an importer placeholder says nothing about the part
    const r = opts.ohms?.[c.ref] ?? (c.kind === 'resistor' && !c.valueGuessed ? c.value : undefined);
    if (pre === 'R' && r !== undefined && r > 1 && c.label !== 'Inductor' && !related) continue;
    if (sources.some((s) => s.parts.includes(c.ref))) continue; // already part of a converter (e.g. its inductor)
    edges.push({ a, b, ref: c.ref, pre });
  }
  const fed = new Set(sources.map((s) => s.output));
  const roots0 = new Set<string>(); // externally fed: connector/battery side of entry FETs
  for (const s of sources) if (s.input) roots0.add(s.input);
  const oriented = new Set<number>();
  for (let changed = true; changed;) {
    changed = false;
    edges.forEach((e, i) => {
      if (oriented.has(i)) return;
      const fa = fed.has(e.a), fb = fed.has(e.b);
      if (fa === fb) return;
      const [inp, out] = fa ? [e.a, e.b] : [e.b, e.a];
      sources.push({ kind: 'pass-through', ref: e.ref, parts: [], input: inp, output: out, vTarget: null, vSource: 'input', confidence: 'medium', why: `${e.ref} (${e.pre}) links ${inp} → ${out}` });
      fed.add(out); oriented.add(i); changed = true;
    });
  }
  // leftovers (neither side fed yet): upstream = more available power state, then shorter name
  edges.forEach((e, i) => {
    if (oriented.has(i)) return;
    const ra = powerStateRank(e.a) ?? 9, rb = powerStateRank(e.b) ?? 9;
    const [inp, out] = ra !== rb ? (ra < rb ? [e.a, e.b] : [e.b, e.a]) : e.a.length <= e.b.length ? [e.a, e.b] : [e.b, e.a];
    sources.push({ kind: 'pass-through', ref: e.ref, parts: [], input: inp, output: out, vTarget: null, vSource: 'input', confidence: 'low', why: `${e.ref} (${e.pre}) links ${inp} → ${out} (orientation by name)` });
  });
  void roots0;

  // rail table
  // Feedback dividers: FB net with one resistor to the output side and one to ground.
  const ohm = (c: Component) => opts.ohms?.[c.ref] ?? (c.kind === 'resistor' && c.value !== 1000 ? c.value : undefined);
  const compByRef = new Map(comps.map((c) => [c.ref, c]));
  const related = (a: string, b: string) => a === b || a.startsWith(b) || b.startsWith(a) || a.replace(/_(R|REG|REG_R|FET_R)$/, '') === b.replace(/_(R|REG|REG_R|FET_R)$/, '');
  for (const src of sources) {
    if (!['buck', 'boost', 'ldo'].includes(src.kind)) continue;
    const ctrl = compByRef.get(src.ref);
    const fbNets = new Set<string>([...(src.feedback ? [src.feedback] : []), ...(ctrl ? [...netsOf(ctrl).values()].filter((n) => netRole(n) === 'feedback') : [])]);
    for (const fb of fbNets) {
      const rs = (ix.pins.get(fb) ?? []).filter((p) => prefixOf(p.c.ref) === 'R').map((p) => p.c);
      let bot: Component | undefined, top: Component | undefined;
      for (const r of rs) {
        const other = [...netsOf(r).values()].find((n) => n !== fb);
        if (!other) continue;
        if (isGroundName(other)) bot = r;
        else if (related(other, src.output)) top = r; // divider top must sit on THIS converter's output
      }
      const rt = top && ohm(top), rb = bot && ohm(bot);
      if (top && bot && rt !== undefined && rb !== undefined && rt >= 0 && rb > 0) {
        src.feedback = fb;
        src.divider = { top: top.ref, bottom: bot.ref, rTop: rt, rBot: rb, ratio: rb / (rt + rb) };
        break;
      }
    }
  }

  const rails = new Map<string, { v: number | null; sources: PowerSource[]; loads: number }>();
  for (const [n, pins] of ix.pins) if (isRail(n)) rails.set(n, { v: railVoltage(n), sources: [], loads: pins.length });
  for (const s of sources) rails.get(s.output)?.sources.push(s);
  const roots = [...rails.entries()].filter(([, r]) => !r.sources.length).map(([n]) => n);
  return { rails, sources, roots };
}
