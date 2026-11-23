// Gamepad mod: dead zones, triggers, the button mapping (edges, fine mode, View tap vs hold),
// calibration, haptics fallback and stored settings.
import {
  BTN, CONTROL_HINTS, DEFAULT_SETTINGS, GamepadMapper, VIEW_HOLD_S, deadzoneFromRest, hapticPulse,
  loadGamepadSettings, saveGamepadSettings, stick, trigger, type PadSnapshot,
} from '../src/ui/gamepad';

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const near = (a: number, b: number, e = 1e-6) => Math.abs(a - b) <= e;

function pad(o: { axes?: number[]; down?: number[]; values?: Record<number, number> } = {}): PadSnapshot {
  const buttons = Array.from({ length: 17 }, (_, i) => {
    const v = o.values?.[i] ?? (o.down?.includes(i) ? 1 : 0);
    return { pressed: v > 0.5 || !!o.down?.includes(i), value: v };
  });
  return { id: 'test pad', mapping: 'standard', axes: o.axes ?? [0, 0, 0, 0], buttons };
}

// ---- stick dead zone ----
{
  assert(stick(0.1, 0, 0.12)[0] === 0, 'inside the dead zone reads 0');
  assert(stick(0.08, 0.08, 0.12)[0] === 0, 'radial: a small diagonal is still inside');
  const [x, y] = stick(1, 0, 0.12);
  assert(near(x, 1) && y === 0, 'full tilt reads 1');
  const [a] = stick(0.56, 0, 0.12); // halfway between edge and full
  assert(near(a, 0.5, 1e-9), `rescaled from the edge, got ${a}`);
  const [c] = stick(0.56, 0, 0.12, 2);
  assert(near(c, 0.25, 1e-9), 'response curve applies after rescale');
  const [dx, dy] = stick(0.7, 0.7, 0.12);
  assert(near(dx, dy) && dx > 0.6, 'diagonals keep direction');
}

// ---- triggers ----
{
  assert(trigger({ pressed: false, value: 0.03 }, 0.05) === 0, 'trigger dead zone');
  assert(trigger({ pressed: true, value: 0.99 }, 0.05) === 1, 'full pull snaps to 1');
  assert(near(trigger({ pressed: true, value: 0.51 }, 0.05), (0.51 - 0.05) / 0.92), 'rescaled');
  assert(trigger({ pressed: true, value: 0 }, 0.05) === 1, 'digital-only trigger reads 1 when pressed');
  assert(trigger(undefined, 0.05) === 0, 'missing trigger reads 0');
}

// ---- mapping: buttons fire once per press ----
{
  const m = new GamepadMapper();
  let f = m.update(pad({ down: [BTN.A] }), 1 / 60);
  assert(f.actions.includes('act'), 'A = act');
  f = m.update(pad({ down: [BTN.A] }), 1 / 60);
  assert(!f.actions.includes('act'), 'held A does not repeat');
  m.update(pad(), 1 / 60);
  const names: [number, string][] = [[BTN.B, 'cancel'], [BTN.X, 'toolPrev'], [BTN.Y, 'toolNext'], [BTN.RB, 'flip'], [BTN.MENU, 'menu'], [BTN.UP, 'up'], [BTN.DOWN, 'down'], [BTN.LEFT, 'left'], [BTN.RIGHT, 'right']];
  for (const [b, name] of names) {
    f = m.update(pad({ down: [b] }), 1 / 60);
    assert(f.actions.includes(name as never), `button ${b} → ${name}, got ${f.actions}`);
    m.update(pad(), 1 / 60);
  }
  f = m.update(pad({ down: [BTN.UP] }), 1 / 60);
  assert(f.held.up && !f.held.down, 'D-pad held state for continuous zoom');
}

// ---- cursor: left stick, speed, fine mode (L3 toggle, LB hold) ----
{
  const m = new GamepadMapper();
  const dt = 0.1;
  let f = m.update(pad({ axes: [1, 0, 0, 0] }), dt);
  assert(near(f.cursor[0], DEFAULT_SETTINGS.cursorSpeed * dt) && f.cursor[1] === 0, `coarse speed, got ${f.cursor}`);
  assert(f.pan[0] === 0 && f.pan[1] === 0, 'left stick does not pan');
  f = m.update(pad({ axes: [1, 0, 0, 0], down: [BTN.LB] }), dt);
  assert(f.fine && near(f.cursor[0], DEFAULT_SETTINGS.cursorSpeed * DEFAULT_SETTINGS.fineFactor * dt), 'LB held = fine');
  m.update(pad(), dt);
  f = m.update(pad({ down: [BTN.L3] }), dt);
  assert(f.actions.includes('toggleFine') && f.fine, 'L3 latches fine');
  m.update(pad(), dt);
  f = m.update(pad({ axes: [0, 0, 0, 0], down: [BTN.LB] }), dt);
  assert(!f.fine, 'LB while latched gives coarse');
  m.update(pad(), dt);
  f = m.update(pad({ down: [BTN.L3] }), dt);
  assert(!f.fine, 'L3 again unlatches');
  f = m.update(pad({ axes: [0, 0, 1, -1] }), dt);
  assert(f.cursor[0] === 0 && f.pan[0] < 0 && f.pan[1] > 0, 'right stick pans (board follows the stick)');
  f = m.update(pad({ axes: [0.05, -0.05, 0, 0] }), dt);
  assert(!f.active, 'resting drift is not input');
}

