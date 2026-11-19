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
  if (!/^[A-Za-z][A-Za-z0-9.\-/+#]*$/.test(s)) return false; // starts with a letter: not "10k", "100nF"
  if (!/\d/.test(s) || !/[A-Za-z]{2,}/.test(s)) return false;
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
 * Search prefixes for a part number, most specific first: the full value, then with ordering
 * suffixes cut at '-' ("SIC477ED-T1-GE3" → "SIC477ED-T1" → "SIC477ED"), never shorter than 5.
 */
export function searchPrefixes(value: string): string[] {
  const out = [value.toUpperCase()];
  let s = out[0];
  for (let i = s.lastIndexOf('-'); i >= 5; i = s.lastIndexOf('-')) {
    s = s.slice(0, i);
    out.push(s);
  }
  return out;
}
