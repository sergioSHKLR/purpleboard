// Schematic PDF → per-part data (values, ratings, part numbers, BOM stuffing).
//
// Targets Cadence Concept-HDL style schematics (Apple MLB drawings): every symbol prints
// its refdes followed by a stacked property column (value, tolerance, power/voltage,
// dielectric, package), an optional BOM-option label above the refdes, and BOM tables
// (product configurations → BOM groups → options; part tables for table-driven parts).
// Geometry is evaluated in each refdes' own text frame so rotated symbols work too.
import type { PdfPage, TextRun } from './pdf';

export interface SchematicPart {
  ref: string;
  pages: number[];
  /** Numeric primary value: Ω / F / H (undefined for non-passives or when not printed). */
  value?: number;
  valueText?: string;
  /** Electrical type of the printed value (may differ from the refdes letter). */
  valueKind?: 'R' | 'C' | 'L' | 'bead';
  /** Inductor DC resistance (Ω) when printed. */
  dcr?: number;
  tolerance?: string;
  power?: string;
  voltage?: string;
  dielectric?: string;
  pkg?: string;
  /** Capacitor ESR (Ω) or inductor current rating (A) when encoded in the value ("62UF-0.023OHM", "15UH-2.8A"). */
  esr?: number;
  irated?: number;
  partNumber?: string;
  /** BOM option label printed above the refdes ("NO STUFF", "BKLT:PROD", "OMIT_TABLE"…). */
  bomOption?: string;
  critical?: boolean;
  /** key=value properties (PLACE_NEAR=…, VOLTAGE=… on attached nets excluded). */
  attrs: Record<string, string>;
  /** Every token assigned to this part, in reading order. */
  tokens: string[];
  /** Footprint is a copper short ("…-SHORT" package or SHORT symbol): an OMITted part still conducts. */
  shortFootprint?: boolean;
}

export interface BomTables {
  /** Product / assembly / group name → member options & groups. */
  defs: Map<string, string[]>;
  /** Part-table rows: option → part numbers stuffed by it, per refdes. */
  tableParts: { partNumber: string; description: string; refs: string[]; option: string }[];
  /** Alternate parts: part number → alternate part numbers. */
  alternates: Map<string, string[]>;
  products: { partNumber: string; description: string }[];
}

export interface Schematic {
  parts: Map<string, SchematicPart>;
  bom: BomTables;
  /** Refdes printed in the schematic that the caller did not ask for (diagnostics). */
  unknownRefs: string[];
}

const REF_RE = /^[A-Z]{1,4}\d{3,5}[A-Z]?$/;
const OPT_RE = /^[A-Z0-9][A-Z0-9_]*(?::[A-Z0-9_.]+)?$/;
const NOT_STUFFED = new Set(['NO STUFF', 'NOSTUFF', 'OMIT', 'NO_STUFF']);

// ---------------- values ----------------

/** Apple-style resistor value: "301K", "4.7K", "1M" (= 1 MΩ), "0", "2.2", "10" */
export function parseOhms(s: string): number | undefined {
  s = s.replace(/OHMS?$/, '');
  const m = /^(\d+(?:\.\d+)?)([KMR]?)(\d*)$/.exec(s);
  if (!m) return undefined;
  let num = m[1];
  if (m[3]) { if (m[2] && !m[1].includes('.')) num = `${m[1]}.${m[3]}`; else return undefined; }
  const k = m[2] === 'K' ? 1e3 : m[2] === 'M' ? 1e6 : 1;
  return parseFloat(num) * k;
}

export function parseFarads(s: string): { f: number; esr?: number } | undefined {
  // "62UF-0.023OHM", "150UF-0.018OHM-1.8A" (ripple current rating), "0.1uF"
  const m = /^(\d+(?:\.\d+)?)(UF|NF|PF|F)(?:-(\d+(?:\.\d+)?)(M?)OHM)?(?:-\d+(?:\.\d+)?A)?$/.exec(s.toUpperCase());
  if (!m) return undefined;
  const k = m[2] === 'UF' ? 1e-6 : m[2] === 'NF' ? 1e-9 : m[2] === 'PF' ? 1e-12 : 1;
  const out: { f: number; esr?: number } = { f: parseFloat(m[1]) * k };
  if (m[3]) out.esr = parseFloat(m[3]) * (m[4] ? 1e-3 : 1);
  return out;
}

export interface InductorValue { h?: number; beadOhms?: number; amps?: number; dcr?: number; tol?: string }