// ---- triggers: heat start/end with hysteresis, feed edge ----
{
  const m = new GamepadMapper();
  let f = m.update(pad({ values: { [BTN.RT]: 0.6 } }), 1 / 60);
  assert(f.actions.includes('heatStart') && f.heat > 0.5, 'RT pulled = heat start');
  f = m.update(pad({ values: { [BTN.RT]: 0.15 } }), 1 / 60);
  assert(!f.actions.includes('heatEnd'), 'hysteresis: a slight release keeps contact');
  f = m.update(pad({ values: { [BTN.RT]: 0.02 } }), 1 / 60);
  assert(f.actions.includes('heatEnd') && f.heat === 0, 'released = heat end');
  f = m.update(pad({ values: { [BTN.LT]: 1 } }), 1 / 60);
  assert(f.actions.includes('feed') && f.feed === 1, 'LT = feed');
  f = m.update(pad({ values: { [BTN.LT]: 1 } }), 1 / 60);
  assert(!f.actions.includes('feed'), 'feed fires once per pull');
}

// ---- View: tap = help, hold = calibrate ----
{
  const m = new GamepadMapper();
  m.update(pad({ down: [BTN.VIEW] }), 0.1);
  let f = m.update(pad(), 0.1);
  assert(f.actions.includes('help') && !f.actions.includes('calibrate'), 'View tap = help');
  let got = false;
  for (let t = 0; t < VIEW_HOLD_S + 0.2; t += 0.1) { f = m.update(pad({ down: [BTN.VIEW] }), 0.1); got ||= f.actions.includes('calibrate'); }
  assert(got, 'View hold = calibrate');
  f = m.update(pad(), 0.1);
  assert(!f.actions.includes('help'), 'releasing after a hold does not also toggle help');
}

// ---- Guide button alone is not "active" (the OS owns it) ----
{
  const m = new GamepadMapper();
  const f = m.update(pad({ down: [BTN.GUIDE] }), 0.1);
  assert(!f.active && !f.actions.length, 'Guide is ignored');
}

// ---- calibration ----
{
  assert(deadzoneFromRest([[0, 0, 0, 0]]) === 0.05, 'clean sticks: minimum dead zone');
  const dz = deadzoneFromRest([[0.1, 0, 0, 0], [0, 0, 0.04, 0.12]]);
  assert(dz > 0.12 && dz < 0.25, `just above the worst rest deflection, got ${dz}`);
  assert(deadzoneFromRest([[0.9, 0, 0, 0]]) === 0.35, 'clamped');
}

// ---- haptics: pad rumble, else device vibration, else nothing ----
{
  let played = 0 as number; let vibrated = 0 as number;
  const act = { effects: ['dual-rumble'], playEffect: async () => { played++; } };
  const vib = () => { vibrated++; return true; };
  const r1 = hapticPulse(act, vib, 0.5, 0.2, 100);
  assert(r1 === 'pad' && played === 1 && vibrated === 0, 'actuator first');
  const r2 = hapticPulse(null, vib, 0.5, 0.2, 100);
  assert(r2 === 'device' && (vibrated as number) === 1, 'navigator.vibrate fallback');
  assert(hapticPulse({ effects: ['trigger-rumble'], playEffect: async () => { played++; } }, undefined, 1, 1, 50) === 'none', 'no dual-rumble effect, no vibrate');
  assert(hapticPulse(null, () => { throw new Error('blocked'); }, 1, 1, 50) === 'none', 'a blocked vibrate is ignored');
}

// ---- stored settings ----
{
  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
  saveGamepadSettings(store, { ...DEFAULT_SETTINGS, deadzone: 0.2, cursorSpeed: 800 });
  const s = loadGamepadSettings(store);
  assert(s.deadzone === 0.2 && s.cursorSpeed === 800, 'round trip');
  mem.set('deadboard_gamepad', '{"deadzone":5,"cursorSpeed":"x"}');
  assert(Object.keys(loadGamepadSettings(store)).length === 0, 'bad values ignored');
  mem.set('deadboard_gamepad', 'not json');
  assert(Object.keys(loadGamepadSettings(store)).length === 0, 'corrupt storage ignored');
}

