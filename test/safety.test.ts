// Safety violations (PurpleBoard): debounce once per contact, points and score, tool rules,
// overheat events, buzzer setting, and the bench wiring (one check shared by mouse, touch and pad).
import { SAFETY_DEBOUNCE_S, SAFETY_LABELS, SAFETY_ORDER, SAFETY_POINTS, SafetyLog, isOverheatEvent, liveToolViolation, loadBuzzerOn, saveBuzzerOn } from '../src/safety';

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

// ---- log: once per contact, points, score ----
{
  const log = new SafetyLog();
  assert(log.score === 100 && log.penalty === 0 && log.breakdown().length === 0, 'clean board: 100');
  const a = log.record('live-iron', 'tool', 10);
  assert(a && a.points === SAFETY_POINTS['live-iron'], 'first live iron counts');
  assert(log.record('live-iron', 'tool', 10.5) === null, 'same contact (within the debounce) counts once');
  assert(log.record('live-iron', 'tool', 10.5 + SAFETY_DEBOUNCE_S * 0.9) === null, 'a held / repeated contact keeps the window open');
  assert(log.record('live-iron', 'tool', 20) !== null, 'a new contact after a pause counts again');
  assert(log.record('live-wick', 'tool', 20.1) !== null, 'another kind is its own contact');
  assert(log.record('overheat', 'pad-lifted:R1:0', 20.2) !== null && log.record('overheat', 'pad-lifted:R2:0', 20.2) !== null, 'different keys are different violations');
  const pen = 2 * SAFETY_POINTS['live-iron'] + SAFETY_POINTS['live-wick'] + 2 * SAFETY_POINTS.overheat;
  assert(log.penalty === pen && log.score === 100 - pen, `penalty ${log.penalty} = ${pen}`);
  const b = log.breakdown();
  assert(b.map((r) => r.kind).join() === 'live-iron,live-wick,overheat', 'breakdown in order, empty kinds left out');
  assert(b[0].count === 2 && b[0].points === 2 * SAFETY_POINTS['live-iron'], 'breakdown counts and points');
  for (let i = 0; i < 20; i++) log.record('live-short', `s${i}`, 30);
  assert((log.score as number) === 0, 'score never below 0');
  log.reset();
  assert(log.score === 100 && log.list.length === 0 && log.record('live-iron', 'tool', 30.1) !== null, 'reset (new board) forgets the debounce too');
}

// ---- rules ----
assert(liveToolViolation('iron') === 'live-iron' && liveToolViolation('wick') === 'live-wick' && liveToolViolation('ipa') === 'live-ipa', 'iron, wick, IPA are live-board violations');
for (const tool of ['dmm', 'scope', 'inspect', 'freeze', 'press', 'rosin', 'hotair', 'jumper']) assert(liveToolViolation(tool) === null, `${tool} is allowed on a live board`);
assert(isOverheatEvent('pad-lifted') && isOverheatEvent('part-overheated') && isOverheatEvent('mlcc-cracked'), 'thermal damage counts');
assert(!isOverheatEvent('reflowed') && !isOverheatEvent('molten') && !isOverheatEvent('dull-joint') && !isOverheatEvent('part-displaced'), 'other rework events do not');
for (const k of SAFETY_ORDER) assert(SAFETY_POINTS[k] > 0 && SAFETY_LABELS[k].length > 0, `${k}: points and label`);

// ---- buzzer setting ----
{
  const m = new Map<string, string>();
  const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
  assert(loadBuzzerOn(store) === true, 'buzzer on by default');
  saveBuzzerOn(store, false);
  assert(loadBuzzerOn(store) === false, 'buzzer off is saved');
  saveBuzzerOn(store, true);
  assert(loadBuzzerOn(store) === true, 'and back on');
  assert(loadBuzzerOn(null) === true, 'no storage: on');
}

// ---- bench wiring: one check for mouse / touch (applyToolAt) and the controller (RT heat, LT feed) ----
{
  interface Fs { readFileSync(p: string, enc: 'utf8'): string }
  const fsName = 'node:fs';
  const { readFileSync } = (await import(/* @vite-ignore */ fsName)) as Fs;
  const src = readFileSync(new URL('../src/ui/app.ts', import.meta.url).pathname, 'utf8');
  const body = (name: string) => { const i = src.indexOf(`private ${name}(`); assert(i >= 0, `${name} not found`); return src.slice(i, src.indexOf('\n  }\n', i)); };
  assert(body('applyToolAt').includes('this.safetyCheckTool()'), 'applyToolAt runs the safety check');
  assert(body('gpHeatFrame').includes('this.safetyCheckTool()'), 'controller iron (RT) runs the safety check');
  assert(body('gpFeed').includes('this.safetyCheckTool()'), 'controller feed (LT) runs the safety check');
  assert(body('safetyCheckTool').includes('if (!this.powerOn) return;'), 'only with the supply on');
  assert(body('applySim').includes("this.safetyViolation('live-short'"), 'live shorts are checked after a solve');
  assert(body('onReworkEvents').includes("this.safetyViolation('overheat'"), 'overheat damage is checked');
}

console.log('safety: ok (once per contact, points + score, live-board tools, overheat, buzzer setting, bench wiring)');