/**
 * Inductor / ferrite-bead value strings:
 *   "15UH-2.8A", "2.2UH-240MA-0.221OHM", "1.0UH-1.6A-55MOHM", "10UH-20%-0.85A-0.46OHM", "47NH-1.3OHM",
 *   beads: "FERR-120-OHM-3A", "220-OHM-1.4A", "FERR-1000-OHM-450MA" (impedance at 100 MHz).
 */
export function parseInductor(s: string): InductorValue | undefined {
  const t = s.toUpperCase().replace(/^FERR-/, 'BEAD-');
  const bead = /^(?:BEAD-)?(\d+(?:\.\d+)?)-OHM(?=-|$)/.exec(t);
  const ind = /^(\d+(?:\.\d+)?)(UH|NH|MH)(?=-|$)/.exec(t);
  if (!bead && !ind) return undefined;
  const out: InductorValue = {};
  let rest: string;
  if (ind) {
    out.h = parseFloat(ind[1]) * (ind[2] === 'UH' ? 1e-6 : ind[2] === 'NH' ? 1e-9 : 1e-3);
    rest = t.slice(ind[0].length);
  } else {
    out.beadOhms = parseFloat(bead![1]);
    rest = t.slice(bead![0].length);
  }
  for (const f of rest.split('-').filter(Boolean)) {
    let m: RegExpExecArray | null;
    if ((m = /^(\d+(?:\.\d+)?)(M?)A$/.exec(f))) out.amps ??= parseFloat(m[1]) * (m[2] ? 1e-3 : 1);
    else if ((m = /^(\d+(?:\.\d+)?)(M?)OHMS?$/.exec(f))) out.dcr = parseFloat(m[1]) * (m[2] ? 1e-3 : 1);
    else if (/^\d+(\.\d+)?%$/.test(f)) out.tol = f;
    else if (!/^[\d.]+(GHZ|MHZ)?$/.test(f)) return undefined; // unknown field → not a value string
  }
  return out;
}

export function parseHenries(s: string): { h: number; amps?: number } | undefined {
  const v = parseInductor(s);
  return v?.h !== undefined ? { h: v.h, ...(v.amps !== undefined && { amps: v.amps }) } : undefined;
}

const TOL_RE = /^\d+(\.\d+)?%$/;
const POWER_RE = /^\d+(\/\d+)?W$/;
const VOLT_RE = /^\d+(\.\d+)?V$/;
const DIELECTRIC_RE = /^(X\dR|X\dS|X\dT|NP0|C0G|COG|Y5V|CERM|TANT|POLY|ELEC|MF|MF-LF|THRM|THF|TF|CF)([-A-Z0-9]*)$/;
const PKG_RE = /^(01005|0?201|0?402|0?603|0?805|1206|1210|2010|2512|SM|SM-?[A-Z0-9-]*|CASE-[A-Z0-9-]+|SO[DT]-?\d+[A-Z0-9-]*|SOT\d+[A-Z0-9-]*|SSOT\d+[A-Z0-9-]*|[A-Z]*DFN[A-Z0-9-]*|[A-Z]*QFN[A-Z0-9-]*|[A-Z]*BGA[A-Z0-9-]*|DSBGA[A-Z0-9-]*|WLCSP[A-Z0-9-]*|\d+-?BUMP[A-Z0-9-]*|[A-Z]*SON[A-Z0-9-]*|MLP[A-Z0-9-]*|PWRPAK[A-Z0-9-]*|POWERPAK[A-Z0-9-]*|DPAK|SOIC\d*|TSSOP\d*|MSOP\d*|[0-9]{3,4}-HF|[A-Z0-9]+-HF)$/;

// ---------------- geometry ----------------

interface Local { u: number; v: number }
/** Position of `t` in the text frame of `ref` (u along the baseline, v perpendicular, +v = above). */
function local(ref: TextRun, t: TextRun): Local {
  const dx = t.x - ref.x, dy = t.y - ref.y;
  const [cx, cy] = ref.dir;
  const s = 6.24 / Math.max(2, ref.size); // normalise to the dominant refdes text height
  return { u: (dx * cx + dy * cy) * s, v: (-dx * cy + dy * cx) * s };
}

