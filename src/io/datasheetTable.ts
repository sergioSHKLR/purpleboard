// Datasheet table extractor (developer tool behind `npm run parts -- extract`, never shipped).
//
// Reads the text of a datasheet as `pdftotext -layout` prints it and pulls out the electrical-
// characteristics rows the device library needs (VGS(th), RDS(on), VSD, Ciss/Coss/Crss, VF, VBR,
// CD, hFE, VBE, Rth(j-a)) with Min / Typ / Max kept apart and the test conditions parsed. It then
// drafts a device-library entry (src/spice/devicelib.ts) for a person to check against the PDF:
// every value that is not a 25 °C typical is called out, and pin numbers are never guessed.
//
// Layout: values are assigned to columns by their x position under the table header (Min, Typ,
// Max, Unit), so numbers in the conditions column never become values. A row whose symbol is on
// another line (Vishay prints RDS(on) between its two value rows; Nexperia prints it above them)
// is attached to the nearest symbol line that carries no values of its own.

export type Quantity = 'vgsth' | 'rdson' | 'vsd' | 'ciss' | 'coss' | 'crss' | 'vf' | 'vbr' | 'vz' | 'vrwm' | 'cd' | 'ir' | 'hfe' | 'vbe' | 'rthja';

export interface TableRow {
  quantity: Quantity;
  /** Symbol as printed. */
  symbol: string;
  min?: number;
  typ?: number;
  max?: number;
  /** SI unit the values were scaled to ('V', 'Ω', 'F', 'A', '°C/W', '' for hFE). */
  unit: string;
  /** Unit as printed, or how it was inferred. */
  unitSource: string;
  /** Parsed test conditions in SI units (VGS, ID, IS, IF, VR, IR, IZ, IT, VDS, IC, VCE, T). */
  cond: Record<string, number>;
  /** Raw conditions text. */
  condText: string;
  /** 1-based line in the pdftotext output. */
  line: number;
  /** Measured at a junction / ambient temperature other than 25 °C. */
  hot: boolean;
  /** Part numbers the row is limited to, when the table covers several parts. */
  parts?: string[];
}

const SYMBOLS: [Quantity, RegExp][] = [
  ['vgsth', /\bV\s?GS\s?\(?th\)?/i],
  ['rdson', /\bR\s?DS\s?\(?on\)?/i],
  ['vsd', /\bV\s?SD\b/i],
  ['ciss', /\bC\s?iss\b/i],
  ['coss', /\bC\s?oss\b/i],
  ['crss', /\bC\s?rss\b/i],
  ['vbr', /\bV\s?\(BR\)(?!DSS|GSS|CEO|CBO|EBO)R?\b|\bV\s?BR\b|\bBV\s?R?\b/i],
  ['vz', /\bV\s?Z\b/],
  ['vrwm', /\bV\s?RWM\b/i],
  ['vf', /\bV\s?F\b/],
  ['cd', /\bC\s?(d|D|j|J|T|t|tot|O|o)\b/],
  ['ir', /\bI\s?R\b/],
  ['hfe', /\bh\s?FE\b/i],
  ['vbe', /\bV\s?BE(\s?\((on|sat)\))?/i],
  ['rthja', /\bR\s?th\s?\(?j-?a\)?|\bR\s?thJA\b|\bR\s?θ\s?JA\b|θ\s?JA\b/i],
];

const DEFAULT_UNIT: Record<Quantity, string> = {
  vgsth: 'V', rdson: 'Ω', vsd: 'V', ciss: 'pF', coss: 'pF', crss: 'pF', vf: 'V', vbr: 'V', vz: 'V', vrwm: 'V',
  cd: 'pF', ir: 'µA', hfe: '', vbe: 'V', rthja: 'K/W',
};

const PREFIX: Record<string, number> = { p: 1e-12, n: 1e-9, µ: 1e-6, μ: 1e-6, u: 1e-6, m: 1e-3, '': 1, k: 1e3, K: 1e3, M: 1e6 };
const UNIT_RE = /^(p|n|µ|μ|u|m|k|M)?(V|A|Ω|F|S|C|s|Hz)$|^(K\/W|°C\/W|ºC\/W|C\/W)$/;

