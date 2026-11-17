// DEADBOARD mark: a board outline (chamfered corner) whose trace flatlines, then spikes back
// to life and ends in a via — "bring dead boards back". One source for the header, favicon
// and brand files; colours come from CSS (currentColor + --brand-signal) unless given.

const BOARD = 'M7 4h15l6 6v15a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3z';
const TRACE = 'M4 17h7l2.5-7 3 13 2.5-8h4';

export function markSvg(size = 20, colors: { board?: string; signal?: string; fill?: string } = {}): string {
  const board = colors.board ?? 'currentColor';
  const signal = colors.signal ?? 'var(--brand-signal)';
  const fill = colors.fill ?? 'none';
  return `<svg class="brand-svg" width="${size}" height="${size}" viewBox="0 0 32 32" fill="none" aria-hidden="true">`
    + `<path d="${BOARD}" fill="${fill}" stroke="${board}" stroke-width="2" stroke-linejoin="round"/>`
    + `<path d="${TRACE}" stroke="${signal}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`
    + `<circle cx="25" cy="15" r="2.2" fill="${fill === 'none' ? 'var(--bg)' : fill}" stroke="${signal}" stroke-width="2"/>`
    + '</svg>';
}

export const BRAND = {
  name: 'DEADBOARD',
  tagline: 'Bring dead boards back.',
  descriptor: 'Board-level repair trainer',
  site: 'https://tholtman1-del.github.io/deadboard/',
} as const;
