// Translating the static homepage (index.html) with the app's catalogs (src/i18n).
//
// An element marked `data-t` is translated whole: its inner HTML, whitespace collapsed, is the
// English key, so links and markup inside stay part of the sentence. `data-t-attr="alt"` (or a
// comma list) translates those attributes, keyed by their English value. test/i18n.test.ts reads
// the same marks from index.html via homeKeys(), so the Russian catalog has to cover them.
import { t } from '../i18n';

export const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** English originals, so the page can switch back without a reload. */
const original = new WeakMap<Element, { html?: string; attrs: Record<string, string> }>();

/** Puts every marked text in the current language (English restores the originals). */
export function translatePage(root: ParentNode = document) {
  for (const el of root.querySelectorAll<HTMLElement>('[data-t]')) {
    const o = original.get(el) ?? { html: el.innerHTML, attrs: {} };
    original.set(el, o);
    const key = norm(o.html!);
    const tr = t(key);
    el.innerHTML = tr === key ? o.html! : tr;
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-t-attr]')) {
    const o = original.get(el) ?? { attrs: {} };
    original.set(el, o);
    for (const a of el.dataset.tAttr!.split(',').map((x) => x.trim())) {
      const v = (o.attrs[a] ??= el.getAttribute(a) ?? '');
      if (v) el.setAttribute(a, t(norm(v)));
    }
  }
}

/** The English keys index.html marks for translation (read from the source, for the tests). */
export function homeKeys(html: string): string[] {
  const keys: string[] = [];
  for (const m of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\sdata-t(?=[\s>])[^>]*)>([\s\S]*?)<\/\1>/g)) keys.push(norm(m[3]));
  for (const m of html.matchAll(/<[a-z][a-z0-9]*\b([^>]*\sdata-t-attr="([^"]+)"[^>]*)>/g)) {
    for (const a of m[2].split(',').map((x) => x.trim())) {
      const v = new RegExp(`\\s${a}="([^"]*)"`).exec(m[1])?.[1];
      if (v) keys.push(norm(v));
    }
  }
  return keys;
}