/** Scale factor and SI base for a printed unit ("mΩ" → [1e-3, 'Ω']); undefined when not a unit. */
export function parseUnit(u: string): [number, string] | undefined {
  const s = u.replace(/^Ohm$/i, 'Ω').replace(/ohm$/i, 'Ω');
  const m = UNIT_RE.exec(s);
  if (!m) return undefined;
  if (m[3]) return [1, '°C/W'];
  return [PREFIX[m[1] ?? ''], m[2]];
}

interface Col { name: 'min' | 'typ' | 'max' | 'unit'; x: number }
interface Tok { text: string; x0: number; x1: number }

function tokens(line: string): Tok[] {
  const out: Tok[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push({ text: m[0], x0: m.index, x1: m.index + m[0].length });
  return out;
}

const HEADER_TOKEN: [Col['name'], RegExp][] = [
  ['min', /^(min\.?|minimum)$/i],
  ['typ', /^(typ\.?|typical)$/i],
  ['max', /^(max\.?|maximum)$/i],
  ['unit', /^(units?\.?)$/i],
];

/** Column positions when the line is a table header with at least two of Min / Typ / Max. */
function headerCols(line: string): Col[] | null {
  const cols: Col[] = [];
  for (const t of tokens(line)) {
    const h = HEADER_TOKEN.find(([, re]) => re.test(t.text));
    if (h && !cols.some((c) => c.name === h[0])) cols.push({ name: h[0], x: (t.x0 + t.x1) / 2 });
  }
  return cols.filter((c) => c.name !== 'unit').length >= 2 ? cols.sort((a, b) => a.x - b.x) : null;
}

const NUM = /^[−–-]?\d+(\.\d+)?$/;
const DASH = /^[-−–—]$/;

/** Value-column tokens of a line: column → value (NaN for a dash placeholder), plus the unit token. */
function rowValues(line: string, cols: Col[]): { vals: Partial<Record<Col['name'], number>>; unit?: string; firstX: number; right: string } | null {
  const vcols = cols.filter((c) => c.name !== 'unit');
  const gaps = cols.slice(1).map((c, i) => c.x - cols[i].x);
  const half = Math.max(3, Math.min(...gaps) / 2);
  const vals: Partial<Record<Col['name'], number>> = {};
  let unit: string | undefined, firstX = Infinity, hits = 0;
  const toks = tokens(line.replace(/\[\d+\]/g, (s) => ' '.repeat(s.length)).replace(/±\s?/g, (s) => ' '.repeat(s.length)));
  for (const t of toks) {
    const cx = (t.x0 + t.x1) / 2;
    const near = cols.reduce((b, c) => (Math.abs(c.x - cx) < Math.abs(b.x - cx) ? c : b), cols[0]);
    if (Math.abs(near.x - cx) > half + t.text.length / 2) continue;
    if (near.name === 'unit' || (!NUM.test(t.text) && !DASH.test(t.text) && parseUnit(t.text))) {
      if (parseUnit(t.text) && !unit) unit = t.text;
      continue;
    }
    if (!vcols.includes(near)) continue;
    if (NUM.test(t.text)) { vals[near.name] = parseFloat(t.text.replace(/[−–]/, '-')); hits++; firstX = Math.min(firstX, t.x0); }
    else if (DASH.test(t.text)) { vals[near.name] = NaN; firstX = Math.min(firstX, t.x0); }
  }
  // text right of the last column: Diodes Inc. prints the test conditions there
  const edge = cols[cols.length - 1].x + half;
  const after = toks.find((t) => (t.x0 + t.x1) / 2 > edge && !(t.text === unit));
  const right = after ? line.slice(after.x0) : '';
  // a dash-only line is not a value row
  return hits ? { vals, unit, firstX, right } : null;
}

/** A parameter symbol the library does not use (IDSS, IGSS, ID(on), gfs, Qg, td(on)…). */
const OTHER_SYMBOL = /^([A-Z]\s?\([A-Z]{2}\)\w*|R\s?th\S*|[A-Z][a-z]{1,2}[A-Z]{1,3}|[A-Z][A-Z0-9]{1,5}(\([a-z]{2,3}\))?|[QRIVC][a-z]{1,3}(\(\w+\))?|g\s?fs|t[a-z]{1,2}(\(\w+\))?)$/;

function otherSymbol(text: string): boolean {
  return tokens(text).some((t) => OTHER_SYMBOL.test(t.text) && !CONDITION_FOLLOWS.test(text.slice(t.x1)) && !/^(A|V|mA|mV|PDF)$/.test(t.text));
}

/** What follows a name in a test condition: "IF = 10 mA", "tp ≤ 300 µs", "IR(meas) = 1 mA". */
const CONDITION_FOLLOWS = /^\s*(\([\w ]+\))?\s*[=≤≥<>]/;

/** Part numbers a row names ("1N4448WS / 1N914BWS"): tables that cover sister parts. */
const PART_TOKEN = /^\d?[A-Z]{1,5}\d{2,}[A-Z0-9]*$/;

/** First library symbol on the text left of the values (not a condition such as "VR = 1 V"). */
function findSymbol(text: string): { q: Quantity; symbol: string; x: number } | null {
  let best: { q: Quantity; symbol: string; x: number } | null = null;
  for (const [q, re] of SYMBOLS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = g.exec(text))) {
      if (CONDITION_FOLLOWS.test(text.slice(m.index + m[0].length))) continue;
      if (!best || m.index < best.x) best = { q, symbol: m[0].trim(), x: m.index };
      break;
    }
  }
  return best;
}