/** Cost of `t` belonging to the property column of `ref` (Infinity = outside the window). */
function blockCost(l: Local, above: boolean): number {
  if (above) return l.v > 1.5 && l.v < 11 && l.u > -12 && l.u < 16 ? Math.abs(l.u) + Math.abs(l.v - 7) : Infinity;
  if (l.v < 0.5 && l.v > -25 && l.u > -26 && l.u < 24) return Math.abs(l.u) * 0.7 + Math.max(0, -l.v - 5) * 0.35;
  // Horizontal series-part templates: value printed inline to the right or left of the refdes.
  if (Math.abs(l.v) < 2.5 && l.u > 8 && l.u < 45) return 4 + (l.u - 8) * 0.4;
  if (Math.abs(l.v) < 2.5 && l.u < -8 && l.u > -30) return 5 + (-l.u - 8) * 0.4;
  // Inverted template: property column stacked above the refdes (loses to a column below).
  if (l.v > 1.5 && l.v < 21 && l.u > -14 && l.u < 22) return 7 + Math.abs(l.u) * 0.7 + l.v * 0.35;
  return Infinity;
}

// ---------------- BOM tables ----------------

function rowsOf(page: PdfPage): TextRun[][] {
  const rows = new Map<number, TextRun[]>();
  for (const t of page.text) {
    const k = Math.round(t.y * 2) / 2;
    let row = rows.get(k) ?? rows.get(k + 0.5) ?? rows.get(k - 0.5);
    if (!row) rows.set(k, (row = []));
    row.push(t);
  }
  return [...rows.values()].map((r) => r.sort((a, b) => a.x - b.x));
}

const PN_DASH = /^\d{3}-\d{4,5}$/;
const PN_ANY = /^(\d{3}-\d{4,5}|\d{3}S\d{4,5}|\d{3}-\d{4})$/;
const isOptList = (s: string) => s.split(',').every((x) => OPT_RE.test(x.trim()) || /^\d{3}-\d{4,5}$/.test(x.trim())) && /[A-Z]/.test(s);

export function parseBomTables(pages: PdfPage[]): BomTables {
  const defs = new Map<string, string[]>();
  const tableParts: BomTables['tableParts'] = [];
  const alternates = new Map<string, string[]>();
  const products: BomTables['products'] = [];
  for (const page of pages) {
    if (!page.text.some((t) => /^(BOM GROUP|BOM OPTION|BOM OPTIONS|PART NUMBER)$/.test(t.text))) continue;
    for (const row of rowsOf(page)) {
      // Several tables sit side by side on one sheet; the x-sorted row is a concatenation
      // of their cells, so match known row shapes sequentially and consume what matched.
      const t = row.map((c) => c.text.trim()).filter((x) => x && x !== 'CRITICAL' || x === 'CRITICAL');
      let i = 0;
      while (i < t.length) {
        const a = t[i], b = t[i + 1], c = t[i + 2];
        // Product / assembly: 639-xxxxx | DESCRIPTION | opt,opt,…
        if (PN_DASH.test(a) && b !== undefined && !/^\d+$/.test(b) && c !== undefined && isOptList(c) && !PN_ANY.test(b)) {
          defs.set(a, c.split(',').map((x) => x.trim()));
          if (a.startsWith('639-')) products.push({ partNumber: a, description: b });
          i += 3; continue;
        }
        // Part table: PN | QTY | DESCRIPTION | REFDES… | [CRITICAL] | OPTION
        if (PN_ANY.test(a) && b !== undefined && /^\d+$/.test(b) && c !== undefined) {
          let j = i + 3;
          const refs: string[] = [];
          while (j < t.length && j < i + 5 && t[j] !== 'CRITICAL' && /^[A-Z][A-Z0-9_]*(,[A-Z][A-Z0-9_]*)*$/.test(t[j]) && !(j > i + 3 && OPT_RE.test(t[j]) && t[j + 1] === undefined)) { refs.push(...t[j].split(/[ ,]+/).filter(Boolean)); j++; }
          if (t[j] === 'CRITICAL') j++;
          const option = t[j];
          if (refs.length && option && OPT_RE.test(option)) { tableParts.push({ partNumber: a, description: c, refs, option }); i = j + 1; continue; }
        }
        // Alternates: PN | ALTERNATE-FOR PN | [BOM OPTION] | ALL/refdes | comment
        if (PN_ANY.test(a) && b !== undefined && PN_ANY.test(b)) {
          (alternates.get(b) ?? alternates.set(b, []).get(b)!).push(a);
          i += 2; continue;
        }
        // Group definition: NAME | opt,opt,…   (or NAME | single option)
        if (OPT_RE.test(a) && b !== undefined && isOptList(b) && (b.includes(',') || /[_:]/.test(a)) && a !== b && !/^(BOM|PART|REF)/.test(a)) {
          defs.set(a, b.split(',').map((x) => x.trim()));
          i += 2; continue;
        }
        i++;
      }
    }
  }
  return { defs, tableParts, alternates, products };
}

