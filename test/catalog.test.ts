// Board picker data (src/scenarios/catalog.ts): every shipped board has a level estimate, a symptom
// line, a picture (npm run thumbs) and labelled skills; the path order rises in level; the level
// bands cut like CVSS; Today's picks follow the path and offer a skip-ahead choice.
import { builtinScenarios } from '../src/scenarios/builtin';
import { BOARD_INFO, LEVEL_BANDS, PATH_ORDER, boardLevel, learnedSkills, levelBand, newSkillsFor, skillLabel, splitTitle, todayPicks, type SkillKey } from '../src/scenarios/catalog';

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

interface Fs { readFileSync(p: string, enc: 'utf8'): string; existsSync(p: string): boolean; statSync(p: string): { size: number } }
const fsName = 'node:fs';
const { readFileSync, existsSync, statSync } = (await import(/* @vite-ignore */ fsName)) as Fs;
const root = new URL('..', import.meta.url).pathname;

const builtins = await builtinScenarios();
const demos = JSON.parse(readFileSync(`${root}public/demos/index.json`, 'utf8')) as { id: string; title: string; difficulty: number }[];
const shipped = [...builtins.map((s) => ({ id: s.id, title: s.meta.title })), ...demos.map((d) => ({ id: d.id, title: d.title }))];

// every shipped board is in the catalogue, with a picture and a symptom; nothing else is
for (const b of shipped) {
  const info = BOARD_INFO[b.id];
  assert(info, `${b.id}: no entry in BOARD_INFO (src/scenarios/catalog.ts)`);
  assert(info.level > 0 && info.level <= 10, `${b.id}: level ${info.level} outside 0.1–10`);
  const pic = `${root}public/thumbs/${b.id}.webp`;
  assert(existsSync(pic), `${b.id}: no picture, run npm run thumbs -- --only ${b.id}`);
  assert(statSync(pic).size < 60_000, `${b.id}: picture over 60 KB`);
  assert(info.symptom || splitTitle(b.title).symptom, `${b.id}: no symptom (title has no " · " and the catalogue has none)`);
  for (const k of info.teaches) assert(skillLabel(k) !== k.split(':')[1], `${b.id}: skill ${k} has no label`);
}
for (const id of Object.keys(BOARD_INFO)) assert(shipped.some((b) => b.id === id), `BOARD_INFO lists ${id}, which does not ship`);

// the recommended path rises in level, so Today and the Library agree on the order
for (let i = 1; i < PATH_ORDER.length; i++) {
  const a = BOARD_INFO[PATH_ORDER[i - 1]].level, b = BOARD_INFO[PATH_ORDER[i]].level;
  assert(b >= a, `path order: ${PATH_ORDER[i]} (${b}) is below ${PATH_ORDER[i - 1]} (${a})`);
}
assert(PATH_ORDER.every((id) => shipped.some((b) => b.id === id)), 'path lists a board that does not ship');

// bands: CVSS cut points
const bandOf = (v: number) => levelBand(v).id;
assert(bandOf(0.1) === 'low' && bandOf(3.9) === 'low' && bandOf(4.0) === 'medium' && bandOf(6.9) === 'medium', 'low/medium cut');
assert(bandOf(7.0) === 'high' && bandOf(8.9) === 'high' && bandOf(9.0) === 'critical' && bandOf(10) === 'critical', 'high/critical cut');
assert(LEVEL_BANDS.length === 4, 'four bands');

// boards without an entry (mods, imports) get an estimate from their 1–5 difficulty
assert(boardLevel({ id: 'mod-x', meta: { difficulty: 1 } as never }) < 4, 'difficulty 1 is Low');
assert(levelBand(boardLevel({ id: 'mod-x', meta: { difficulty: 5 } as never })).id === 'high', 'difficulty 5 is High');

// Today's picks
const all = new Set(shipped.map((b) => b.id));
const first = todayPicks(all, new Set());
assert(first[0].id === PATH_ORDER[0] && first[0].reason === 'first', 'first visit starts on the first tutorial');
assert(first.some((p) => p.reason === 'skip' && BOARD_INFO[p.id].level >= BOARD_INFO[first[0].id].level + 1.5), 'first visit offers a skip-ahead board');
const mid = todayPicks(all, new Set(PATH_ORDER.slice(0, 8)));
assert(mid[0].id === PATH_ORDER[8] && mid[0].reason === 'next', 'continues at the next unsolved board');
assert(new Set(mid.map((p) => p.id)).size === mid.length && mid.length === 3, 'three different picks');
const open = todayPicks(all, new Set(PATH_ORDER.slice(0, 8)), PATH_ORDER[10]);
assert(open[0].id === PATH_ORDER[10] && open[0].reason === 'open', 'the open unsolved board comes first');
assert(todayPicks(all, new Set(PATH_ORDER)).length === 0, 'nothing left: no picks');
assert(todayPicks(new Set(['builtin-first-light']), new Set()).length === 1, 'only boards that are available');

// skills: learned in solve order; challenge boards keep their fault kinds hidden
const learned = learnedSkills(['builtin-first-light', 'builtin-tut-cold-joint']);
assert(learned[0] === 'tool:dmm' && learned.includes('fault:cold'), 'learned skills in order');
const seen = new Set<SkillKey>(learned);
assert(newSkillsFor('builtin-smoke-test', seen).includes('tool:thermal'), 'smoke test brings the thermal camera');
assert(!newSkillsFor('builtin-smoke-test', seen).some((k) => k.startsWith('fault:')), 'challenge fault kinds stay hidden');
assert(newSkillsFor('builtin-tut-solder-bridge', seen).includes('fault:bridge'), 'tutorials show their fault kind');

console.log(`catalog: ${shipped.length} boards, path of ${PATH_ORDER.length}, all checks passed`);
