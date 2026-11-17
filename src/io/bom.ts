// Universal BOM import (CSV / TSV / semicolon, as exported by KiCad, Altium, OrCAD, EasyEDA,
// Eagle, JLC/PCBWay templates…) → the same Schematic structure the PDF extractor produces,
// so the library builder and device resolver work unchanged on any board.
import type { Schematic, SchematicPart } from './schematic';
import { parseFarads, parseInductor } from './schematic';

const COLS: Record<'ref' | 'value' | 'mpn' | 'dnp' | 'pkg' | 'desc', RegExp> = {
  ref: /^(designators?|references?|ref(\s*des)?|refdes|parts?|part\s*refs?)$/i,
  value: /^(value|val|comment|values?)$/i,
  mpn: /^(mpn|mfr\.?\s*(part|p\/?n)|manufacturer\s*part(\s*number)?|part\s*number|mfg\s*p\/?n|lcsc|manufacturer_part_number)$/i,
  dnp: /^(dnp|dni|do\s*not\s*(place|populate)|populate|fitted|exclude\s*from\s*bom|nostuff)$/i,
  pkg: /^(footprint|package|case|pcb\s*footprint)$/i,
  desc: /^(description|desc)$/i,
};

function splitLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** "R1, R2 R5-R7" → [R1, R2, R5, R6, R7] */
export function expandDesignators(s: string): string[] {
  const out: string[] = [];
  for (const tok of s.split(/[\s,;]+/).filter(Boolean)) {
    const m = /^([A-Za-z_]+)(\d+)-(?:\1)?(\d+)$/.exec(tok);
    if (m && +m[3] >= +m[2] && +m[3] - +m[2] < 500) for (let k = +m[2]; k <= +m[3]; k++) out.push(m[1] + k);
    else out.push(tok);
  }
  return out;
}

/** Generic value text from a BOM: "10k", "4k7", "0R", "1M" (mega), "100nF 16V X7R", "2.2uH 3A", "120R@100MHz". */
export function parseBomValue(prefix: string, raw: string): Pick<SchematicPart, 'value' | 'valueKind' | 'esr' | 'irated' | 'dcr' | 'voltage' | 'tolerance' | 'dielectric'> {
  const out: ReturnType<typeof parseBomValue> = {};
  const words = raw.replace(/Ω|ohms?/gi, 'R').replace(/µ/g, 'u').split(/[\s,/]+/).filter(Boolean);
  for (const w0 of words) {
    const w = w0.toUpperCase();
    if (/^\d+(\.\d+)?V$/.test(w)) { out.voltage ??= w; continue; }
    if (/^[±+-]?\d+(\.\d+)?%$/.test(w)) { out.tolerance ??= w.replace(/^[±+-]/, ''); continue; }
    if (/^(X\dR|X\dS|NP0|C0G|Y5V)$/.test(w)) { out.dielectric ??= w; continue; }
    if (out.value !== undefined) continue;
    const f = parseFarads(w.replace(/F$/, 'F').replace(/^(\d+(?:\.\d+)?)([UNP])$/, '$1$2F'));
    if (f && (prefix === 'C' || /F$/.test(w))) { out.value = f.f; out.valueKind = 'C'; continue; }
    const l = parseInductor(w.replace(/@.*$/, ''));
    if (l && (l.h !== undefined || prefix === 'L' || prefix === 'FB')) {
      if (l.h !== undefined) { out.value = l.h; out.valueKind = 'L'; } else { out.value = l.beadOhms; out.valueKind = 'bead'; }
      if (l.amps !== undefined) out.irated = l.amps;
      continue;
    }
    if (prefix === 'R' || prefix === 'RN' || prefix === 'RP') {
      // 10K, 4K7, 2R2, 0R, 1M (BOM convention: M = mega), 1MEG, 100
      const m = /^(\d+(?:\.\d+)?)(R|K|M|MEG|G)?(\d*)$/.exec(w);
      if (m && !(m[3] && m[1].includes('.'))) {
        const mult = m[2] === 'K' ? 1e3 : m[2] === 'M' || m[2] === 'MEG' ? 1e6 : m[2] === 'G' ? 1e9 : 1;
        out.value = parseFloat(m[3] ? `${m[1]}.${m[3]}` : m[1]) * mult;
        out.valueKind = 'R';
      }
    }
    if (prefix === 'FB' && /^\d+R$/.test(w)) { out.value = parseFloat(w); out.valueKind = 'bead'; }
  }
  return out;
}