/** Expands a product/assembly/group name into the full set of selected BOM options. */
export function resolveOptions(bom: BomTables, root: string): Set<string> {
  const out = new Set<string>();
  const byOption = new Map<string, string[]>();
  for (const r of bom.tableParts) (byOption.get(r.option) ?? byOption.set(r.option, []).get(r.option)!).push(r.partNumber);
  const visit = (name: string, depth: number) => {
    if (out.has(name) || depth > 40) return;
    out.add(name);
    for (const m of bom.defs.get(name) ?? []) visit(m, depth + 1);
    for (const pn of byOption.get(name) ?? []) if (bom.defs.has(pn)) visit(pn, depth + 1);
  };
  visit(root, 0);
  return out;
}

// ---------------- parts ----------------

export interface ExtractOptions {
  /** Refdes to extract (e.g. from the boardview). Defaults to every refdes-shaped label. */
  refs?: Iterable<string>;
  /** Net names (e.g. from the boardview) — never mistaken for part properties. */
  nets?: Iterable<string>;
}

export function extractSchematic(pages: PdfPage[], opts: ExtractOptions = {}): Schematic {
  const wanted = opts.refs ? new Set(opts.refs) : null;
  const nets = new Set(opts.nets ?? []);
  const bom = parseBomTables(pages);
  const knownOptions = new Set<string>();
  for (const [k, v] of bom.defs) { knownOptions.add(k); for (const x of v) knownOptions.add(x); }
  for (const r of bom.tableParts) knownOptions.add(r.option);

  const parts = new Map<string, SchematicPart>();
  const unknown = new Set<string>();
  for (const page of pages) {
    // Refdes inside BOM/part tables (same row as a part number) are not symbol labels.
    const pnRows = page.text.filter((t) => PN_ANY.test(t.text)).map((t) => t.y);
    const inTable = (t: TextRun) => pnRows.some((y) => Math.abs(y - t.y) < 1.5);
    const refRuns = page.text.filter((t) => REF_RE.test(t.text) && (!wanted || wanted.has(t.text)) && !inTable(t));
    for (const t of page.text) if (REF_RE.test(t.text) && wanted && !wanted.has(t.text) && !nets.has(t.text)) unknown.add(t.text);
    if (!refRuns.length) continue;
    const refSet = new Set(refRuns);
    // Assign each candidate token to its cheapest refdes (each token belongs to one part).
    const claims = new Map<TextRun, { t: TextRun; cost: number; above: boolean }[]>();
    for (const t of page.text) {
      if (refSet.has(t) || REF_RE.test(t.text)) continue;
      const s = t.text.trim();
      if (!s || nets.has(s) || s.length > 48) continue;
      const digits = /^\d{1,4}$/.test(s);
      const isBomLabel = NOT_STUFFED.has(s) || s === 'OMIT_TABLE' || (knownOptions.has(s) && /:|_/.test(s));
      let best: TextRun | null = null, bestCost = Infinity, bestAbove = false;
      for (const r of refRuns) {
        if (Math.abs(r.x - t.x) > 40 || Math.abs(r.y - t.y) > 40) continue;
        const l = local(r, t);
        // Bare numbers are pin numbers except in a resistor's value slot (≈5 units under the refdes).
        // Bare numbers are pin numbers (small text) except a resistor value in its slot:
        // under the refdes, or inline to its right.
        const pkgCode = digits && /^(01005|0?201|0?402|0?603|0805|1206|1210|2512)$/.test(s) && l.v < -11 && l.v > -26 && Math.abs(l.u) < 22;
        if (digits && !pkgCode && !(/^R\d/.test(r.text) && t.size >= 0.65 * r.size &&
          ((l.v < -2.5 && l.v > -9.5 && Math.abs(l.u) < 18) || (Math.abs(l.v) < 2.5 && Math.abs(l.u) > 8 && l.u < 45 && l.u > -30)))) continue;
        const cb = blockCost(l, false);
        if (cb < bestCost) { bestCost = cb; best = r; bestAbove = false; }
        if (isBomLabel || s === 'CRITICAL') {
          const ca = blockCost(l, true) - 0.5; // labels above win ties against the part above's column
          if (ca < bestCost) { bestCost = ca; best = r; bestAbove = true; }
        }
      }
      if (best) (claims.get(best) ?? claims.set(best, []).get(best)!).push({ t, cost: bestCost, above: bestAbove });
    }
    for (const r of refRuns) {
      const toks = (claims.get(r) ?? []).sort((a, b) => local(r, b.t).v - local(r, a.t).v);
      let p = parts.get(r.text);
      if (!p) parts.set(r.text, (p = { ref: r.text, pages: [], attrs: {}, tokens: [] }));
      if (!p.pages.includes(page.index)) p.pages.push(page.index);
      for (const { t, above } of toks) classify(p, t.text.trim(), above);
    }
  }
  if (wanted) for (const r of wanted) if (!parts.has(r)) parts.set(r, { ref: r, pages: [], attrs: {}, tokens: [] });
  return { parts, bom, unknownRefs: [...unknown].sort() };
}

