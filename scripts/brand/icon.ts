// Writes the PurpleBoard icon SVGs from src/ui/brand-icon.ts (SHKLR brand kit rev 4 layout).
// PNGs are rendered from the same SVGs in headless Chrome (public/favicon-32.png, public/icons/*.png).
import { writeFileSync, mkdirSync } from 'node:fs';
import { iconSvg, faviconSvg } from '../../src/ui/brand-icon.ts';

const root = new URL('../../', import.meta.url);
const clean = (s: string) => s.replace(' aria-hidden="true"', '') + '\n';
writeFileSync(new URL('public/favicon.svg', root), faviconSvg() + '\n');
mkdirSync(new URL('docs/brand/', root), { recursive: true });
writeFileSync(new URL('docs/brand/purpleboard-favicon.svg', root), faviconSvg() + '\n');
for (const mode of ['light', 'dark'] as const) for (const kind of ['tile', 'square', 'maskable'] as const) {
  writeFileSync(new URL(`docs/brand/purpleboard-${kind}-${mode}.svg`, root), clean(iconSvg({ mode, kind })));
}
console.log('icons written');
