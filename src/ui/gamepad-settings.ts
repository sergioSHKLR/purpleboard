/**
 * Gamepad mod (by sergioSHKLR): Settings → Controller panel. Button map with press-to-rebind,
 * sticks, fine speed, iron trigger range, rumble, heat mode, calibration, a live controller test,
 * and JSON import / export. Works with mouse, touch, keyboard and the controller itself
 * (D-pad or left stick moves, ← → change a value, A selects, B closes; fixed so a bad map can't lock you out).
 * Plain DOM, system font, English only (the mod is not translated yet).
 */
import {
  BTN, BUTTON_NAMES, HEAT_MODES, KEYMAP_ROWS, NavRepeat, RebindListener, applySettings, buttonName, defaultSettings,
  exportSettings, importSettings, keymapConflicts, type BindAction, type GamepadMapper, type GamepadSettings, type HeatMode, type PadSnapshot,
} from './gamepad';

const FONT = "system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const CSS = `
.gp-status{font-size:11px;color:#9aa0a6;font-family:${FONT}}
.gps-bg{position:fixed;inset:0;z-index:80;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:max(8px,env(safe-area-inset-top)) 8px 8px}
.gps:focus{outline:none}.gps{width:min(900px,100%);max-height:100%;display:flex;flex-direction:column;background:#141618;color:#e6e6e6;border:1px solid #3a3d41;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.5);font:14px/1.4 ${FONT};overflow:hidden}
.gps *{box-sizing:border-box;font-family:${FONT}}
.gps-head,.gps-foot{display:flex;align-items:center;gap:8px;padding:10px 14px;background:#1b1e21;flex:none}
.gps-head{border-bottom:1px solid #2c2f33}.gps-foot{border-top:1px solid #2c2f33;flex-wrap:wrap}
.gps-head h3{margin:0;font-size:16px;font-weight:700;flex:1}
.gps-head .sub{color:#9aa0a6;font-size:12px;font-weight:400;margin-left:6px}
.gps-body{overflow:auto;padding:12px;display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start}
.gps-sec{background:#1b1e21;border:1px solid #2a2d31;border-radius:10px;padding:10px 12px;min-width:0}
.gps-sec.wide{grid-column:1/-1}
.gps-sec h4{margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#7ee2a8}
.gps-f{display:grid;grid-template-columns:minmax(0,1fr) minmax(90px,150px) 54px;align-items:center;gap:8px;min-height:36px}
.gps-f.ck{grid-template-columns:minmax(0,1fr) auto}
.gps-f label{min-width:0}
.gps-f output{text-align:right;font-variant-numeric:tabular-nums;color:#fff}
.gps-f select{grid-column:2/4}
.gps input[type=range]{width:100%;accent-color:#6aa84f;height:28px}
.gps input[type=checkbox]{width:22px;height:22px;accent-color:#6aa84f}
.gps select,.gps button{font-size:14px;color:#fff;background:#2b2e32;border:1px solid #4a4e53;border-radius:8px;min-height:36px;padding:4px 10px;cursor:pointer}
.gps button.pri{background:#3f6f2c;border-color:#6aa84f}
.gps button.x{min-width:36px;padding:0}
.gps .gp-focus,.gps :focus-visible{outline:3px solid #ffd27a;outline-offset:1px}
.gps-map{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2px 14px}
.gps-k{display:grid;grid-template-columns:minmax(0,1fr) 104px;align-items:center;gap:6px;min-height:38px;border-bottom:1px solid #24272a}
.gps-k .use{color:#9aa0a6;font-size:12px}
.gps-k button{width:100%}
.gps-k.bad button{border-color:#e08a00;color:#ffd27a}
.gps-k.listen button{background:#6aa84f;color:#111;border-color:#6aa84f}
.gps-warn{color:#ffd27a;font-size:13px;min-height:1.2em;margin:6px 0}
.gps-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:6px}
.gps-note{color:#9aa0a6;font-size:12px;margin:4px 0 0}
.gps-msg{flex:1;min-width:140px;color:#ffd27a;font-size:13px}
.gps-pad{font-weight:600;color:#fff;overflow-wrap:anywhere}
.gps-chips{display:flex;flex-wrap:wrap;gap:4px;margin:8px 0}
.gps-chip{min-width:38px;text-align:center;padding:3px 6px;border-radius:6px;background:#24272a;color:#9aa0a6;font-size:12px;border:1px solid #33363a}
.gps-chip.on{background:#6aa84f;color:#111;border-color:#6aa84f;font-weight:700}
.gps-axes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px 12px}
.gps-ax{font-size:12px;color:#9aa0a6}
.gps-bar{position:relative;height:8px;background:#24272a;border-radius:4px;overflow:hidden;margin-top:2px}
.gps-bar i{position:absolute;top:0;bottom:0;background:#7ee2a8}
@media (max-width:720px){.gps-body{grid-template-columns:1fr}.gps-map{grid-template-columns:1fr}.gps-axes{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-height:500px){.gps-head,.gps-foot{padding:6px 10px}.gps-body{padding:8px;gap:8px}.gps-foot .gps-note,.gps-head .sub{display:none}}
`;

type Num = { k: keyof GamepadSettings; label: string; min: number; max: number; step: number; scale: number; unit: string; dp?: number };
const STICKS: Num[] = [
  { k: 'deadzone', label: 'Left stick dead zone', min: 2, max: 50, step: 1, scale: 100, unit: '%' },
  { k: 'rightDeadzone', label: 'Right stick dead zone', min: 2, max: 50, step: 1, scale: 100, unit: '%' },
  { k: 'cursorSpeed', label: 'Cursor sensitivity (speed)', min: 100, max: 2000, step: 20, scale: 1, unit: '' },
  { k: 'panSpeed', label: 'Pan sensitivity (speed)', min: 100, max: 2500, step: 50, scale: 1, unit: '' },
  { k: 'curve', label: 'Stick response curve', min: 0.5, max: 3, step: 0.1, scale: 1, unit: '', dp: 1 },
  { k: 'fineFactor', label: 'Fine-mode speed', min: 5, max: 60, step: 1, scale: 100, unit: '%' },
];
const IRON: Num[] = [
  { k: 'heatMin', label: 'Contact at a light pull', min: 5, max: 95, step: 5, scale: 100, unit: '%' },
  { k: 'heatMax', label: 'Contact at full pull', min: 10, max: 100, step: 5, scale: 100, unit: '%' },
  { k: 'triggerOn', label: 'Trigger point (iron on)', min: 5, max: 90, step: 5, scale: 100, unit: '%' },
];
const RUMBLE: Num[] = [{ k: 'rumbleIntensity', label: 'Rumble intensity', min: 0, max: 100, step: 5, scale: 100, unit: '%' }];
const CURVES: [string, string][] = [['0.6', 'Soft (contact comes early)'], ['1', 'Linear'], ['1.6', 'Firm (needs a deep pull)']];

export interface SettingsHooks {
  save(): void;
  /** Settings changed (rebuild hints etc.). */
  changed(): void;
  rumbleTest(): string;
  openCalibration(): void;
  applyHeatMode(m: HeatMode): void;
  download(name: string, text: string): void;
}

export class GamepadSettingsPanel {
  private bg: HTMLDivElement | null = null;
  private listener: RebindListener | null = null;
  private nav = new NavRepeat();
  private prev: boolean[] = [];
  private padKey = '';
  private msgTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly mapper: GamepadMapper, private readonly hooks: SettingsHooks) {
    if (!document.getElementById('gps-style')) {
      const st = document.createElement('style');
      st.id = 'gps-style';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
  }

  get isOpen(): boolean { return !!this.bg; }
  private get s(): GamepadSettings { return this.mapper.settings; }

  open(focusFirst = false) {
    if (this.bg) return;
    const bg = document.createElement('div');
    bg.className = 'gps-bg';
    bg.innerHTML = this.html();
    bg.addEventListener('pointerdown', (e) => { if (e.target === bg) this.close(); });
    bg.addEventListener('click', (e) => this.onClick(e));
    bg.addEventListener('input', (e) => this.onInput(e.target as HTMLElement));
    bg.addEventListener('change', (e) => this.onInput(e.target as HTMLElement));
    bg.addEventListener('keydown', (e) => {
      e.stopPropagation(); // the bench's keyboard shortcuts stay off while the panel is open
      if (e.key === 'Escape') { if (this.listener) this.stopListen('Rebind cancelled.'); else this.close(); }
    });
    document.body.appendChild(bg);
    this.bg = bg;
    this.prev = new Array<boolean>(17).fill(true); // the press that opened the panel does not click inside it
    this.padKey = '';
    this.renderKeymap();
    this.syncValues();
    if (focusFirst) this.focusAt(0);
    else bg.querySelector<HTMLElement>('.gps')?.focus({ preventScroll: true });
  }

  close() {
    this.listener = null;
    this.bg?.remove();
    this.bg = null;
    this.hooks.save();
  }

  /** Values changed elsewhere (calibration, import): redraw. */
  refresh() {
    if (!this.bg) return;
    this.prev = new Array<boolean>(17).fill(true); // e.g. the B that closed calibration must not also close this
    this.renderKeymap();
    this.syncValues();
  }

  private q<T extends HTMLElement>(sel: string): T | null { return this.bg?.querySelector<T>(sel) ?? null; }

  private numHtml(f: Num) {
    return `<div class="gps-f"><label for="gps-${f.k}">${f.label}</label><input type="range" id="gps-${f.k}" data-k="${f.k}" min="${f.min}" max="${f.max}" step="${f.step}"><output data-o="${f.k}"></output></div>`;
  }
  private ckHtml(k: keyof GamepadSettings, label: string) {
    return `<div class="gps-f ck"><label for="gps-${k}">${label}</label><input type="checkbox" id="gps-${k}" data-k="${k}"></div>`;
  }
  private selHtml(k: string, label: string, opts: readonly (readonly [string, string])[]) {
    return `<div class="gps-f"><label for="gps-${k}">${label}</label><select id="gps-${k}" data-k="${k}">${opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>`;
  }

  private html(): string {
    return `<div class="gps" role="dialog" aria-modal="true" aria-label="Controller settings" tabindex="-1">
      <div class="gps-head"><h3>Controller settings<span class="sub">Settings → Controller</span></h3><button type="button" class="x" data-a="close" data-nonav title="Close (B / Esc)" aria-label="Close">✕</button></div>
      <div class="gps-body">
        <section class="gps-sec wide" data-sec="test"><h4>Controller test</h4>
          <div class="gps-pad" data-t="name">No controller detected. Connect one and press any button.</div>
          <div class="gps-note" data-t="info"></div>
          <div class="gps-chips">${BUTTON_NAMES.map((n, i) => `<span class="gps-chip" data-b="${i}">${n}</span>`).join('')}</div>
          <div class="gps-axes">${['Left X', 'Left Y', 'Right X', 'Right Y', 'LT', 'RT'].map((n, i) => `<div class="gps-ax">${n} <span data-av="${i}">0.00</span><div class="gps-bar"><i data-ab="${i}"></i></div></div>`).join('')}</div>
        </section>
        <section class="gps-sec wide" data-sec="map"><h4>Button map</h4>
          <div class="gps-note">Select a button, then press the controller button you want for it. Hold actions work while the button is held; "tap" and "hold 0.8 s" can share a button.</div>
          <div class="gps-map" data-t="map"></div>
          <div class="gps-warn" data-t="warn"></div>
          <div class="gps-row"><button type="button" data-a="resetMap">Reset buttons to defaults</button></div>
        </section>
        <section class="gps-sec" data-sec="sticks"><h4>Sticks</h4>
          ${this.selHtml('cursorStick', 'Cursor stick', [['left', 'Left stick moves the cursor'], ['right', 'Right stick moves the cursor']])}
          ${STICKS.map((f) => this.numHtml(f)).join('')}
          ${this.ckHtml('invertLeftY', 'Invert left stick Y')}
          ${this.ckHtml('invertRightY', 'Invert right stick Y')}
          <div class="gps-row"><button type="button" data-a="calibrate">Calibrate sticks…</button></div>
          <p class="gps-note">Calibration measures resting drift to set the dead zones. Shortcut: hold ${buttonName(this.s.keymap.calibrate)} for 0.8 s.</p>
        </section>
        <section class="gps-sec" data-sec="iron"><h4>Iron trigger</h4>
          ${IRON.map((f) => this.numHtml(f)).join('')}
          ${this.selHtml('heatCurve', 'Heat curve', CURVES)}
          <p class="gps-note">How firmly the iron touches the joint for a given pull (default 35–100%).</p>
          ${this.selHtml('heatMode', 'Heat mode when a controller connects', HEAT_MODES)}
          <p class="gps-note">Held-iron heat counts only in the realistic modes; Instant does the one-click action.</p>
        </section>
        <section class="gps-sec" data-sec="rumble"><h4>Rumble</h4>
          ${this.ckHtml('rumble', 'Rumble on')}
          ${RUMBLE.map((f) => this.numHtml(f)).join('')}
          ${this.ckHtml('deviceVibrate', 'Vibrate the phone or tablet when the pad has no rumble')}
          <div class="gps-row"><button type="button" data-a="rumbleTest">Test rumble</button></div>
          <p class="gps-note">USB-C gives rumble on ChromeOS and Android; Bluetooth Xbox pads on Android have none.</p>
        </section>
        <section class="gps-sec" data-sec="other"><h4>Other</h4>
          ${this.ckHtml('hintOnConnect', 'Show the controls help when a controller connects')}
          <div class="gps-row"><button type="button" data-a="export">Export JSON</button><button type="button" data-a="import">Import JSON…</button><input type="file" accept="application/json,.json" data-t="file" hidden></div>
          <div class="gps-row"><button type="button" data-a="resetAll">Reset all controller settings</button></div>
          <p class="gps-note">Settings are saved on this device as you change them.</p>
        </section>
      </div>
      <div class="gps-foot"><span class="gps-msg" data-t="msg" role="status"></span><span class="gps-note">D-pad / stick: move · ← →: change · A: select · B: close</span><button type="button" class="pri" data-a="close">Done</button></div>
    </div>`;
  }

  private renderKeymap() {
    const box = this.q('[data-t="map"]');
    if (!box) return;
    const km = this.s.keymap;
    const bad = new Set(keymapConflicts(km).flatMap((c) => c.actions));
    box.innerHTML = KEYMAP_ROWS.map(([a, label, use]) => {
      const listening = this.listener?.action === a;
      return `<div class="gps-k${bad.has(a) ? ' bad' : ''}${listening ? ' listen' : ''}"><span>${label} <span class="use">${use}</span></span><button type="button" data-bind="${a}" aria-label="${label}: ${buttonName(km[a])}">${listening ? 'Press…' : buttonName(km[a])}</button></div>`;
    }).join('');
    const warn = this.q('[data-t="warn"]');
    const lab = (a: BindAction) => KEYMAP_ROWS.find((r) => r[0] === a)?.[1] ?? a;
    if (warn) warn.textContent = keymapConflicts(km).map((c) => `⚠ ${buttonName(c.button)} is used by ${c.actions.map(lab).join(' and ')}.`).join(' ');
  }

  private syncValues() {
    const s = this.s as unknown as Record<string, unknown>;
    this.bg?.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-k]').forEach((el) => {
      const k = el.dataset.k!;
      const f = [...STICKS, ...IRON, ...RUMBLE].find((x) => x.k === k);
      if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = !!s[k];
      else if (f) el.value = String(Math.round((s[k] as number) * f.scale * 1000) / 1000);
      else el.value = String(s[k]);
      if (f) this.showOut(f);
    });
  }

  private showOut(f: Num) {
    const o = this.q(`[data-o="${f.k}"]`);
    const v = (this.s[f.k] as number) * f.scale;
    if (o) o.textContent = `${v.toFixed(f.dp ?? 0)}${f.unit}`;
  }

  private onInput(el: HTMLElement) {
    const k = (el as HTMLInputElement).dataset?.k as keyof GamepadSettings | undefined;
    if (!k) return;
    const s = this.s as unknown as Record<string, unknown>;
    const f = [...STICKS, ...IRON, ...RUMBLE].find((x) => x.k === k);
    if (el instanceof HTMLInputElement && el.type === 'checkbox') s[k] = el.checked;
    else if (f) {
      s[k] = Number((el as HTMLInputElement).value) / f.scale;
      // keep the light-pull contact below the full-pull contact
      if (k === 'heatMin' && this.s.heatMin > this.s.heatMax - 0.05) this.s.heatMax = Math.min(1, this.s.heatMin + 0.05);
      if (k === 'heatMax' && this.s.heatMax < this.s.heatMin + 0.05) this.s.heatMin = Math.max(0.05, this.s.heatMax - 0.05);
      for (const g of IRON) this.showOut(g);
      this.showOut(f);
      if (k === 'heatMin' || k === 'heatMax') this.syncValues();
    } else if (k === 'heatCurve') s[k] = Number((el as HTMLSelectElement).value);
    else s[k] = (el as HTMLSelectElement).value;
    if (k === 'heatMode') this.hooks.applyHeatMode(this.s.heatMode);
    this.hooks.save();
    this.hooks.changed();
  }

  private say(text: string) {
    const m = this.q('[data-t="msg"]');
    if (!m) return;
    m.textContent = text;
    if (this.msgTimer) clearTimeout(this.msgTimer);
    this.msgTimer = setTimeout(() => { if (m.textContent === text) m.textContent = ''; }, 6000);
  }

  private onClick(e: Event) {
    const t = e.target as HTMLElement;
    const bind = t.closest<HTMLElement>('[data-bind]')?.dataset.bind as BindAction | undefined;
    if (bind) { if (this.listener?.action === bind) this.stopListen('Rebind cancelled.'); else this.startListen(bind); return; }
    const a = t.closest<HTMLElement>('[data-a]')?.dataset.a;
    if (!a) return;
    if (a === 'close') this.close();
    else if (a === 'resetMap') { this.s.keymap = defaultSettings().keymap; this.afterChange('Buttons reset to the defaults.'); }
    else if (a === 'resetAll') { applySettings(this.s, {}); this.afterChange('All controller settings reset to the defaults.'); }
    else if (a === 'calibrate') this.hooks.openCalibration();
    else if (a === 'rumbleTest') this.say(this.hooks.rumbleTest());
    else if (a === 'export') { this.hooks.download('deadboard-controller.json', exportSettings(this.s)); this.say('Exported deadboard-controller.json.'); }
    else if (a === 'import') {
      const inp = this.q<HTMLInputElement>('[data-t="file"]');
      if (!inp) return;
      inp.value = '';
      inp.onchange = async () => {
        const file = inp.files?.[0];
        if (!file) return;
        try { this.importText(await file.text()); } catch (err) { this.say((err as Error).message); }
      };
      inp.click();
    }
  }

  /** Applies an exported JSON text (throws a readable error when unusable). */
  importText(text: string) {
    applySettings(this.s, importSettings(text));
    this.afterChange('Controller settings imported.');
    this.hooks.applyHeatMode(this.s.heatMode);
  }

  private afterChange(msg: string) {
    this.listener = null;
    this.hooks.save();
    this.hooks.changed();
    this.renderKeymap();
    this.syncValues();
    this.say(msg);
  }

  private startListen(a: BindAction) {
    this.listener = new RebindListener(a);
    this.renderKeymap();
    this.q<HTMLElement>(`[data-bind="${a}"]`)?.focus();
    this.say(`Press a controller button for "${KEYMAP_ROWS.find((r) => r[0] === a)?.[1]}" (6 s; Esc cancels).`);
  }

  private stopListen(msg: string) {
    const a = this.listener?.action;
    this.listener = null;
    this.renderKeymap();
    if (a) this.q<HTMLElement>(`[data-bind="${a}"]`)?.focus();
    this.say(msg);
  }

  private focusables(): HTMLElement[] {
    if (!this.bg) return [];
    return Array.from(this.bg.querySelectorAll<HTMLElement>('button:not([data-nonav]), input:not([type=file]), select')).filter((el) => !(el as HTMLButtonElement).disabled && el.offsetParent !== null);
  }

  private focusAt(i: number) {
    const items = this.focusables();
    if (!items.length) return;
    const el = items[(i + items.length) % items.length];
    this.bg?.querySelectorAll('.gp-focus').forEach((x) => x.classList.remove('gp-focus'));
    el.classList.add('gp-focus');
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest' });
  }

  private adjust(el: HTMLElement, d: number): boolean {
    if (el instanceof HTMLInputElement && el.type === 'range') {
      if (d > 0) el.stepUp(); else el.stepDown();
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    if (el instanceof HTMLSelectElement) {
      const n = el.selectedIndex + d;
      if (n >= 0 && n < el.options.length) { el.selectedIndex = n; el.dispatchEvent(new Event('change', { bubbles: true })); }
      return true;
    }
    return false;
  }

  /** Per frame while open: live readout, press-to-rebind, controller navigation. */
  frame(p: PadSnapshot | null, dt: number) {
    if (!this.bg) return;
    this.readout(p);
    if (!p) return;
    const pressed = p.buttons.map((b) => !!b?.pressed);
    if (this.listener) {
      const r = this.listener.feed(pressed, dt);
      if (r === 'timeout') this.stopListen('No button pressed; the binding is unchanged.');
      else if (r !== null) {
        const a = this.listener.action;
        this.s.keymap[a] = r;
        this.listener = null;
        this.hooks.save();
        this.hooks.changed();
        this.renderKeymap();
        this.q<HTMLElement>(`[data-bind="${a}"]`)?.focus();
        const c = keymapConflicts(this.s.keymap).find((x) => x.actions.includes(a));
        this.say(c ? `Bound to ${buttonName(r)}, but it is also used by another action (see the warning).` : `Bound to ${buttonName(r)}.`);
      }
      this.prev = pressed.map(() => true); // nothing fires until released
      return;
    }
    const edge = (i: number) => pressed[i] && !this.prev[i];
    const ax = (i: number) => p.axes[i] ?? 0;
    const up = this.nav.step('u', !!pressed[BTN.UP] || ax(1) < -0.6, dt);
    const down = this.nav.step('d', !!pressed[BTN.DOWN] || ax(1) > 0.6, dt);
    const left = this.nav.step('l', !!pressed[BTN.LEFT] || ax(0) < -0.6, dt);
    const right = this.nav.step('r', !!pressed[BTN.RIGHT] || ax(0) > 0.6, dt);
    const items = this.focusables();
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (up || down) this.focusAt(at < 0 ? 0 : at + (down ? 1 : -1));
    else if (left || right) {
      const el = items[at];
      if (!el || !this.adjust(el, right ? 1 : -1)) this.focusAt(at < 0 ? 0 : at + (right ? 1 : -1));
    }
    if (edge(BTN.A)) {
      const el = items[at];
      if (!el) this.focusAt(0);
      else if (el instanceof HTMLSelectElement) this.adjust(el, el.selectedIndex + 1 < el.options.length ? 1 : -el.selectedIndex);
      else if (!(el instanceof HTMLInputElement && el.type === 'range')) el.click();
    } else if (edge(BTN.B)) this.close();
    this.prev = pressed;
  }

  private readout(p: PadSnapshot | null) {
    const name = this.q('[data-t="name"]'), info = this.q('[data-t="info"]');
    const key = p ? `${p.id}|${p.mapping}` : '';
    if (key !== this.padKey && name && info) {
      this.padKey = key;
      name.textContent = p ? (p.id || 'Unnamed controller') : 'No controller detected. Connect one and press any button.';
      const rumble = p && (p as { vibrationActuator?: unknown }).vibrationActuator ? 'rumble motor found' : 'no rumble motor reported';
      info.textContent = p ? `${p.mapping === 'standard' ? 'Standard (Xbox-style) mapping' : 'Non-standard mapping: buttons may not match the names'} · ${p.buttons.length} buttons · ${p.axes.length} axes · ${rumble}` : '';
    }
    this.bg?.querySelectorAll<HTMLElement>('[data-b]').forEach((c) => { const b = p?.buttons[Number(c.dataset.b)]; c.classList.toggle('on', !!b?.pressed || (b?.value ?? 0) > 0.5); });
    const vals = [p?.axes[0] ?? 0, p?.axes[1] ?? 0, p?.axes[2] ?? 0, p?.axes[3] ?? 0, p?.buttons[BTN.LT]?.value ?? 0, p?.buttons[BTN.RT]?.value ?? 0];
    vals.forEach((v, i) => {
      const t = this.q(`[data-av="${i}"]`), bar = this.q(`[data-ab="${i}"]`);
      if (t) t.textContent = v.toFixed(2);
      if (bar) {
        if (i < 4) { const w = Math.min(50, Math.abs(v) * 50); bar.style.left = `${v < 0 ? 50 - w : 50}%`; bar.style.width = `${w}%`; }
        else { bar.style.left = '0'; bar.style.width = `${Math.min(100, Math.max(0, v) * 100)}%`; }
      }
    });
  }
}
