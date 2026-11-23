// deadboard.org/stats.html: the public puzzle-statistics summary (src/attempts/summary.ts), built by
// the collector every 6 hours and read here from stats.deadboard.org. Only totals; groups under
// 10 attempts arrive as null and are shown as "–".
import type { PublicPuzzle, PublicSummary } from '../attempts/summary';

const ATTEMPTS_URL = ((import.meta.env?.VITE_ATTEMPTS_URL as string | undefined) ?? '').trim();
const SUMMARY_URL = new URL('/v1/summary', ATTEMPTS_URL || 'https://stats.deadboard.org').toString();
const root = document.getElementById('stats-root')!;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const pct = (a: number | null, b: number | null) => (a === null || !b ? null : Math.round((100 * a) / b));
const dash = '<span class="muted" title="Fewer than 10 attempts">–</span>';
const words = (id: string) => id.split('-').map((w) => (w.length > 2 || /^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w.toUpperCase())).join(' ');

/** Readable names: shipped boards from their id, real boards from the demos list. */
function namer(demos: Map<string, string>) {
  return (p: PublicPuzzle): string => {
    const one = (id: string) => demos.get(id) ?? (id.startsWith('builtin-tut-') ? `Lesson: ${words(id.slice(12))}` : words(id.replace(/^builtin-|^demo-/, '')));
    if (p.puzzle === 'daily') return `Daily repair · ${one(p.from)}`;
    if (p.puzzle === 'generated') return `New problem · ${one(p.from)}`;
    return one(p.puzzle);
  };
}

/** A horizontal bar for a share 0–100 with its number beside it (a single series: no legend). */
const bar = (v: number | null, label: string) => (v === null ? dash : `<span class="st-cell" title="${esc(label)}: ${v}%"><span class="st-bar"><span style="width:${v}%"></span></span><span class="st-num">${v}%</span></span>`);

function perDay(s: PublicSummary): string {
  const days = s.perDay.filter((d) => d.attempts !== null);
  if (days.length < 2) return '';
  const max = Math.max(...days.map((d) => d.attempts!));
  const cols = s.perDay.map((d) => {
    const h = d.attempts === null ? 0 : Math.max(2, Math.round((100 * d.attempts) / max));
    const tip = d.attempts === null ? `${d.day}: fewer than 10 attempts` : `${d.day}: ${d.attempts} attempts, ${d.fixed} fixed`;
    return `<span class="st-col" title="${esc(tip)}" aria-label="${esc(tip)}"><span style="height:${h}%"></span></span>`;
  }).join('');
  return `<h2>Attempts per day</h2><div class="st-days" role="img" aria-label="Attempts per day, last ${s.days} days">${cols}</div>
    <p class="st-axis"><span>${esc(s.perDay[0].day)}</span><span>max ${max}</span><span>${esc(s.perDay[s.perDay.length - 1].day)}</span></p>`;
}

function firstVisit(s: PublicSummary): string {
  if (!s.firstVisit.length) return '';
  const rows = s.firstVisit.map((f) => `<tr><th scope="row">${f.layout === 'phone' ? 'Phone' : 'Computer'}</th><td class="st-n st-opt">${f.attempts}</td>
    <td>${bar(pct(f.tool, f.attempts), 'Used a tool')}</td><td>${bar(pct(f.tested, f.attempts), 'Ran the tests')}</td><td>${bar(pct(f.fixed, f.attempts), 'Fixed the board')}</td></tr>`).join('');
  return `<h2>First visit</h2><p>A player's first board on their first day: how far it gets.</p>
    <div class="st-scroll"><table class="st-table st-first"><thead><tr><th>Layout</th><th class="st-n st-opt">Attempts</th><th>Used a tool</th><th>Ran tests</th><th>Fixed it</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function puzzles(s: PublicSummary, name: (p: PublicPuzzle) => string): string {
  const fittedAny = s.puzzles.some((p) => p.fitted !== null);
  const rows = s.puzzles.map((p) => {
    const open = p.puzzle === 'daily' || p.puzzle === 'generated' ? p.from : p.puzzle;
    const fitted = p.fitted === null ? dash : `<span title="±${p.fittedPm} (95 %)">${p.fitted.toFixed(1)}</span>`;
    return `<tr><th scope="row"><a href="./app.html?board=${encodeURIComponent(open)}">${esc(name(p))}</a></th>
      <td class="st-n">${p.level.toFixed(1)}</td>${fittedAny ? `<td class="st-n">${fitted}</td>` : ''}
      <td class="st-n st-opt">${p.attempts ?? dash}</td>
      <td>${bar(pct(p.fixed, p.attempts), 'Fixed')}</td>
      <td class="st-opt">${bar(pct(p.phoneFixed, p.phoneAttempts), 'Fixed on phones')}</td>
      <td class="st-opt">${bar(pct(p.notes, p.attempts), 'Revealed a note')}</td>
      <td class="st-opt st-n">${p.typicalTime ?? dash}</td></tr>`;
  }).join('');
  return `<h2>Puzzles</h2>
    <p>Level is the number the puzzle shows (0–10).${fittedAny ? ' <strong>Real</strong> is how hard players actually found it, on the same scale, once a puzzle has 20 or more real attempts.' : ' Once puzzles have enough real attempts, a <strong>Real</strong> column shows how hard players actually found them.'}
    Tap a puzzle to play it.</p>
    <div class="st-scroll"><table class="st-table"><thead><tr><th>Puzzle</th><th class="st-n">Level</th>${fittedAny ? '<th class="st-n">Real</th>' : ''}<th class="st-n st-opt">Attempts</th><th>Fixed</th><th class="st-opt">On phones</th><th class="st-opt">Used a note</th><th class="st-opt st-n">Typical time</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function render(s: PublicSummary, demos: Map<string, string>) {
  const made = new Date(s.made);
  const rate = pct(s.fixed, s.attempts);
  const shown = s.puzzles.filter((p) => p.attempts !== null).length;
  root.innerHTML = `
    <div class="st-tiles">
      <div class="st-tile"><span class="st-big">${s.attempts.toLocaleString('en')}</span><span class="muted">attempts</span></div>
      <div class="st-tile"><span class="st-big">${rate === null ? '–' : `${rate}%`}</span><span class="muted">fixed</span></div>
      <div class="st-tile"><span class="st-big">${shown}</span><span class="muted">puzzles with 10+ attempts</span></div>
    </div>
    <p class="muted st-made">Updated ${esc(made.toISOString().slice(0, 16).replace('T', ' '))} UTC · since ${esc(s.perDay[0]?.day ?? s.since)}</p>
    ${shown ? '' : '<p>Still collecting: numbers appear as soon as a puzzle has 10 attempts.</p>'}
    ${perDay(s)}
    ${puzzles(s, namer(demos))}
    ${firstVisit(s)}`;
}

async function main() {
  try {
    const [s, demos] = await Promise.all([
      fetch(SUMMARY_URL).then((r) => (r.ok ? (r.json() as Promise<PublicSummary>) : Promise.reject(new Error(String(r.status))))),
      fetch('./demos/index.json').then((r) => (r.ok ? r.json() : [])).catch(() => []) as Promise<{ id: string; title: string }[]>,
    ]);
    if (s.v !== 1) throw new Error('format');
    render(s, new Map(demos.map((d) => [d.id, d.title.split(' · ')[0]])));
  } catch {
    root.innerHTML = '<p class="muted">The stats could not be loaded right now (a content blocker can stop them, too). Try again later.</p>';
  }
}
void main();