// ---- every mapped control has a hint ----
{
  const text = CONTROL_HINTS.map((h) => h.join(' ')).join('\n');
  for (const k of ['Left stick', 'Right stick', 'RT', 'LT', 'A', 'B', 'X / Y', 'RB', 'D-pad', 'Menu', 'View', 'L3']) assert(text.includes(k), `hint for ${k}`);
}

console.log('gamepad: ok');

// ---- settings panel logic: remapping, conflicts, sticks, iron range, import / export ----
{
  const { DEFAULT_KEYMAP, KEYMAP_ROWS, keymapConflicts, heatScale, sanitizeSettings, applySettings, exportSettings, importSettings,
    defaultSettings, controlHints, RebindListener, NavRepeat, deadzonesFromRest } = await import('../src/ui/gamepad');

  // every keymap row has a default, and the defaults have no conflicts (View tap/hold may share)
  for (const [a] of KEYMAP_ROWS) assert(Number.isInteger(DEFAULT_KEYMAP[a]), `default for ${a}`);
  assert(keymapConflicts({ ...DEFAULT_KEYMAP }).length === 0, 'default map has no conflicts');
  const clash = keymapConflicts({ ...DEFAULT_KEYMAP, flip: BTN.A });
  assert(clash.length === 1 && clash[0].button === BTN.A && clash[0].actions.includes('act') && clash[0].actions.includes('flip'), 'conflict found');
  assert(keymapConflicts({ ...DEFAULT_KEYMAP, help: BTN.R3 }).length === 1, 'help moved onto settings button conflicts');

  // remapped buttons drive the mapper
  const s = defaultSettings();
  s.keymap.act = BTN.RB; s.keymap.flip = BTN.A;
  const m = new GamepadMapper(s);
  let f = m.update(pad({ down: [BTN.RB] }), 1 / 60);
  assert(f.actions.includes('act') && !f.actions.includes('flip'), 'RB now acts');
  m.update(pad(), 1 / 60);
  f = m.update(pad({ down: [BTN.A] }), 1 / 60);
  assert(f.actions.includes('flip') && !f.actions.includes('act'), 'A now flips');
  m.update(pad(), 1 / 60);
  // iron on a digital button
  m.settings.keymap.heat = BTN.X;
  f = m.update(pad({ down: [BTN.X] }), 1 / 60);
  assert(f.actions.includes('heatStart') && f.heat === 1, 'iron on a face button');
  m.update(pad(), 1 / 60);
  // settings button (R3 by default)
  const m2 = new GamepadMapper();
  assert(m2.update(pad({ down: [BTN.R3] }), 1 / 60).actions.includes('settings'), 'R3 opens settings');
  // help and calibrate on separate buttons
  const m3 = new GamepadMapper({ keymap: { ...DEFAULT_KEYMAP, calibrate: BTN.MENU, menu: BTN.R3, settings: BTN.L3, fineToggle: BTN.RB, flip: BTN.LB, fineHold: BTN.VIEW + 100 } });
  f = m3.update(pad({ down: [BTN.VIEW] }), 0.1);
  assert(f.actions.includes('help'), 'help fires on press when not shared');
  m3.update(pad(), 0.1);
  let cal = false;
  for (let t = 0; t < VIEW_HOLD_S + 0.2; t += 0.1) cal ||= m3.update(pad({ down: [BTN.MENU] }), 0.1).actions.includes('calibrate');
  assert(cal, 'calibrate on its own button after a hold');

  // sticks: swap, invert, per-stick dead zones
  const sw = new GamepadMapper({ cursorStick: 'right' });
  f = sw.update(pad({ axes: [0, 0, 1, 0] }), 0.1);
  assert(f.cursor[0] > 0 && f.pan[0] === 0, 'right stick drives the cursor when swapped');
  f = sw.update(pad({ axes: [1, 0, 0, 0] }), 0.1);
  assert(f.pan[0] < 0 && f.cursor[0] === 0, 'left stick pans when swapped');
  const inv = new GamepadMapper({ invertLeftY: true });
  assert(inv.update(pad({ axes: [0, 1, 0, 0] }), 0.1).cursor[1] < 0, 'invert left Y');
  const dz = new GamepadMapper({ deadzone: 0.3, rightDeadzone: 0.05 });
  f = dz.update(pad({ axes: [0.2, 0, 0.2, 0] }), 0.1);
  assert(f.cursor[0] === 0 && f.pan[0] !== 0, 'per-stick dead zones');
  const [l, r] = deadzonesFromRest([[0.1, 0, 0.01, 0]]);
  assert(l > r, 'calibration sets each stick separately');

  // fine speed
  const fs = new GamepadMapper({ fineFactor: 0.5 });
  f = fs.update(pad({ axes: [1, 0, 0, 0], down: [BTN.LB] }), 0.1);
  assert(near(f.cursor[0], DEFAULT_SETTINGS.cursorSpeed * 0.5 * 0.1), 'fine-mode speed setting');

  // iron trigger range and curve
  assert(near(heatScale(0, DEFAULT_SETTINGS), 0.35) && near(heatScale(1, DEFAULT_SETTINGS), 1), 'default 35–100%');
  assert(near(heatScale(0.5, DEFAULT_SETTINGS), 0.675), 'linear by default');
  assert(heatScale(0.5, { heatMin: 0.2, heatMax: 0.8, heatCurve: 0.6 }) > heatScale(0.5, { heatMin: 0.2, heatMax: 0.8, heatCurve: 1.6 }), 'soft curve gives more contact early');

  // sanitize / import / export
  const bad = sanitizeSettings({ deadzone: 9, rumble: 'yes', heatMode: 'nuke', keymap: { act: 99, flip: 2.5, cancel: 3 }, cursorStick: 'up', heatMin: 0.9, heatMax: 0.4 });
  assert(bad.deadzone === undefined && bad.rumble === undefined && bad.heatMode === undefined && bad.cursorStick === undefined, 'bad values dropped');
  assert(bad.keymap?.cancel === 3 && bad.keymap.act === undefined && bad.keymap.flip === undefined, 'only valid bindings kept');
  assert(bad.heatMin === undefined && bad.heatMax === undefined, 'inverted iron range dropped');
  const custom = defaultSettings();
  custom.keymap.act = BTN.RB; custom.rumble = false; custom.rumbleIntensity = 0.4; custom.heatMode = 'r350f'; custom.invertRightY = true;
  const text = exportSettings(custom);
  const back = defaultSettings();
  applySettings(back, importSettings(text));
  assert(JSON.stringify(back) === JSON.stringify(custom), 'export → import round trip');
  applySettings(back, importSettings(JSON.stringify({ deadzone: 0.2 })));
  assert(back.deadzone === 0.2 && back.keymap.act === BTN.A && back.rumble, 'bare object imports over defaults');
  let threw = '';
  try { importSettings('{oops'); } catch (e) { threw = (e as Error).message; }
  assert(/JSON/.test(threw), 'bad JSON explained');
  threw = '';
  try { importSettings('{"hello":1}'); } catch (e) { threw = (e as Error).message; }
  assert(/No controller settings/.test(threw), 'empty import explained');

  // storage keeps the whole thing
  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
  saveGamepadSettings(store, custom);
  const loaded = new GamepadMapper(loadGamepadSettings(store)).settings;
  assert(loaded.keymap.act === BTN.RB && loaded.rumble === false && loaded.heatMode === 'r350f', 'full settings persist');
  mem.set('deadboard_gamepad', '{"deadzone":0.2,"cursorSpeed":800}');
  const old = new GamepadMapper(loadGamepadSettings(store)).settings;
  assert(old.deadzone === 0.2 && old.keymap.act === BTN.A && old.heatMin === 0.35, 'older saved settings still load');

  // hints follow the map
  const hs = defaultSettings(); hs.keymap.act = BTN.RB;
  assert(controlHints(hs).some(([k, v]) => k === 'RB' && v.startsWith('Use tool')), 'help overlay shows remapped buttons');

  // press-to-rebind waits for release, ignores Guide, times out
  const L = new RebindListener('act', 1);
  const none = Array(17).fill(false);
  const withA = none.map((_, i) => i === BTN.A);
  assert(L.feed(withA, 0.1) === null, 'the press that started listening is ignored');
  assert(L.feed(none, 0.1) === null, 'armed after release');
  assert(L.feed(none.map((_, i) => i === BTN.GUIDE), 0.1) === null, 'Guide ignored');
  assert(L.feed(none.map((_, i) => i === BTN.Y), 0.1) === BTN.Y, 'next press captured');
  const L2 = new RebindListener('act', 0.3);
  assert(L2.feed(none, 0.2) === null && L2.feed(none, 0.2) === 'timeout', 'times out');

  // menu navigation repeat
  const nav = new NavRepeat(0.4, 0.1);
  let steps = nav.step('d', true, 0.016);
  for (let t = 0; t < 0.6; t += 0.05) steps += nav.step('d', true, 0.05);
  assert(steps >= 2 && steps <= 4, `repeat after a delay, got ${steps}`);
  assert(nav.step('d', false, 0.05) === 0 && nav.step('d', true, 0.05) === 1, 'release then press steps again');
}

console.log('gamepad settings: ok');
