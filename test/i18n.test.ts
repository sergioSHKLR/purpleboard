// Translations: every English string the app can show has an entry in each maintained language,
// no entry is left over from text that changed, placeholders / HTML tags / plural forms match,
// and t() falls back, fills and pluralises correctly.
//
// Strings come from the code (`t('…')`, `tk('…')`, `translate('…')` literals) and from data that is
// translated where it is shown: built-in and demo boards, tutorial steps, tool tables.
import { LANGUAGES, detectLanguage, isPluralKey, t, useCatalog, type Catalog, type Entry } from '../src/i18n';
import ru from '../src/i18n/ru';
import { builtinScenarios } from '../src/scenarios/builtin';
import { TUTORIALS_BY_SCENARIO, TUTORIAL_TOPICS } from '../src/ui/tutorial';
import { TOOL_SHORT, TOOL_TIP_PHONE } from '../src/ui/touch';
import { homeKeys } from '../src/home/translate';

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

/** Languages that must be complete (a new language can start partial and join this list). */
const MAINTAINED: Record<string, Catalog> = { ru };

// node:fs without Node's type definitions (the project has none), like the other tests
interface Fs { readFileSync(p: string, enc: 'utf8'): string; readdirSync(p: string): string[]; statSync(p: string): { isDirectory(): boolean } }
const fsName = 'node:fs';
const { readFileSync, readdirSync, statSync } = (await import(/* @vite-ignore */ fsName)) as Fs;
const join = (...p: string[]) => p.join('/').replace(/\/+/g, '/');
const root = new URL('..', import.meta.url).pathname;

