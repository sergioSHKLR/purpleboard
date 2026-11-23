// Writes the PurpleBoard icon SVGs from src/ui/brand-icon.ts. PNGs are rendered from the same
// SVG in headless Chrome (public/favicon-32.png, public/icons/*.png).
import { writeFileSync } from 'node:fs';
import { iconSvg } from '../../src/ui/brand-icon.ts';
import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL('../../', import.meta.url);
  const clean = (s: string) => s.replace(' aria-hidden="true"', '') + '\n';
  writeFileSync(new URL('public/favicon.svg', root), clean(iconSvg()));
  writeFileSync(new URL('docs/brand/purpleboard-icon.svg', root), clean(iconSvg()));
  writeFileSync(new URL('docs/brand/purpleboard-icon-maskable.svg', root), clean(iconSvg({ maskable: true })));
  console.log('icons written');
}