function classify(p: SchematicPart, s: string, above: boolean) {
  p.tokens.push(s);
  if (s === 'CRITICAL') { p.critical = true; return; }
  if (above) { if (!p.bomOption || NOT_STUFFED.has(s)) p.bomOption = s; return; }
  if (NOT_STUFFED.has(s) || s === 'OMIT_TABLE') { if (!p.bomOption) p.bomOption = s; return; }
  if (s === 'SHORT' || /-SHORT$/.test(s)) { p.shortFootprint = true; if (s !== 'SHORT') p.pkg ??= s; return; }
  const eq = s.indexOf('=');
  if (eq > 0) { p.attrs[s.slice(0, eq)] = s.slice(eq + 1); return; }
  const kind = p.ref.replace(/\d.*$/, '');
  if (p.value === undefined) {
    // Footprints are sometimes fitted with another part type (e.g. a 100 pF cap on an R
    // footprint), so any unit is accepted; bare numbers only count as ohms on R/RP parts.
    const f = parseFarads(s);
    if (f) { p.value = f.f; p.valueText = s; p.valueKind = 'C'; if (f.esr !== undefined) p.esr = f.esr; return; }
    const iv = kind === 'L' || kind === 'FL' || /UH|NH|OHM/.test(s) ? parseInductor(s) : undefined;
    if (iv && (iv.h !== undefined || kind === 'L' || kind === 'FL')) {
      p.valueText = s;
      if (iv.amps !== undefined) p.irated = iv.amps;
      if (iv.dcr !== undefined) p.dcr = iv.dcr;
      if (iv.tol) p.tolerance ??= iv.tol;
      if (iv.h !== undefined) { p.value = iv.h; p.valueKind = 'L'; }
      else { p.value = iv.beadOhms; p.valueKind = 'bead'; }
      return;
    }
    const o = /[KMR]$|[KMR]\d|^\d+(\.\d+)?$|OHMS?$/.test(s) && (kind === 'R' || kind === 'RP' || /[KR]/.test(s)) ? parseOhms(s) : undefined;
    if (o !== undefined && (kind === 'R' || kind === 'RP' || kind === 'C' || kind === 'L')) { p.value = o; p.valueText = s; p.valueKind = 'R'; return; }
  }
  if (TOL_RE.test(s)) { p.tolerance ??= s; return; }
  if (POWER_RE.test(s)) { p.power ??= s; return; }
  if (VOLT_RE.test(s)) { p.voltage ??= s; return; }
  if (DIELECTRIC_RE.test(s)) { p.dielectric ??= s; return; }
  if (PKG_RE.test(s) || /^(01005|0?201|0?402|0?603|0805|1206|1210|2512)$/.test(s)) { p.pkg ??= s; return; }
  if (!p.partNumber && /[A-Z]/.test(s) && /\d/.test(s) && s.length >= 4 && !/\s/.test(s)) {
    // Apple part-number suffixes (_SBMS001, -HF) are kept; electrical names like "VIN" lack digits.
    p.partNumber = s;
  }
}

/**
 * Whether a part is fitted in the BOM configuration described by `options`.
 * Note: an unfitted part on a SHORT footprint still conducts through footprint copper —
 * see `SchematicPart.shortFootprint`.
 */
export function isStuffed(p: SchematicPart, options: Set<string> | null): boolean {
  const o = p.bomOption;
  if (!o) return true;
  if (NOT_STUFFED.has(o)) return false;
  if (o === 'OMIT_TABLE') return true; // supplied through a part table (CPU, ROMs)
  if (!options) return true;
  return options.has(o);
}
