// PurpleBoard app icon, SHKLR brand kit rev 4 style: the Lucide "square-activity" stroke glyph
// (a rounded square with a pulse line; 24 grid, stroke 2). Dual mode: violet #7c3aed on a white
// plate (light) and #a78bfa on #1a1a1a (dark). Tile = rounded plate rx 5.25, glyph 80 %; square =
// full-bleed plate, glyph 70 % (apple-touch); maskable = full-bleed, glyph 58 % (inside the 80 %
// safe circle). The favicon is the bare glyph, switching colour with prefers-color-scheme.
// One source for the header mark (markSvg), public/ icons and docs/brand/ (`node scripts/brand/icon.ts`).

export type IconMode = 'light' | 'dark';
export const ICON_COLORS = {
  light: { plate: '#ffffff', glyph: '#7c3aed' },
  dark: { plate: '#1a1a1a', glyph: '#a78bfa' },
} as const;

/** Glyph: Lucide "square-activity" (ISC licence), a rounded square with an activity / pulse line. 24×24, stroke 2. */
const GLYPH = ['M17 12h-2l-2 5-2-10-2 5H7'];
const FRAME = { x: 3, y: 3, w: 18, h: 18, rx: 2 };

function glyph(color: string, cls = ''): string {
  const c = cls ? ` class="${cls}"` : '';
  return GLYPH.map((d) => `<path${c} d="${d}" stroke="${color}"/>`).join('')
    + `<rect${c} x="${FRAME.x}" y="${FRAME.y}" width="${FRAME.w}" height="${FRAME.h}" rx="${FRAME.rx}" stroke="${color}"/>`;
}
const STROKE = 'fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

export type IconKind = 'tile' | 'square' | 'maskable';
/** Plated icon. kind: tile (rounded), square (apple-touch), maskable. */
export function iconSvg({ mode = 'dark', kind = 'tile', size }: { mode?: IconMode; kind?: IconKind; size?: number } = {}): string {
  const { plate, glyph: g } = ICON_COLORS[mode];
  const scale = kind === 'tile' ? 0.8 : kind === 'square' ? 0.7 : 0.58;
  const off = (24 - 24 * scale) / 2;
  const sz = size ? ` width="${size}" height="${size}"` : '';
  const rx = kind === 'tile' ? ' rx="5.25"' : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"${sz} aria-hidden="true">`
    + `<rect width="24" height="24"${rx} fill="${plate}"/>`
    + `<g transform="translate(${off.toFixed(3)} ${off.toFixed(3)}) scale(${scale})" ${STROKE}>${glyph(g)}</g></svg>`;
}

/** Favicon: bare glyph on transparent, violet in light tabs, light violet in dark tabs. */
export function faviconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ${STROKE}>`
    + `<style>@media (prefers-color-scheme:dark){.sc0{stroke:${ICON_COLORS.dark.glyph}}}</style>`
    + `${glyph(ICON_COLORS.light.glyph, 'sc0')}</svg>`;
}
