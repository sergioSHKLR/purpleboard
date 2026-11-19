// Manufacturer part numbers on a board, for looking parts up in a catalogue (scripts/parts.ts).
// Board values mix real part numbers ("TLV62568DBV", "SIC477ED-T1-GE3") with generic values
// ("10k", "C_100n_0402", "LED_G_0603_…"); only the former can be looked up.
import type { Board } from '../types';

export interface BoardPart { value: string; refs: string[]; kind: string }

/** Whether a board value looks like a manufacturer part number rather than a generic value. */
export function looksLikePartNumber(v: string | undefined): v is string {
  if (!v) return false;
  const s = v.trim();
  if (s.length < 5 || s.length > 40 || /[_\s]/.test(s)) return false; // KiCad library names use '_'
  // starts with a letter (not "10k", "100nF"), or is a JEDEC number ("1N4148WS", "2N7002", "1SS355")
  const jedec = /^\d[A-Za-z]{1,2}\d{3,}[A-Za-z0-9.\-/+#,]*$/.test(s);
  if (!/^[A-Za-z][A-Za-z0-9.\-/+#,]*$/.test(s) && !jedec) return false;
  if (!/\d/.test(s) || (!jedec && !/[A-Za-z]{2,}/.test(s))) return false;
  // passive value notations that start with a letter ("R0402", "C0603", "DNP", "NC")
  if (/^(R|C|L|FB)\d{3,4}$/i.test(s) || /^(DNP|DNF|NC|N\/A)$/i.test(s)) return false;
  return true;
}

/** Distinct part numbers on a board with the parts that carry them. */
export function boardPartNumbers(board: Board): BoardPart[] {
  const by = new Map<string, BoardPart>();
  for (const c of board.components) {
    const v = c.label?.trim();
    if (!looksLikePartNumber(v)) continue;
    const key = v.toUpperCase();
    const e = by.get(key) ?? by.set(key, { value: v, refs: [], kind: c.kind }).get(key)!;
    e.refs.push(c.ref);
  }
  return [...by.values()].sort((a, b) => a.value.localeCompare(b.value));
}

/**
 * Manufacturers that design the parts they sell. Catalogues list second sources and clones under
 * the same part number ("BSS138PW" from TECH PUBLIC next to Nexperia's "BSS138PW,115"); library
 * numbers must come from the original maker's datasheet, so a lookup ranks these first.
 */
const ORIGINAL_MAKERS = /^(nexperia|nxp|onsemi|on semi|vishay|diodes inc|texas instruments|stmicroelectronics|infineon|international rectifier|rohm|littelfuse|toshiba|analog devices|maxim|microchip|renesas|kyocera avx|avx|bourns|panjit|semtech|alpha ?& ?omega|mcc|micro commercial|central semi|comchip|taiwan semi|richtek|monolithic power|silergy|murata|tdk|kemet|panasonic|yageo|samsung electro|epcos|würth|wurth)/i;

/** Whether a manufacturer name is an original maker (see ORIGINAL_MAKERS), not a clone house. */
export function isOriginalMaker(name: string | undefined): boolean {
  return !!name && ORIGINAL_MAKERS.test(name.trim());
}

/**
 * Search prefixes for a part number, most specific first: the full value, then with ordering
 * suffixes cut at '-' or ',' ("SIC477ED-T1-GE3" → "SIC477ED-T1" → "SIC477ED", "BAT46WJ,115" →
 * "BAT46WJ"), never shorter than 5.
 */
export function searchPrefixes(value: string): string[] {
  const out = [value.toUpperCase()];
  let s = out[0];
  for (let i = Math.max(s.lastIndexOf('-'), s.lastIndexOf(',')); i >= 5; i = Math.max(s.lastIndexOf('-'), s.lastIndexOf(','))) {
    s = s.slice(0, i);
    out.push(s);
  }
  return out;
}

export interface CatalogueRow { mfr: string; manufacturer?: string; datasheet?: string }

/**
 * Best catalogue row for a searched part number: the part itself or one of its ordering codes
 * ("BSS138PW,115", "SBR0560S1-7") before longer look-alikes ("BSS138PWQ"); then the original maker
 * before clones; then rows with a datasheet link; then the shortest code.
 */
export function rankCatalogue<T extends CatalogueRow>(searched: string, rows: T[]): T | undefined {
  const p = searched.toUpperCase();
  const tier = (r: T) => { const m = r.mfr.toUpperCase(); return m === p || (m.startsWith(p) && /^[,\-/ (]/.test(m.slice(p.length))) ? 0 : 1; };
  const key = (r: T) => [tier(r), isOriginalMaker(r.manufacturer) ? 0 : 1, r.datasheet ? 0 : 1, r.mfr.length];
  return [...rows].sort((a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return 0;
  })[0];
}
