// DEADBOARD homepage: fonts, brand mark, icons, the power-up log, legacy share links.
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './home.css';
import { markSvg } from '../ui/logo';
import { icon } from '../ui/icons';
import { initAnalytics } from '../analytics';

initAnalytics();

// Share links made before the homepage existed pointed at "/#s=…": hand them to the app.
if (location.hash.startsWith('#s=')) location.replace(`./app.html${location.hash}`);

for (const el of document.querySelectorAll<HTMLElement>('[data-mark]')) el.innerHTML = markSvg(el.closest('.small') ? 18 : 24);
for (const el of document.querySelectorAll<HTMLElement>('[data-icon]')) el.innerHTML = icon(el.dataset.icon!, 18);
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
