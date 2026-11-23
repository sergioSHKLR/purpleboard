/**
 * Gamepad support (Xbox layout, W3C "standard" mapping): pure input logic, no DOM, so the mapping
 * is unit-tested (test/gamepad.test.ts). The bench (app.ts) polls `navigator.getGamepads()` once
 * per animation frame, feeds the snapshot to `GamepadMapper.update` and acts on the result.
 *
 * Gamepad mod by sergioSHKLR. Single cursor: DEADBOARD uses one tool at a time, so the left stick
 * drives the tool cursor and the right stick pans the board (see CONTROL_HINTS below).
 */

/** W3C standard-mapping button indices (Xbox names). */
export const BTN = {
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7,
  VIEW: 8, MENU: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15, GUIDE: 16,
} as const;

export interface PadButton { pressed: boolean; value: number }
export interface PadSnapshot {
  id?: string;
  mapping?: string;
  axes: readonly number[];
  buttons: readonly PadButton[];
}

export interface GamepadSettings {
  /** Radial stick dead zone (0..1 of full tilt). */
  deadzone: number;
  /** Trigger dead zone at the released end (0..1). */
  triggerDeadzone: number;
  /** Cursor speed at full tilt, coarse mode (CSS px/s). */
  cursorSpeed: number;
  /** Fine mode speed as a fraction of coarse. */
  fineFactor: number;
  /** Right-stick pan speed at full tilt (CSS px/s). */
  panSpeed: number;
  /** Response curve exponent applied after the dead zone (1 = linear). */
  curve: number;
  /** Trigger level that counts as pressed (heat on / feed). */
  triggerOn: number;
}

