// DEADBOARD homepage: fonts, brand mark, icons, the power-up log, legacy share links.
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './home.css';
import { markSvg } from '../ui/logo';
import { icon } from '../ui/icons';
import { initAnalytics, onFirstHide, scrollBucket, secondsBucket, trackEvent, visibleClock } from '../analytics';
import { initI18n, lang, saveLanguage, t } from '../i18n';
import { translatePage } from './translate';

initAnalytics();

// "home left": when the page is first hidden, how long it was looked at, how far it was scrolled,
// where the visitor went (the bench, another page here, a link out, or away) and what the hero
// board did. Answers whether visitors who never open the bench leave at once or after reading.
const visibleFor = visibleClock();
let deepest = 0;
addEventListener('scroll', () => {
  const max = document.documentElement.scrollHeight - innerHeight;
  if (max > 0) deepest = Math.max(deepest, scrollY / max);
}, { passive: true });
let leftTo = 'away';
document.addEventListener('click', (e) => {
  const a = (e.target as Element | null)?.closest?.('a');
  const href = a?.getAttribute('href');
  if (!a || !href || href.startsWith('#')) return;
  leftTo = /app\.html/.test(href) ? 'bench' : a.host && a.host !== location.host ? 'link out' : 'page';
}, true);
let hero = 'picture';
onFirstHide(() => trackEvent('home left', { visible: secondsBucket(visibleFor()), scrolled: scrollBucket(deepest), to: leftTo, hero }));

// Share links made before the homepage existed pointed at "/#s=…": hand them to the app.
if (location.hash.startsWith('#s=')) location.replace(`./app.html${location.hash}`);

for (const el of document.querySelectorAll<HTMLElement>('[data-mark]')) el.innerHTML = markSvg(el.closest('.small') ? 18 : 24);
for (const el of document.querySelectorAll<HTMLElement>('[data-icon]')) el.innerHTML = icon(el.dataset.icon!, 18);
// Language: the app's choice (?lang=, saved, browser), switchable in place from the header.
const TITLE = document.title;
const hasTranslatable = document.querySelector('[data-t], [data-t-attr]') !== null;
const staticRu = !hasTranslatable && document.documentElement.lang === 'ru';
async function setLanguage(code?: string) {
  await initI18n(staticRu ? 'ru' : code);
  if (hasTranslatable) {
    translatePage();
    document.title = lang() === 'en' ? TITLE : t('DEADBOARD — bring dead boards back');
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-lang]')) b.setAttribute('aria-pressed', String(b.dataset.lang === (staticRu ? 'ru' : lang())));
  document.documentElement.classList.remove('i18n-wait');
  relabelBoard?.();
}
let relabelBoard: (() => void) | undefined;
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-lang]')) {
  b.addEventListener('click', () => {
    if (staticRu) {
      if (b.dataset.lang === 'en') { saveLanguage('en'); location.href = './'; }
      return;
    }
    if (b.dataset.lang === lang()) return;
    saveLanguage(b.dataset.lang!); // the app opens in the same language
    void setLanguage(b.dataset.lang);
  });
}
void setLanguage().catch(() => document.documentElement.classList.remove('i18n-wait'));

for (const el of document.querySelectorAll<HTMLElement>('[data-year]')) el.textContent = String(new Date().getFullYear());

// Power-up log: lines appear like a terminal as the block scrolls into view (static when reduced motion is on).
const log = document.querySelector<HTMLElement>('[data-bootlog] code');
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if (log && !reduce && 'IntersectionObserver' in window) {
  const lines = log.textContent!.split('\n');
  log.textContent = '';
  const io = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    io.disconnect();
    let i = 0;
    const next = () => {
      if (i >= lines.length) { log.classList.add('done'); return; }
      const line = document.createElement('span');
      line.className = i === lines.length - 1 ? 'ok' : i === 0 ? 'cmd' : '';
      line.textContent = lines[i] + '\n';
      log.appendChild(line);
      i++;
      setTimeout(next, i === 1 ? 500 : 380);
    };
    next();
  }, { threshold: 0.4 });
  io.observe(log);
}

// The hero board in live 3D, loaded once it is on screen (not on Save-Data connections). The
// screenshot stays when the board cannot load or the browser cannot draw it.
const shot = document.querySelector<HTMLElement>('.hero-shot');
const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
// Phones load it only on a tap: building the 530-part board froze a mid-range phone for ~3.5 s
// (4× CPU throttling: one 2.9 s task) right while the visitor reads the hero, and it costs 0.7 MB.
const phone = matchMedia('(pointer: coarse)').matches && matchMedia('(max-width: 820px), (max-height: 600px)').matches;
async function loadBoard3d(s: HTMLElement) {
  try {
    const { mountBoard3d } = await import('./board3d');
    relabelBoard = await mountBoard3d(s.querySelector('.frame')!, s.querySelector('img')!, s.querySelector('.frame-hint'), s.querySelector('figcaption'));
    if (hero === 'picture') hero = 'live';
  } catch (e) {
    console.warn('3D board unavailable, keeping the screenshot:', e);
  }
}
if (shot && !saveData && 'IntersectionObserver' in window && phone) {
  const frame = shot.querySelector<HTMLElement>('.frame')!;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tap-3d';
  frame.appendChild(btn);
  const hint = shot.querySelector<HTMLElement>('.frame-hint');
  const label = () => { btn.textContent = t('Tap to turn it in 3D'); if (hint) hint.textContent = ''; };
  label();
  relabelBoard = label;
  btn.addEventListener('click', () => {
    hero = 'tapped';
    btn.disabled = true;
    btn.textContent = t('Loading…');
    void loadBoard3d(shot).finally(() => btn.remove());
  }, { once: true });
} else if (shot && !saveData && 'IntersectionObserver' in window) {
  const io = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    io.disconnect();
    void loadBoard3d(shot);
  }, { rootMargin: '200px' });
  io.observe(shot);
}