// ---- keys from the code ----
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.ts$/.test(f) && !/\.d\.ts$/.test(f) ? [p] : [];
  });
}
const unquote = (lit: string) => {
  const q = lit[0], body = lit.slice(1, -1);
  if (q === '`') return body.replace(/\\`/g, '`').replace(/\\\\/g, '\\');
  return body.replace(/\\(['"\\])/g, '$1').replace(/\\n/g, '\n');
};
const CALL = /(?<![\w.])(?:t|tk|translate)\(\s*('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\$]|\\.)*`)/g;
const keys = new Map<string, string>(); // key → where it was found
for (const f of files(join(root, 'src'))) {
  if (f.includes('/src/i18n/')) continue;
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(CALL)) keys.set(unquote(m[1]), f.replace(root, ''));
}
assert(keys.size > 400, `found ${keys.size} t() strings in src/ (extraction broken?)`);

// ---- keys from data ----
const add = (s: string | undefined, where: string) => { if (s?.trim()) keys.set(s, where); };
for (const s of await builtinScenarios()) {
  add(s.meta.title, s.id); add(s.meta.author, s.id); add(s.meta.description, s.id);
  for (const h of s.meta.hints) add(h, s.id);
}
const demoDir = join(root, 'public', 'demos');
for (const d of JSON.parse(readFileSync(join(demoDir, 'index.json'), 'utf8')) as { id: string; file: string; title: string; description: string }[]) {
  add(d.title, d.id); add(d.description, d.id);
  const full = JSON.parse(readFileSync(join(demoDir, d.file), 'utf8'));
  add(full.meta.title, d.id); add(full.meta.description, d.id);
  for (const h of full.meta.hints) add(h, d.id);
}
for (const [id, steps] of Object.entries(TUTORIALS_BY_SCENARIO)) {
  for (const st of steps) {
    add(st.title, id); add(st.concept, id); add(st.task, id); add(st.phone, id);
    add(st.quickAction?.label, id); add(st.target?.label, id);
  }
}
for (const topics of Object.values(TUTORIAL_TOPICS)) for (const x of topics) add(x, 'tutorial topics');
for (const x of [...Object.values(TOOL_SHORT), ...Object.values(TOOL_TIP_PHONE)]) add(x, 'touch.ts');
for (const k of homeKeys(readFileSync(join(root, 'index.html'), 'utf8'))) add(k, 'index.html');

// ---- each maintained language ----
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const tags = (s: string) => [...s.matchAll(/<\/?([a-z]+)/g)].map((m) => m[0]).join(' ');
const forms = (e: Entry): string[] => (typeof e === 'string' ? [e] : Object.values(e));
for (const [code, cat] of Object.entries(MAINTAINED)) {
  const missing = [...keys.keys()].filter((k) => !(k in cat));
  const stale = Object.keys(cat).filter((k) => !keys.has(k));
  assert(!missing.length, `${code}: ${missing.length} untranslated string(s):\n${missing.slice(0, 30).map((k) => `  ${JSON.stringify(k)}  (${keys.get(k)})`).join('\n')}`);
  assert(!stale.length, `${code}: ${stale.length} entr(ies) for text the app no longer has:\n${stale.slice(0, 30).map((k) => `  ${JSON.stringify(k)}`).join('\n')}`);
  const rules = new Intl.PluralRules(code);
  for (const [k, e] of Object.entries(cat)) {
    const english = isPluralKey(k) ? k.split('|') : [k];
    const want = placeholders(english[english.length - 1]);
    for (const f of forms(e)) {
      assert(placeholders(f) === want, `${code}: placeholders differ in ${JSON.stringify(k)} → ${JSON.stringify(f)}`);
      assert(tags(f) === tags(english[english.length - 1]), `${code}: HTML tags differ in ${JSON.stringify(k)} → ${JSON.stringify(f)}`);
      assert(!f.includes('"') || k.includes('"'), `${code}: a double quote would break an HTML attribute in ${JSON.stringify(k)}: use «»`);
    }
    if (typeof e !== 'string') {
      assert(english.length === 2, `${code}: ${JSON.stringify(k)} has plural forms but the English key is no "{n} one|{n} other" pair`);
      for (const c of rules.resolvedOptions().pluralCategories) assert(c in e, `${code}: ${JSON.stringify(k)} lacks the "${c}" plural form`);
    } else {
      assert(english.length === 1, `${code}: ${JSON.stringify(k)} is a plural key: give the forms (${rules.resolvedOptions().pluralCategories.join(', ')})`);
    }
  }
}
assert(LANGUAGES[0].code === 'en' && LANGUAGES.every((l) => l.name), 'languages listed with their native names');
assert(t('Diode mode (•◄|)') === 'Diode mode (•◄|)', 'a plain | is not a plural');

// ---- t() itself ----
useCatalog('en', {});
assert(t('Power on') === 'Power on', 'English falls back to the key');
assert(t('Loaded {title}', { title: 'X' }) === 'Loaded X', 'placeholders are filled');
assert(t('{n} part|{n} parts', { n: 1 }) === '1 part' && t('{n} part|{n} parts', { n: 3 }) === '3 parts', 'English plural from the key');
useCatalog('ru', ru);
assert(t('Power on') === 'Питание вкл.', 'Russian entry used');
assert(t('No such string {x}', { x: 1 }) === 'No such string 1', 'a missing entry falls back to English');
const parts = (n: number) => t('{n} part|{n} parts', { n });
assert(parts(1) === '1 деталь' && parts(3) === '3 детали' && parts(5) === '5 деталей' && parts(21) === '21 деталь', `Russian plural forms: ${[1, 3, 5, 21].map(parts)}`);
useCatalog('en', {});

// ---- picking the language ----
assert(detectLanguage('?lang=ru', null, ['en-US']) === 'ru', '?lang= wins');
assert(detectLanguage('', 'ru', ['en-US']) === 'ru', 'saved choice next');
assert(detectLanguage('', null, ['ru-RU', 'en']) === 'ru', 'browser language');
assert(detectLanguage('', null, ['de-DE', 'fr']) === 'en', 'unknown languages fall back to English');
assert(detectLanguage('?lang=xx', 'zz', ['de']) === 'en', 'unknown codes ignored');

console.log(`I18N TESTS PASSED (${keys.size} strings; ${Object.keys(MAINTAINED).join(', ')} complete; placeholders, tags, plurals, fallback, language detection)`);
