// Safety violations (PurpleBoard): debounce once per contact, points and score, tool rules,
// overheat events, buzzer setting, and the bench wiring (one check shared by mouse, touch and pad).
import { BRIEF_EMOJI, BRIEF_LIMITS, BRIEF_TIER_LABELS, POWER_OFF_METER_MODES, liveMeterViolation, SAFETY_DEBOUNCE_S, SAFETY_LABELS, SAFETY_ORDER, SAFETY_POINTS, SafetyLog, isOverheatEvent, liveToolViolation, loadBuzzerOn, safetyBriefFor, saveBuzzerOn } from '../src/safety';
import { builtinScenarios } from '../src/scenarios/builtin';
import type { Board } from '../src/types';

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

// ---- meter: Ω / diode / capacitance on a powered board ----
{
  const placed = { mode: 'OHM', powered: true, meterActive: true, onCopper: true, visible: true };
  for (const mode of ['OHM', 'DIODE', 'CAP']) {
    assert(liveMeterViolation({ ...placed, mode }) === 'live-meter', `${mode}: meter active, probe placed on copper, powered → violation`);
    assert(liveMeterViolation({ ...placed, mode, powered: false }) === null, `${mode} unpowered is fine`);
    assert(liveMeterViolation({ ...placed, mode, onCopper: false }) === null, `${mode}: a floating / off-copper probe touches nothing`);
    assert(liveMeterViolation({ ...placed, mode, meterActive: false }) === null, `${mode}: leftover probes with another tool active never count`);
    assert(liveMeterViolation({ ...placed, mode, visible: false }) === null, `${mode}: a probe on the hidden side never counts`);
  }
  for (const mode of ['V', 'AMP']) assert(liveMeterViolation({ ...placed, mode }) === null, `${mode} is a live-board mode`);
  assert(POWER_OFF_METER_MODES.join() === 'OHM,DIODE,CAP', 'power-off meter modes');
  assert(SAFETY_POINTS['live-meter'] === 10, 'meter violation costs 10');
  const log = new SafetyLog();
  assert(log.record('live-meter', 'meter', 50) !== null, 'first live Ω probe counts');
  assert(log.record('live-meter', 'meter', 50.4) === null, 'second probe within the debounce: same contact');
  assert(log.record('live-meter', 'meter', 50.4 + SAFETY_DEBOUNCE_S + 0.1) !== null, 'a later probe counts again');
  assert(log.score === 100 - 2 * SAFETY_POINTS['live-meter'], 'score 80 after two');
}

