// The hidden difficulty system (src/scenarios/adaptive.ts) and the Today picks it drives.
import { attemptScore, expected, loadSkill, NEW_PLAYER, puzzleLevel, saveSkill, setFittedLevels, targetLevel, TARGET, update, type Skill } from '../src/scenarios/adaptive';
import { BOARD_INFO, LESSON_SKIP_LEVEL, PATH_ORDER, todayPicks } from '../src/scenarios/catalog';
import { TUTORIAL_SCENARIO_IDS } from '../src/ui/tutorial';

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

// help costs less than failing; a glance says nothing
const clean = attemptScore({ fixed: true, notes: 0, solution: false, engaged: true })!;
const noted = attemptScore({ fixed: true, notes: 2, solution: false, engaged: true })!;
const video = attemptScore({ fixed: true, notes: 0, solution: true, engaged: true })!;
const failed = attemptScore({ fixed: false, notes: 0, solution: false, engaged: true })!;
assert(clean === 1 && clean > noted && noted > video && video > failed && failed === 0, `scores: ${clean} ${noted} ${video} ${failed}`);
assert(attemptScore({ fixed: false, notes: 3, solution: true, engaged: false }) === null, 'opened and left: nothing learned');

// a strong first solve jumps; a struggle moves down; certainty grows
const s0: Skill = { ...NEW_PLAYER };
const jump = update(s0, 3.2, 1);
assert(jump.r > s0.r + 1.2 && jump.u < s0.u && jump.n === 1, `strong first solve jumps: ${JSON.stringify(jump)}`);
const down = update(s0, 0.8, 0);
assert(down.r < s0.r && down.r >= 0, `a failed easy board lowers the estimate: ${JSON.stringify(down)}`);
const helped = update(s0, 2, noted), failedAt = update(s0, 2, failed);
assert(helped.r > failedAt.r, 'a fix with notes never costs more than failing');
let veteran: Skill = { r: 4, u: 0.4, n: 40 };
const before = veteran.r;
veteran = update(veteran, 4, 1);
assert(veteran.r - before < 0.5, `an established estimate moves little: ${veteran.r - before}`);
assert(update(s0, 1, 1, 0.5).r - s0.r < update(s0, 1, 1).r - s0.r, 'lessons count half');
assert(Math.abs(expected({ r: 3, u: 1, n: 5 }, targetLevel({ r: 3, u: 1, n: 5 })) - TARGET) < 1e-9, 'target level = 70 % success');

// stored on the device; damaged data starts over
const mem = new Map<string, string>();
const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
saveSkill(jump, store);
assert(JSON.stringify(loadSkill(store)) === JSON.stringify(jump), 'round trip');
mem.set('pcbfix_skill', '{"r":"x"}');
assert(loadSkill(store).n === 0, 'damaged → new player');

// fitted levels override the shown ones; bad data is ignored
assert(puzzleLevel('builtin-smoke-test', 3.2) === 3.2, 'no fit: shown level');
setFittedLevels({ levels: { 'builtin-smoke-test': 4.4, 'evil<script>': 1, 'builtin-ghost-short': 99 } });
assert(puzzleLevel('builtin-smoke-test', 3.2) === 4.4 && puzzleLevel('builtin-ghost-short', 3.6) === 3.6, 'fitted level used; out-of-range ignored');
setFittedLevels(null);

// Today picks
const all = new Set(PATH_ORDER);
const lessons = TUTORIAL_SCENARIO_IDS as readonly string[];
assert(todayPicks(all, new Set(), undefined, { ...NEW_PLAYER })[0].id === PATH_ORDER[0], 'a new player starts on the path');
const fewSolved = new Set([PATH_ORDER[0]]);
const weak: Skill = { r: 1.2, u: 1.5, n: 1 };
assert(lessons.includes(todayPicks(all, fewSolved, undefined, weak)[0].id), 'below the lesson level: lessons are not skipped');
const strong: Skill = { r: 4.2, u: 1.2, n: 2 };
const pick = todayPicks(all, fewSolved, undefined, strong)[0];
const target = targetLevel(strong);
const closest = PATH_ORDER.filter((id) => !fewSolved.has(id)).reduce((b, id) => (Math.abs(BOARD_INFO[id].level - target) < Math.abs(BOARD_INFO[b].level - target) ? id : b));
assert(strong.r >= LESSON_SKIP_LEVEL && pick.id === closest && pick.reason === 'next', `a strong player goes to the board near their level: ${pick.id} (target ${target.toFixed(1)})`);
const picks = todayPicks(all, fewSolved, undefined, strong);
assert(new Set(picks.map((p) => p.id)).size === picks.length && picks.length === 3, 'three different picks');
setFittedLevels({ levels: { [closest]: 9.5 } });
assert(todayPicks(all, fewSolved, undefined, strong)[0].id !== closest, 'a board players found much harder is no longer picked at that level');
setFittedLevels(null);
assert(todayPicks(all, fewSolved, PATH_ORDER[5], strong)[0].id === PATH_ORDER[5], 'the open unsolved board still comes first');

console.log('adaptive: ok (scores, updates, storage, fitted levels, picks)');
