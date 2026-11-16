// SPICE number syntax: 4.7k, 10u, 1meg, 2.2p, 1e-3, 100mil, trailing unit letters ignored.

const SCALE: [string, number][] = [
  ['meg', 1e6], ['mil', 25.4e-6], ['t', 1e12], ['g', 1e9], ['k', 1e3],
  ['m', 1e-3], ['u', 1e-6], ['µ', 1e-6], ['n', 1e-9], ['p', 1e-12], ['f', 1e-15], ['a', 1e-18],
];

/** Parses a SPICE number. Returns NaN when `s` does not start with a number. */
export function parseSpiceNumber(s: string): number {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(.*)$/i.exec(s.trim());
  if (!m) return NaN;
  const base = parseFloat(m[1]);
  const rest = m[2].toLowerCase();
  for (const [suf, k] of SCALE) {
    if (!rest.startsWith(suf)) continue;
    // Scale via a decimal exponent so "10f" is exactly 1e-14 (no binary rounding from 10 * 1e-15).
    const p10 = Math.round(Math.log10(k));
    if (Math.abs(10 ** p10 - k) / k < 1e-12) {
      const em = /^([^e]*)(?:e([+-]?\d+))?$/i.exec(m[1])!;
      return parseFloat(`${em[1]}e${(em[2] ? parseInt(em[2], 10) : 0) + p10}`);
    }
    return base * k;
  }
  return base;
}

/** Formats a number compactly with SPICE suffixes (ngspice-compatible: uses "meg" not "M"). */
export function formatSpiceNumber(v: number): string {
  if (!isFinite(v)) return v > 0 ? '1e30' : v < 0 ? '-1e30' : '0';
  if (v === 0) return '0';
  const a = Math.abs(v);
  const pick: [number, string][] = [
    [1e12, 't'], [1e9, 'g'], [1e6, 'meg'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'u'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f'],
  ];
  for (const [k, suf] of pick) {
    if (a >= k * 0.9999999) {
      const n = v / k;
      return String(parseFloat(n.toPrecision(6))) + suf;
    }
  }
  return v.toExponential(5).replace(/\.?0+e/, 'e');
}