const COND_RE = /\b(V\s?GS|V\s?DS|I\s?D|I\s?S|I\s?F|V\s?R|I\s?R|I\s?ZT?|I\s?T|I\s?C|V\s?CE|T\s?(?:j|J|amb|A|a|C))\s*=\s*([+−–-]?\d+(?:\.\d+)?)\s*(p|n|µ|μ|u|m|k)?\s*(V|A|°C|ºC|Hz)?/g;

/** Test conditions in SI units ("VGS = 4.5 V; ID = 8.7 A" → { VGS: 4.5, ID: 8.7 }). */
export function parseConditions(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  let m: RegExpExecArray | null;
  const re = new RegExp(COND_RE.source, 'g');
  while ((m = re.exec(text))) {
    let key = m[1].replace(/\s/g, '').toUpperCase();
    if (/^T/.test(key)) key = 'T';
    if (key === 'IZT') key = 'IZ';
    if (key in out) continue;
    out[key] = parseFloat(m[2].replace(/[−–]/, '-')) * PREFIX[m[3] ?? ''];
  }
  return out;
}

/** Rows of the electrical-characteristics tables in `pdftotext -layout` text. */
export function extractRows(text: string): TableRow[] {
  const lines = text.split(/\r?\n/);
  const rows: TableRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const cols = headerCols(lines[i]);
    if (!cols) { i++; continue; }
    // table body: until the next header, a notes block, or 70 lines
    const start = i + 1;
    let end = start;
    while (end < lines.length && end - start < 70 && !headerCols(lines[end]) && !/^\s*(Notes?\b|\[1\]\s{2,}|Fig(ure)?\.?\s*\d)/.test(lines[end])) end++;
    const firstValX = Math.min(...cols.map((c) => c.x)) - 4;
    interface L { idx: number; values: ReturnType<typeof rowValues>; sym: ReturnType<typeof findSymbol>; other: boolean; left: string }
    const body: L[] = [];
    for (let k = start; k < end; k++) {
      const values = rowValues(lines[k], cols);
      const cut = values ? Math.min(values.firstX, firstValX) : firstValX;
      const left = lines[k].slice(0, Math.max(0, cut));
      const sym = findSymbol(left);
      body.push({ idx: k, values, sym, other: !sym && otherSymbol(left), left });
    }
    for (let k = 0; k < body.length; k++) {
      const b = body[k];
      if (!b.values) continue;
      if (b.other) continue; // a parameter the library does not use
      let owner: L | undefined = b.sym ? b : undefined;
      if (!owner) {
        // nearest symbol line without values of its own, not past another symbol line
        const isSym = (x: L) => !!x.sym || x.other;
        for (let d = 1; d <= 4 && !owner; d++) {
          for (const j of [k - d, k + d]) {
            const c = body[j];
            if (!c || !isSym(c)) continue;
            const between = body.slice(Math.min(j, k) + 1, Math.max(j, k));
            if (c.values || between.some((x) => isSym(x) || x.values)) continue;
            owner = c;
            break;
          }
        }
      }
      // else a continuation row of the symbol above it (Nexperia: RDSon at 25 °C, 150 °C, 4.5 V),
      // else, first rows of a table, the symbol just below (Diodes Inc. centres it on its rows)
      for (let j = k - 1; !owner && j >= Math.max(0, k - 6); j--) if (body[j].sym || body[j].other) owner = body[j];
      for (let j = k + 1; !owner && j <= Math.min(body.length - 1, k + 2); j++) if (body[j].sym || body[j].other) owner = body[j];
      if (!owner?.sym) continue;
      const q = owner.sym.q;
      // unit: this row's, else a unit-only line next to it (Vishay prints "V" between two rows)
      let unitTxt = b.values.unit;
      for (let d = 1; d <= 2 && !unitTxt; d++) for (const j of [k - d, k + d]) if (!unitTxt && body[j] && !body[j].values && !(body[j] !== owner && (body[j].sym || body[j].other))) unitTxt = unitOnly(lines[body[j].idx], cols);
      const parsed = unitTxt ? parseUnit(unitTxt) : undefined;
      const [scale, si] = parsed ?? parseUnit(DEFAULT_UNIT[q]) ?? [1, ''];
      if (q !== 'hfe' && si !== parseUnit(DEFAULT_UNIT[q])?.[1]) continue; // a unit that does not fit: a misread row
      // conditions: this row's own text (left of the values and right of the units), else the symbol line's
      // a row's conditions can continue on the lines below it ("pulsed; Tamb = 85 °C")
      let more = '';
      for (let j = k + 1; j <= k + 2 && body[j] && body[j].left.trim() && !body[j].values && !body[j].sym && !body[j].other; j++) more += ' ' + lines[body[j].idx];
      const own = `${b.left.slice(owner === b ? owner.sym.x + owner.sym.symbol.length : 0)} ${b.values.right}${more}`.trim();
      const ownerRight = owner.values?.right ?? '';
      const condText = (own || `${owner.left} ${ownerRight}`).replace(/\s+/g, ' ').trim();
      const cond = { ...parseConditions(`${owner.left} ${ownerRight}`), ...parseConditions(`${b.left} ${b.values.right}${more}`) };
      const parts = tokens(b.left).map((t) => t.text).filter((t) => PART_TOKEN.test(t));
      const v = (x?: number) => (x === undefined || Number.isNaN(x) ? undefined : +(x * scale).toPrecision(6));
      rows.push({
        quantity: q, symbol: owner.sym.symbol, min: v(b.values.vals.min), typ: v(b.values.vals.typ), max: v(b.values.vals.max),
        unit: q === 'hfe' ? '' : si, unitSource: parsed ? unitTxt! : `assumed ${DEFAULT_UNIT[q] || '(none)'}`,
        cond, condText, line: b.idx + 1, hot: cond.T !== undefined && Math.abs(cond.T - 25) > 1, ...(parts.length && { parts }),
      });
    }
    i = end;
  }
  return rows;
}