// ---- safety brief: derived from the board, tiered ----
{
  interface Fs { readFileSync(p: string, enc: 'utf8'): string }
  const fsName = 'node:fs';
  const { readFileSync } = (await import(/* @vite-ignore */ fsName)) as Fs;
  const all = await builtinScenarios();
  const board = (id: string) => { const s = all.find((x) => x.id === id); assert(s, `${id} missing`); return s.board; };
  const demo = (file: string) => (JSON.parse(readFileSync(new URL(`../public/demos/${file}`, import.meta.url).pathname, 'utf8')) as { board: Board }).board;
  const ids = (b: Board) => safetyBriefFor(b).items.map((i) => i.id);

  // low hazard: a 3 V coin cell, four parts
  const fl = safetyBriefFor(board('builtin-first-light'));
  assert(fl.tier === 'short' && fl.items.length === 2, `First Light: short brief of 2 (got ${fl.items.length})`);
  assert(ids(board('builtin-first-light')).join() === 'power-off,heat', 'First Light: power off + heat only');
  assert(fl.items[0].text.includes(`−${SAFETY_POINTS['live-iron']}`) && fl.items[0].text.includes(`−${SAFETY_POINTS['live-ipa']}`), 'penalties come from SAFETY_POINTS');
  // a 5 V board with a fuse: the short item names the fuse
  const gs = safetyBriefFor(board('builtin-ghost-short'));
  assert(gs.tier === 'standard' && gs.items.some((i) => i.id === 'short' && /F\d/.test(i.text)), 'Ghost Short: standard, short risk names the fuse');
  // high hazard: two supplies, big caps, ceramics, tiny parts, residue, ICs
  const idsReform = ids(demo('demo-mnt-reform2-mb30.pcbfix.json'));
  const reform = safetyBriefFor(demo('demo-mnt-reform2-mb30.pcbfix.json'));
  assert(reform.tier === 'full' && reform.items.length > gs.items.length && gs.items.length > fl.items.length, 'more hazards → more items');
  for (const k of ['power-off', 'supplies', 'short', 'charge', 'heat', 'mlcc', 'hot-air', 'ipa', 'esd']) assert(idsReform.includes(k as never), `MNT Reform: ${k}`);
  assert(reform.items.find((i) => i.id === 'esd')!.scored === false, 'ESD is advice only (the sim has no ESD)');
  // nothing invented: no residue → no IPA item, no ICs → no ESD item, nothing above 60 V → no high-voltage item
  for (const b of all.map((s) => s.board)) {
    const i = ids(b);
    assert(i.includes('ipa') === b.components.some((c) => c.state.residue), 'IPA item only with residue');
    assert(i.includes('esd') === b.components.some((c) => c.kind === 'ic' && c.state.populated !== false), 'ESD item only with ICs');
    assert(!i.includes('high-voltage'), 'no built-in board is high voltage');
  }
  // rules on a modified board: high voltage, and an unpowered board has no power-off item
  const hv: Board = structuredClone(board('builtin-first-light'));
  hv.components.find((c) => c.kind === 'battery')!.value = BRIEF_LIMITS.highVolts + 60;
  assert(ids(hv).includes('high-voltage') && ids(hv).includes('short'), 'above 60 V: high voltage + short');
  const dead: Board = structuredClone(board('builtin-first-light'));
  dead.components = dead.components.filter((c) => c.kind !== 'battery');
  assert(!ids(dead).includes('power-off') && ids(dead).includes('heat'), 'no supply: no power-off item, heat still applies');
  for (const tier of ['short', 'standard', 'full'] as const) assert(BRIEF_TIER_LABELS[tier], `${tier} label`);
  // the power-off item names the meter checks with the meter penalty; every item has its emoji
  for (const b of [...all.map((s) => s.board), demo('demo-mnt-reform2-mb30.pcbfix.json')]) {
    const br = safetyBriefFor(b);
    const po = br.items.find((i) => i.id === 'power-off');
    assert(po && po.text.includes('Ω / diode / C') && po.text.includes(`−${SAFETY_POINTS['live-meter']}`), 'powered boards: power off for Ω / diode / C, with its points');
    for (const i of br.items) assert(i.emoji && i.emoji === BRIEF_EMOJI[i.id] && !i.text.includes(i.emoji), `${i.id}: emoji set, kept out of the translated text`);
  }
  assert(!safetyBriefFor(dead).items.some((i) => i.text.includes('Ω / diode / C')), 'unpowered board: no meter line');
  for (const [id, e] of Object.entries(BRIEF_EMOJI)) assert(e.length > 0, `${id} emoji`);
}

// ---- brief wiring: every board load asks for it; it blocks keys and the pad until acknowledged ----
{
  interface Fs { readFileSync(p: string, enc: 'utf8'): string }
  const fsName = 'node:fs';
  const { readFileSync } = (await import(/* @vite-ignore */ fsName)) as Fs;
  const src = readFileSync(new URL('../src/ui/app.ts', import.meta.url).pathname, 'utf8');
  const body = (name: string) => { const i = src.indexOf(`private ${name}(`); assert(i >= 0, `${name} not found`); return src.slice(i, src.indexOf('\n  }\n', i)); };
  assert(body('loadScenario').includes('this.briefPending = true'), 'every board load asks for the brief');
  assert(body('onKeyDown').startsWith('private onKeyDown(e: KeyboardEvent) {\n    if (this.briefEl) {'), 'keys stay in the brief');
  assert(src.includes('|| !!this.briefEl; }'), 'the pad treats the brief as a modal (A presses its button)');
  assert(body('openBrief').includes('safetyBriefFor(this.board)'), 'the brief comes from the board');
  assert(body('openBrief').includes('<span class="sb-ico" aria-hidden="true">${i.emoji}</span>'), 'emoji is decorative (aria-hidden)');
  assert(body('placeProbe').includes('this.safetyCheckMeter(pin)'), 'every probe placement (mouse, touch, pad) runs the meter check on the probe just placed');
  assert((src.match(/this\.safetyCheckMeter\(/g) ?? []).length === 1, 'the meter check runs only from placeProbe (no mode-switch or power-on hook)');
  assert(!body('togglePower').includes('safetyCheckMeter'), 'turning power on never counts by itself');
  const meterCheck = body('safetyCheckMeter');
  for (const k of ["meterActive: this.activeTool === 'dmm'", 'onCopper: pin.net >= 0', 'visible: this.camera.bothSides || pin.side === this.camera.side']) assert(meterCheck.includes(k), `meter check reads ${k}`);
}

console.log('safety: ok (once per contact, points + score, live-board tools, overheat, buzzer setting, bench wiring, tiered safety brief, live meter, brief emojis)');