export const DEFAULT_SETTINGS: GamepadSettings = {
  deadzone: 0.12, triggerDeadzone: 0.05, cursorSpeed: 520, fineFactor: 0.18, panSpeed: 700, curve: 1.8, triggerOn: 0.15,
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Radial dead zone with rescaling and a response curve: inside `dz` the stick reads 0; outside,
 * magnitude is rescaled from 0 at the dead-zone edge to 1 at full tilt, then raised to `curve`,
 * keeping the direction. Radial (not per-axis) so diagonals do not stick.
 */
export function stick(x: number, y: number, dz: number, curve = 1): [number, number] {
  const m = Math.hypot(x, y);
  if (!(m > dz) || m === 0) return [0, 0];
  const r = Math.pow(clamp((m - dz) / (1 - dz), 0, 1), curve);
  return [(x / m) * r, (y / m) * r];
}

/** Analog trigger with a released-end dead zone, rescaled to 0..1 (snaps to 1 near full pull). */
export function trigger(b: PadButton | undefined, dz: number): number {
  if (!b) return 0;
  const v = Number.isFinite(b.value) ? b.value : b.pressed ? 1 : 0;
  const raw = v === 0 && b.pressed ? 1 : v; // digital-only triggers
  if (raw <= dz) return 0;
  if (raw >= 0.97) return 1;
  return clamp((raw - dz) / (0.97 - dz), 0, 1);
}

export type PadAction =
  | 'act' | 'cancel' | 'toolPrev' | 'toolNext' | 'menu' | 'help' | 'calibrate'
  | 'toggleFine' | 'flip' | 'up' | 'down' | 'left' | 'right'
  | 'heatStart' | 'heatEnd' | 'feed';

export interface PadFrame {
  /** Cursor movement this frame (CSS px). */
  cursor: [number, number];
  /** Board pan this frame (CSS px, like a mouse drag). */
  pan: [number, number];
  /** D-pad held directions this frame (for continuous zoom / pan). */
  held: { up: boolean; down: boolean; left: boolean; right: boolean };
  /** Right trigger 0..1: iron contact pressure. */
  heat: number;
  /** Left trigger 0..1: solder feed / grip. */
  feed: number;
  fine: boolean;
  actions: PadAction[];
  /** Any stick, trigger or button input this frame (above the dead zones). */
  active: boolean;
}

/** View held this long (s) opens calibration instead of toggling help. */
export const VIEW_HOLD_S = 0.8;

export class GamepadMapper {
  settings: GamepadSettings;
  private prev: boolean[] = [];
  private fineLatched = false;
  private heatOn = false;
  private feedOn = false;
  private viewHeld = 0;
  private viewFired = false;

  constructor(settings: Partial<GamepadSettings> = {}) {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
  }

  get fine(): boolean { return this.fineLatched; }

  /** Forget held state (pad disconnected or app lost focus). */
  reset() { this.prev = []; this.heatOn = false; this.feedOn = false; this.viewHeld = 0; this.viewFired = false; }

  update(p: PadSnapshot, dt: number): PadFrame {
    const s = this.settings;
    const down = (i: number) => !!p.buttons[i]?.pressed;
    const edge = (i: number) => down(i) && !this.prev[i];
    const actions: PadAction[] = [];

    if (edge(BTN.L3)) { this.fineLatched = !this.fineLatched; actions.push('toggleFine'); }
    const fine = this.fineLatched !== down(BTN.LB); // LB held = momentary fine (or coarse while latched)

    const [lx, ly] = stick(p.axes[0] ?? 0, p.axes[1] ?? 0, s.deadzone, s.curve);
    const [rx, ry] = stick(p.axes[2] ?? 0, p.axes[3] ?? 0, s.deadzone, s.curve);
    const sp = s.cursorSpeed * (fine ? s.fineFactor : 1) * dt;
    const cursor: [number, number] = [lx * sp, ly * sp];
    const pan: [number, number] = [-rx * s.panSpeed * dt, -ry * s.panSpeed * dt];

    const heat = trigger(p.buttons[BTN.RT], s.triggerDeadzone);
    const feed = trigger(p.buttons[BTN.LT], s.triggerDeadzone);
    if (!this.heatOn && heat >= s.triggerOn) { this.heatOn = true; actions.push('heatStart'); }
    else if (this.heatOn && heat < s.triggerOn * 0.6) { this.heatOn = false; actions.push('heatEnd'); }
    if (!this.feedOn && feed >= s.triggerOn) { this.feedOn = true; actions.push('feed'); }
    else if (this.feedOn && feed < s.triggerOn * 0.6) this.feedOn = false;

    if (edge(BTN.A)) actions.push('act');
    if (edge(BTN.B)) actions.push('cancel');
    if (edge(BTN.X)) actions.push('toolPrev');
    if (edge(BTN.Y)) actions.push('toolNext');
    if (edge(BTN.RB)) actions.push('flip');
    if (edge(BTN.MENU)) actions.push('menu');
    if (edge(BTN.UP)) actions.push('up');
    if (edge(BTN.DOWN)) actions.push('down');
    if (edge(BTN.LEFT)) actions.push('left');
    if (edge(BTN.RIGHT)) actions.push('right');

    // View: tap = help overlay, hold = calibration
    if (down(BTN.VIEW)) {
      this.viewHeld += dt;
      if (!this.viewFired && this.viewHeld >= VIEW_HOLD_S) { this.viewFired = true; actions.push('calibrate'); }
    } else {
      if (this.prev[BTN.VIEW] && !this.viewFired) actions.push('help');
      this.viewHeld = 0; this.viewFired = false;
    }

    const held = { up: down(BTN.UP), down: down(BTN.DOWN), left: down(BTN.LEFT), right: down(BTN.RIGHT) };
    const active = lx !== 0 || ly !== 0 || rx !== 0 || ry !== 0 || heat > 0 || feed > 0 || p.buttons.some((b, i) => i !== BTN.GUIDE && b?.pressed);
    this.prev = p.buttons.map((b) => !!b?.pressed);
    return { cursor, pan, held, heat, feed, fine, actions, active };
  }
}

/**
 * Dead zone from resting-stick samples (hands off): just above the largest resting deflection
 * of either stick, clamped to a sane range.
 */
export function deadzoneFromRest(samples: readonly (readonly number[])[]): number {
  let m = 0;
  for (const a of samples) m = Math.max(m, Math.hypot(a[0] ?? 0, a[1] ?? 0), Math.hypot(a[2] ?? 0, a[3] ?? 0));
  return clamp(Math.round((m * 1.25 + 0.03) * 100) / 100, 0.05, 0.35);
}

export interface Haptics {
  /** Gamepad body rumble (Chrome: dual-rumble), when the browser exposes an actuator. */
  playEffect?: (type: 'dual-rumble', p: { startDelay: number; duration: number; weakMagnitude: number; strongMagnitude: number }) => Promise<unknown>;
  effects?: readonly string[];
}

/**
 * One haptic pulse: the pad's rumble motors when present, otherwise the phone/tablet's own
 * vibration (Android). Returns the channel used, or 'none'.
 */
export function hapticPulse(
  actuator: Haptics | null | undefined,
  vibrate: ((ms: number) => boolean) | undefined,
  strong: number, weak: number, ms: number,
): 'pad' | 'device' | 'none' {
  if (actuator?.playEffect && (!actuator.effects || actuator.effects.includes('dual-rumble'))) {
    actuator.playEffect('dual-rumble', { startDelay: 0, duration: ms, weakMagnitude: clamp(weak, 0, 1), strongMagnitude: clamp(strong, 0, 1) }).catch(() => undefined);
    return 'pad';
  }
  if (vibrate && (strong > 0 || weak > 0)) {
    try { if (vibrate(ms)) return 'device'; } catch { /* not allowed yet */ }
  }
  return 'none';
}

/** The control mapping shown in the on-screen hint overlay (English; the mod is not translated). */
export const CONTROL_HINTS: readonly [string, string][] = [
  ['Left stick', 'Move the tool cursor'],
  ['L3 / hold LB', 'Fine cursor (toggle / hold)'],
  ['Right stick', 'Pan the board'],
  ['RT (hold)', 'Iron on the joint: heat while held, pressure = contact'],
  ['LT', 'Feed solder (iron) · black probe (meter) · use tool'],
  ['A', 'Use tool / select'],
  ['B', 'Cancel · lift · close'],
  ['X / Y', 'Previous / next tool'],
  ['RB', 'Flip board (top / bottom)'],
  ['D-pad ↑ ↓', 'Zoom in / out (menus: move)'],
  ['D-pad ← →', 'Pan (menus: move)'],
  ['Menu', 'Boards menu (open / close)'],
  ['View', 'This help · hold: calibrate sticks'],
];

export interface StoredGamepad { deadzone?: number; cursorSpeed?: number }
export const GAMEPAD_STORAGE_KEY = 'deadboard_gamepad';

export function loadGamepadSettings(store: Pick<Storage, 'getItem'> | null): Partial<GamepadSettings> {
  try {
    const raw = store?.getItem(GAMEPAD_STORAGE_KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as StoredGamepad;
    const out: Partial<GamepadSettings> = {};
    if (typeof v.deadzone === 'number' && v.deadzone >= 0.02 && v.deadzone <= 0.5) out.deadzone = v.deadzone;
    if (typeof v.cursorSpeed === 'number' && v.cursorSpeed >= 100 && v.cursorSpeed <= 2000) out.cursorSpeed = v.cursorSpeed;
    return out;
  } catch { return {}; }
}

export function saveGamepadSettings(store: Pick<Storage, 'setItem'> | null, s: GamepadSettings) {
  try { store?.setItem(GAMEPAD_STORAGE_KEY, JSON.stringify({ deadzone: s.deadzone, cursorSpeed: s.cursorSpeed })); } catch { /* storage off */ }
}