function unitOnly(line: string | undefined, cols: Col[]): string | undefined {
  const u = cols.find((c) => c.name === 'unit');
  if (!line || !u) return undefined;
  for (const t of tokens(line)) if (Math.abs((t.x0 + t.x1) / 2 - u.x) <= 4 && parseUnit(t.text)) return t.text;
  return undefined;
}

/** Document identity lines worth citing (revision, document number, date). */
export function documentId(text: string): string[] {
  const head = text.split(/\r?\n/).slice(0, 400).join('\n');
  const out = new Set<string>();
  for (const re of [/Rev(?:ision)?\.?\s*[\w.-]+\s*[—–,-]\s*\d{1,2}[ -][A-Za-z]{3,9}[ -]\d{2,4}/g, /Document Number:?\s*\d+/gi, /\bDS\d{4,6}\s+Rev\.?\s*[\w.-]+/g, /\bS[LN][A-Z]{2}\d{3}[A-Z]?\b[^\n]{0,40}?(19|20)\d\d/g, /Product data sheet[^\n]{0,60}/gi]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(head)) && out.size < 8) out.add(m[0].replace(/\s+/g, ' ').trim());
  }
  const all = [...out];
  return all.filter((a) => !all.some((b) => b !== a && b.includes(a))).slice(0, 4);
}