const truthy = (s: string) => /^(1|y|yes|true|x|dnp|dni|nostuff|not fitted)$/i.test(s.trim());

export function parseBomCsv(text: string): Schematic {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim());
  // header = first line that names a designator column; separator = most frequent of , ; \t
  let hi = lines.findIndex((l) => /designator|reference|refdes|ref des|\bref\b/i.test(l));
  if (hi < 0) hi = 0;
  const sep = [',', ';', '\t'].sort((a, b) => lines[hi].split(b).length - lines[hi].split(a).length)[0];
  const head = splitLine(lines[hi], sep);
  const idx = Object.fromEntries(Object.entries(COLS).map(([k, re]) => [k, head.findIndex((h) => re.test(h.trim()))])) as Record<keyof typeof COLS, number>;
  if (idx.ref < 0) throw new Error('BOM has no designator/reference column');
  const parts = new Map<string, SchematicPart>();
  for (const line of lines.slice(hi + 1)) {
    const c = splitLine(line, sep);
    const refs = expandDesignators(c[idx.ref] ?? '');
    const value = idx.value >= 0 ? c[idx.value] ?? '' : '';
    const mpn = idx.mpn >= 0 ? c[idx.mpn] ?? '' : '';
    const dnpCell = idx.dnp >= 0 ? c[idx.dnp] ?? '' : '';
    const populateCol = idx.dnp >= 0 && /^(populate|fitted)$/i.test(head[idx.dnp]);
    const dnp = populateCol ? !truthy(dnpCell) && dnpCell !== '' : truthy(dnpCell) || /\b(DNP|DNF|DNI|NC|NOSTUFF|NO STUFF)\b/i.test(value);
    for (const ref of refs) {
      if (!/^[A-Za-z_]+\d+/.test(ref)) continue;
      const prefix = ref.replace(/\d.*$/, '').toUpperCase();
      const v = parseBomValue(prefix, value);
      parts.set(ref, {
        ref, pages: [0], attrs: {}, tokens: [value, mpn].filter(Boolean), ...v,
        valueText: value || undefined,
        ...(mpn && { partNumber: mpn }),
        ...(idx.pkg >= 0 && c[idx.pkg] && { pkg: c[idx.pkg] }),
        ...(dnp && { bomOption: 'NO STUFF' }),
      });
    }
  }
  return { parts, bom: { defs: new Map(), tableParts: [], alternates: new Map(), products: [] }, unknownRefs: [] };
}

export interface BomApplyReport {
  /** Board parts found in the BOM. */
  matched: number;
  /** Resistor / capacitor values set from the BOM (replacing importer defaults). */
  values: number;
  /** Parts the BOM marks as not fitted (DNP), now unpopulated. */
  dnp: number;
  /** BOM designators with no part on the board. */
  missing: string[];
}

/**
 * Applies a BOM (or extracted schematic) to a board: R / C values, DNP → unpopulated, value text as
 * the part label when the board had none. Only fills what the BOM states; everything else is untouched.
 */
export function applyBom(board: import('../types').Board, sch: Schematic): BomApplyReport {
  const byRef = new Map([...sch.parts].map(([k, v]) => [k.toUpperCase(), v]));
  const seen = new Set<string>();
  const rep: BomApplyReport = { matched: 0, values: 0, dnp: 0, missing: [] };
  for (const c of board.components) {
    const p = byRef.get(c.ref.toUpperCase());
    if (!p) continue;
    seen.add(c.ref.toUpperCase());
    rep.matched++;
    if (p.bomOption && !isStuffedPart(p)) { c.state.populated = false; rep.dnp++; continue; }
    const v = p.value;
    if (v !== undefined && Number.isFinite(v)) {
      if (c.kind === 'resistor' && p.valueKind === 'R' && v >= 0) { c.value = v; c.valueGuessed = undefined; rep.values++; }
      else if (c.kind === 'capacitor' && p.valueKind === 'C' && v > 0) { c.value = v; c.valueGuessed = undefined; rep.values++; }
    }
    if (!c.label && p.valueText) c.label = p.valueText.slice(0, 60);
  }
  for (const k of byRef.keys()) if (!seen.has(k)) rep.missing.push(k);
  return rep;
}

const isStuffedPart = (p: SchematicPart) => !/^(NO ?STUFF|NO_STUFF|OMIT)$/.test(p.bomOption ?? '');
