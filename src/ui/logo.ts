// PurpleBoard mark: the app icon (soldering-iron tip on a pad, src/ui/brand-icon.ts) inline, so
// the header, the homepage and the favicon share one drawing.

import { tk } from '../i18n';
import { iconSvg } from './brand-icon';

let markSeq = 0;
/** The app icon at `size` px. `colors` is kept for older callers; the tile has fixed colours. */
export function markSvg(size = 20, _colors: { board?: string; signal?: string; fill?: string } = {}): string {
  return iconSvg({ id: `pbm${++markSeq}`, size }).replace('<svg ', '<svg class="brand-svg" ');
}

export const BRAND = {
  name: 'PurpleBoard',
  tagline: 'Bring dead boards back.',
  upstream: 'https://github.com/tholtman1-del/deadboard',
  descriptor: tk('Board-level repair trainer'),
  site: 'https://sergioshklr.github.io/purpleboard/',
} as const;