/** Lines of a series table (zeners, TVS) that name the part: rating tables list one type per row. */
export function seriesRows(text: string, partNumber: string): { header: string[]; row: string; line: number }[] {
  const lines = text.split(/\r?\n/);
  const key = partNumber.toUpperCase().replace(/[-,].*$/, '');
  const out: { header: string[]; row: string; line: number }[] = [];
  lines.forEach((l, i) => {
    const toks = tokens(l);
    if (!toks.some((t) => t.text.toUpperCase().replace(/[-,].*$/, '') === key)) return;
    if (toks.filter((t) => NUM.test(t.text)).length < 3) return;
    const header: string[] = [];
    for (let k = i - 1; k >= Math.max(0, i - 40) && header.length < 12; k--) {
      if (tokens(lines[k]).filter((t) => NUM.test(t.text)).length >= 3) continue; // other types' rows
      if (lines[k].trim()) header.unshift(lines[k]);
    }
    out.push({ header, row: l, line: i + 1 });
  });
  return out;
}

// ---------------- draft library entry ----------------

const fmtV = (v: number) => +v.toPrecision(4);

export interface Draft { kind: 'nmos' | 'pmos' | 'diode' | 'npn' | 'unknown'; entry: string; review: string[] }

/** Typical, or a flagged stand-in: midpoint of the limits, or the one limit given. */
function pick(r: TableRow, review: string[], what: string): number | undefined {
  if (r.typ !== undefined) return r.typ;
  if (r.min !== undefined && r.max !== undefined) { review.push(`${what}: no typical (${Math.abs(r.min)}–${Math.abs(r.max)} ${r.unit}): midpoint used (line ${r.line})`); return (r.min + r.max) / 2; }
  const lim = r.max ?? r.min;
  if (lim !== undefined) review.push(`${what}: only a ${r.max !== undefined ? 'maximum' : 'minimum'} (${lim} ${r.unit}) is given: used as is, read the typical from the graphs (line ${r.line})`);
  return lim;
}

/**
 * Draft device-library entry from extracted rows: typicals at 25 °C where the table gives them,
 * every stand-in listed in `review`. Pins are left for the person (pinout drawings are images).
 */
