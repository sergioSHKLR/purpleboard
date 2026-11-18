// Translations. The English text is the key: `t('Power on')`, `t('Loaded {title}', { title })`.
// A language is one file in this folder (see docs/TRANSLATING.md) mapping English to its text;
// anything it lacks falls back to English, so a partial translation is still usable.
//
// Plurals: the English key lists its forms with `|` (one|other) and the count is the `n` param,
// e.g. `t('{n} part|{n} parts', { n })`; a translation gives one form per plural category of its
// language (Intl.PluralRules):
// `{ one: '{n} деталь', few: '{n} детали', many: '{n} деталей', other: '{n} детали' }`.
//
// Strings defined before the language is loaded (module-level tables) are marked with `tk()`,
// which only tags them for the extractor, and translated where they are shown with `t()`.

export type Plural = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };
export type Entry = string | Plural;
export type Catalog = Record<string, Entry>;
export type Params = Record<string, string | number>;

/** Languages the app offers, by native name. English is built in; the others load on demand. */
export const LANGUAGES: { code: string; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'ru', name: 'Русский' },
];
const LOADERS: Record<string, () => Promise<{ default: Catalog }>> = {
  ru: () => import('./ru'),
};

const STORE_KEY = 'deadboard_lang';
let current = 'en';
let table: Catalog = {};
let rules = new Intl.PluralRules('en');

/** The language: `?lang=` in the URL, else the one picked before, else the browser's, else English. */
export function detectLanguage(search = typeof location !== 'undefined' ? location.search : '', stored?: string | null, browser?: readonly string[]): string {
  const ok = (c: string | null | undefined) => (c && LANGUAGES.some((l) => l.code === c) ? c : undefined);
  const fromUrl = ok(new URLSearchParams(search).get('lang')?.toLowerCase());
  if (fromUrl) return fromUrl;
  if (stored === undefined) { try { stored = localStorage.getItem(STORE_KEY); } catch { stored = null; } }
  if (ok(stored)) return stored!;
  for (const b of browser ?? (typeof navigator !== 'undefined' ? navigator.languages ?? [navigator.language] : [])) {
    const c = ok(b?.toLowerCase().split('-')[0]);
    if (c) return c;
  }
  return 'en';
}

/** Loads the language's strings (before the UI is built). */
export async function initI18n(code = detectLanguage()): Promise<void> {
  let cat: Catalog = {};
  if (code !== 'en' && LOADERS[code]) {
    try { cat = (await LOADERS[code]()).default; } catch { code = 'en'; }
  }
  useCatalog(code, cat);
}

/** Switches to a catalog directly (tests, and initI18n). */
export function useCatalog(code: string, cat: Catalog) {
  current = code;
  table = cat;
  rules = new Intl.PluralRules(code);
  if (typeof document !== 'undefined') document.documentElement.lang = code;
}

export const lang = () => current;

/** Remembers the choice; the caller reloads the page to apply it. */
export function saveLanguage(code: string) {
  try { localStorage.setItem(STORE_KEY, code); } catch { /* storage unavailable */ }
}

const fill = (s: string, p?: Params) => (p ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in p ? String(p[k]) : m)) : s);

/** Whether a key is a plural one|other pair (it counts `{n}`); other keys may contain a plain `|`. */
export const isPluralKey = (key: string) => key.includes('{n}') && key.split('|').length === 2;

/** The text in the current language. Plural keys pick their form by the `n` param. */
export function t(key: string, p?: Params): string {
  const e = table[key];
  const n = typeof p?.n === 'number' ? p.n : undefined;
  if (e === undefined) {
    if (!isPluralKey(key)) return fill(key, p);
    const [one, other] = key.split('|');
    return fill(n === 1 ? one : other, p);
  }
  if (typeof e === 'string') return fill(e, p);
  const cat = n === undefined ? 'other' : rules.select(n);
  return fill(e[cat] ?? e.other, p);
}

/** Marks a string for translation where it is defined; `t()` translates it where it is shown. */
export const tk = <S extends string>(s: S): S => s;
