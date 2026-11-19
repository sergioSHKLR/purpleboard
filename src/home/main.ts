// DEADBOARD homepage: fonts, brand mark, icons, the power-up log, legacy share links.
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './home.css';
import { markSvg } from '../ui/logo';
import { icon } from '../ui/icons';
import { initAnalytics } from '../analytics';
import { initI18n, lang, saveLanguage, t } from '../i18n';
import { translatePage } from './translate';

initAnalytics();

// Share links made before the homepage existed pointed at "/#s=…": hand them to the app.
if (location.hash.startsWith('#s=')) location.replace(`./app.html${location.hash}`);

for (const el of document.querySelectorAll<HTMLElement>('[data-mark]')) el.innerHTML = markSvg(el.closest('.small') ? 18 : 24);
for (const el of document.querySelectorAll<HTMLElement>('[data-icon]')) el.innerHTML = icon(el.dataset.icon!, 18);
// Language: the app's choice (?lang=, saved, browser), switchable in place from the header.
const TITLE = document.title;
async function setLanguage(code?: string) {
  await initI18n(code);
  translatePage();
  document.title = lang() === 'en' ? TITLE : t('DEADBOARD — bring dead boards back');
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-lang]')) b.setAttribute('aria-pressed', String(b.dataset.lang === lang()));
  document.documentElement.classList.remove('i18n-wait');
  relabelBoard?.();
}
let relabelBoard: (() => void) | undefined;
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-lang]')) {
  b.addEventListener('click', () => {
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
if (shot && !saveData && 'IntersectionObserver' in window) {
  const io = new IntersectionObserver(async (entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    io.disconnect();
    try {
      const { mountBoard3d } = await import('./board3d');
      relabelBoard = await mountBoard3d(shot.querySelector('.frame')!, shot.querySelector('img')!, shot.querySelector('.frame-hint'), shot.querySelector('figcaption'));
    } catch (e) {
      console.warn('3D board unavailable, keeping the screenshot:', e);
    }
  }, { rootMargin: '200px' });
  io.observe(shot);
}