export function draftEntry(mpn: string, text: string, rows: TableRow[]): Draft {
  const review: string[] = [];
  const base = mpn.toUpperCase().replace(/[-,].*$/, '');
  const mine = (r: TableRow) => !r.parts || r.parts.some((p) => base.startsWith(p) || p.startsWith(base));
  const others = rows.filter((r) => !mine(r));
  if (others.length) review.push(`left out ${others.length} row(s) that name other parts (${[...new Set(others.flatMap((r) => r.parts!))].join(', ')}): lines ${others.map((r) => r.line).join(', ')}`);
  const cool = rows.filter((r) => !r.hot && mine(r));
  const of = (q: Quantity) => cool.filter((r) => r.quantity === q);
  const pChannel = /P-?\s?channel|P-?\s?MOSFET|P-?\s?Ch\b/i.test(text.slice(0, 6000));
  const lines: string[] = [];
  let kind: Draft['kind'] = 'unknown';
  const theta = of('rthja')[0];
  const thetaJA = theta ? pick(theta, review, 'θJA') : undefined;
  if (theta) review.push(`θJA ${thetaJA} °C/W: state its mounting condition in the note (${theta.condText || 'no condition text'}, line ${theta.line})`);

  if (of('vgsth').length || of('rdson').length) {
    kind = pChannel ? 'pmos' : 'nmos';
    const th = of('vgsth')[0];
    const vth = th ? Math.abs(pick(th, review, 'VGS(th)') ?? NaN) : NaN;
    const rds = of('rdson').filter((r) => r.cond.VGS !== undefined).map((r) => [Math.abs(r.cond.VGS), pick(r, review, `RDS(on) at ${Math.abs(r.cond.VGS)} V`)] as [number, number | undefined]).filter((p): p is [number, number] => p[1] !== undefined);
    const uniq = rds.filter((p, i) => rds.findIndex((q) => q[0] === p[0]) === i).sort((a, b) => b[0] - a[0]);
    if (!uniq.length) review.push('RDS(on): no row with a VGS condition found: read it from the table');
    const sd = of('vsd')[0];
    const body = sd && sd.cond.IS !== undefined ? `, body: [${fmtV(Math.abs(pick(sd, review, 'VSD') ?? NaN))}, ${fmtV(Math.abs(sd.cond.IS))}]` : '';
    if (!sd) review.push('VSD (body diode): not found in the tables');
    const c = (q: Quantity) => { const r = of(q)[0]; return r?.typ; };
    const ciss = c('ciss'), crss = c('crss'), coss = c('coss');
    const caps = ciss !== undefined && crss !== undefined && coss !== undefined ? `, caps: [${ciss}, ${crss}, ${coss}]` : '';
    if (!caps) review.push('Ciss / Crss / Coss: no complete typical set in the tables (graph only?): omit caps or read the curves');
    lines.push(`units: [{ kind: '${kind}', vth: ${Number.isFinite(vth) ? fmtV(vth) : 'TODO'}, rds: [${uniq.map(([v, r]) => `[${fmtV(v)}, ${+r.toPrecision(4)}]`).join(', ')}]${body}${caps}, pins: { D: 'TODO', G: 'TODO', S: 'TODO' } }]`);
    if (/dual|2 x|two/i.test(text.slice(0, 3000))) review.push('the document mentions a dual device: add one unit per FET');
  } else if (of('vf').length || of('vbr').length || of('vz').length) {
    kind = 'diode';
    const vf = of('vf').filter((r) => r.cond.IF !== undefined).map((r) => [pick(r, review, `VF at ${r.cond.IF} A`), r.cond.IF] as [number | undefined, number]).filter((p): p is [number, number] => p[0] !== undefined);
    const pts = vf.filter((p, i) => vf.findIndex((q) => q[1] === p[1]) === i).sort((a, b) => a[1] - b[1]);
    const br = of('vz')[0] ?? of('vbr')[0];
    const brI = br ? (br.cond.IZ ?? br.cond.IR ?? br.cond.IT) : undefined;
    const brV = br ? pick(br, review, 'breakdown') : undefined;
    const cd = of('cd')[0];
    const schottky = /schottky/i.test(text.slice(0, 4000)), zener = /zener/i.test(text.slice(0, 4000));
    const dk = zener ? 'zener' : schottky ? 'schottky' : 'diode';
    if (!pts.length) review.push('VF: no row with an IF condition: read the forward curve');
    if (!br) review.push('breakdown: no VBR / VZ row: use the VR rating and say so in the note');
    lines.push(`units: [{ kind: '${dk}', vf: [${pts.map(([v, i]) => `[${fmtV(v)}, ${fmtV(i)}]`).join(', ')}]${brV !== undefined ? `, bv: [${fmtV(brV)}, ${brI !== undefined ? fmtV(brI) : 'TODO'}]` : ''}${cd?.typ !== undefined ? `, cj: ${cd.typ}` : ''}, pins: { A: 'TODO', K: 'TODO' } }]`);
  } else if (of('hfe').length) {
    kind = 'npn';
    const h = of('hfe')[0], be = of('vbe')[0];
    lines.push(`units: [{ kind: 'npn', hfe: ${pick(h, review, 'hFE') ?? 'TODO'}, vbe: [${be ? pick(be, review, 'VBE') : 'TODO'}, ${be?.cond.IC ?? 'TODO'}], pins: { C: 'TODO', B: 'TODO', E: 'TODO' } }]`);
    review.push('check NPN vs PNP');
  } else review.push('no MOSFET, diode or BJT rows recognised: read the tables by hand');

  const ids = documentId(text);
  review.push(`source: cite the document id + revision (found: ${ids.length ? ids.join(' | ') : 'nothing; read the footer'})`);
  review.push('pins: read the pinout drawing (pin numbers are images in most PDFs) and net-check on a board');
  const entry = `{ mpn: '${mpn}', description: 'TODO', pkg: 'TODO', verified: false,\n  source: 'TODO',${thetaJA !== undefined ? ` thetaJA: ${fmtV(thetaJA)},` : ''}\n  note: 'TODO',\n  ${lines.join('\n  ')} },`;
  return { kind, entry, review };
}
