// PurpleBoard mark: the app icon (Lucide square-activity, src/ui/brand-icon.ts) inline, so
// the header, the homepage and the favicon share one drawing.

import { tk } from '../i18n';
import { iconSvg } from './brand-icon';

/** The app icon (dark tile: the app and homepage are dark) at `size` px. `colors` is kept for older callers. */
export function markSvg(size = 20, _colors: { board?: string; signal?: string; fill?: string } = {}): string {
  return iconSvg({ mode: 'dark', size }).replace('<svg ', '<svg class="brand-svg" ');
}

export const BRAND = {
  name: 'PurpleBoard',
  /** Wordmark text: uppercase, Martian Mono Bold condensed (SHKLR brand kit). */
  wordmark: 'PURPLEBOARD',
  tagline: 'Bring dead boards back.',
  upstream: 'https://github.com/tholtman1-del/deadboard',
  descriptor: tk('Board-level repair trainer'),
  site: 'https://sergioshklr.github.io/purpleboard/',
} as const;
