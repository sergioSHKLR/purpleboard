// Records walkthrough videos by driving the real app (headless Chrome + WebGPU). A take is a
// script of captions and actions; the director draws a visible cursor, click rings and caption
// callouts into the page, captures it, then encodes an MP4 + WebVTT + poster with ffmpeg.
// Everything shown is the app's own behaviour — nothing is mocked.
//
// Capture: timestamped full-viewport screenshots (~30 fps) assembled with their real durations.
// (Chrome's screencast, and Playwright's video recorder built on it, crop headless frames.)
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';

/** 16:9 — headless Chrome's screencast captures a 16:9 frame; a matching viewport records it 1:1. */
export const VIEW = { width: 1280, height: 720 };
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

type Side = 'F' | 'B';
interface Cue { start: number; end: number; text: string }

/** In-page overlay: cursor, click ring, caption bar; flags are blurred so videos never leak them. */
const OVERLAY = `(() => {
  const css = document.createElement('style');
  css.textContent = \`
    #dir-cursor { position: fixed; left: 0; top: 0; width: 22px; height: 22px; z-index: 99999; pointer-events: none;
      transition: transform 0.55s cubic-bezier(.4,.1,.2,1); filter: drop-shadow(0 1px 2px rgba(0,0,0,.8)); }
    .dir-ring { position: fixed; width: 34px; height: 34px; margin: -17px 0 0 -17px; border: 2px solid #4be38a; border-radius: 50%;
      z-index: 99998; pointer-events: none; animation: dir-ring 0.7s ease-out forwards; }
    @keyframes dir-ring { from { transform: scale(0.3); opacity: 1 } to { transform: scale(1.6); opacity: 0 } }
    #dir-caption { position: fixed; left: calc(50% - 150px); top: 58px; transform: translateX(-50%); max-width: 720px; z-index: 99997;
      pointer-events: none; padding: 12px 18px 12px 16px; border-left: 3px solid #4be38a; border-radius: 8px;
      background: rgba(5, 8, 6, 0.92); color: #e3eae5; font: 500 17px/1.4 'Inter Variable', Inter, sans-serif;
      box-shadow: 0 10px 30px rgba(0,0,0,.5); opacity: 0; transition: opacity 0.25s; }
    #dir-caption.on { opacity: 1; }
    #dir-caption b { font-family: 'JetBrains Mono Variable', monospace; color: #4be38a; font-weight: 600; }
    #dir-caption .k { font: 600 11px/1 'JetBrains Mono Variable', monospace; letter-spacing: .1em; color: #4be38a; margin-bottom: 6px; }
    #dir-caption .w { margin-top: 6px; font-size: 14px; line-height: 1.45; color: #aeb9b1; }
    #dir-caption .w i { font-style: normal; color: #f2b33d; font-weight: 600; }
    .dir-hl { position: fixed; z-index: 99996; pointer-events: none; border: 2px solid #4be38a; border-radius: 8px;
      box-shadow: 0 0 0 4px rgba(75,227,138,.18), 0 0 24px rgba(75,227,138,.35); animation: dir-pop .35s ease-out; }
    .dir-hl.warn { border-color: #f2b33d; box-shadow: 0 0 0 4px rgba(242,179,61,.18), 0 0 24px rgba(242,179,61,.35); }
    .dir-hl span { position: absolute; left: -2px; bottom: calc(100% + 6px); white-space: nowrap; padding: 3px 8px; border-radius: 6px;
      background: #4be38a; color: #04140a; font: 600 13px/1.2 'JetBrains Mono Variable', monospace; }
    .dir-hl.warn span { background: #f2b33d; }
    .dir-hl.below span { bottom: auto; top: calc(100% + 6px); }
    @keyframes dir-pop { from { transform: scale(1.25); opacity: 0 } to { transform: scale(1); opacity: 1 } }
    #dir-card { position: fixed; inset: 0; z-index: 99999; display: grid; place-items: center; background: rgba(5,8,6,.9);
      opacity: 0; transition: opacity .35s; pointer-events: none; }
    #dir-card.on { opacity: 1; }
    #dir-card .c { width: 760px; padding: 34px 38px; border: 1px solid #2e3832; border-left: 4px solid #4be38a; border-radius: 12px; background: #0f1311; }
    #dir-card .k { font: 600 13px/1 'JetBrains Mono Variable', monospace; letter-spacing: .12em; color: #4be38a; }
    #dir-card h1 { margin: 12px 0 18px; font: 700 34px/1.15 'JetBrains Mono Variable', monospace; color: #e3eae5; letter-spacing: -.02em; }
    #dir-card ul { margin: 0; padding-left: 20px; color: #aeb9b1; font: 400 17px/1.55 'Inter Variable', Inter, sans-serif; }
    #dir-card li + li { margin-top: 8px; }
    #dir-card li b { color: #e3eae5; font-weight: 600; }
    .dir-redact { filter: blur(7px) !important; }
  \`;
  document.head.appendChild(css);
  const cur = document.createElement('div');
  cur.id = 'dir-cursor';
  cur.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M3 2l7 19 2.5-7.5L20 11z" fill="#fff" stroke="#000" stroke-width="1.2"/></svg>';
  document.body.appendChild(cur);
  const cap = document.createElement('div');
  cap.id = 'dir-caption';
  document.body.appendChild(cap);
  window.__dir = {
    move: (x, y) => { cur.style.transform = 'translate(' + x + 'px,' + y + 'px)'; },
    ring: (x, y) => { const r = document.createElement('div'); r.className = 'dir-ring'; r.style.left = x + 'px'; r.style.top = y + 'px'; document.body.appendChild(r); setTimeout(() => r.remove(), 800); },
    caption: (html) => { if (!html) { cap.classList.remove('on'); return; } cap.innerHTML = html; cap.classList.add('on'); },
    hl: (x, y, w, h, label, warn, below) => {
      const d = document.createElement('div'); d.className = 'dir-hl' + (warn ? ' warn' : '') + (below ? ' below' : '');
      d.style.left = x + 'px'; d.style.top = y + 'px'; d.style.width = w + 'px'; d.style.height = h + 'px';
      if (label) { const s = document.createElement('span'); s.textContent = label; d.appendChild(s); }
      document.body.appendChild(d);
    },
    clear: () => document.querySelectorAll('.dir-hl').forEach((e) => e.remove()),
    card: (html) => { let c = document.getElementById('dir-card'); if (!c) { c = document.createElement('div'); c.id = 'dir-card'; document.body.appendChild(c); }
      if (!html) { c.classList.remove('on'); return; } c.innerHTML = '<div class="c">' + html + '</div>'; c.classList.add('on'); },
  };
  const redact = () => document.querySelectorAll('.toast, .flag-box, .flag-box *').forEach((el) => {
    if (/[A-Z]{3,5}\\{[^}]*\\}/.test(el.textContent || '')) el.classList.add('dir-redact');
  });
  new MutationObserver(redact).observe(document.body, { subtree: true, childList: true, characterData: true });
})()`;

export class Take {
  private cues: Cue[] = [];
  private t0 = 0;
  private cursor = { x: VIEW.width / 2, y: VIEW.height / 2 };
  private captionOn: { text: string; start: number } | null = null;

  constructor(readonly page: Page, readonly dry = false) {}

  async start() {
    await this.page.evaluate(OVERLAY);
    await this.page.evaluate(([x, y]) => (window as any).__dir.move(x, y), [this.cursor.x, this.cursor.y]);
    await this.wait(400);
    this.t0 = Date.now();
  }

  get elapsed() { return (Date.now() - this.t0) / 1000; }
  get startedAt() { return this.t0; }
  wait(ms: number) { return this.page.waitForTimeout(ms); }
  /** Reading holds: skipped in a dry run (script check without recording). */
  private hold(ms: number) { return this.wait(this.dry ? 60 : ms); }

  /** Visible text of a UI element (meter display, supply readout…). */
  async text(selector: string): Promise<string> {
    return ((await this.page.locator(selector).first().textContent({ timeout: 3000 }).catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
  }
  /**
   * Guards a caption: waits up to 4 s for `selector` to match `re`, else fails the take with what
   * the app actually showed. Every number a caption quotes is checked this way.
   */
  async expect(selector: string, re: RegExp, what = selector) {
    const t0 = Date.now();
    let txt = '';
    while (Date.now() - t0 < 4000) {
      txt = await this.text(selector);
      if (re.test(txt.replace(/^\+/, ''))) { if (this.dry) console.log(`  ✓ ${what}: ${txt}`); return txt; }
      await this.wait(200);
    }
    throw new Error(`expected ${what} to match ${re}, app shows "${txt}"`);
  }

  /**
   * Shows a caption and holds it long enough to read (~15 characters per second).
   * ``**word**`` is highlighted; `step` labels the chapter, `why` adds the explanation line.
   */
  async say(text: string, opt: number | { step?: string; why?: string; hold?: number } = {}) {
    const o = typeof opt === 'number' ? { hold: opt } : opt;
    await this.endCaption();
    const fmt = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    const html = (o.step ? `<div class="k">${fmt(o.step.toUpperCase())}</div>` : '') + `<div class="m">${fmt(text)}</div>`
      + (o.why ? `<div class="w"><i>Why:</i> ${fmt(o.why)}</div>` : '');
    await this.page.evaluate((h) => (window as any).__dir.caption(h), html);
    const plain = (x: string) => x.replace(/\*\*/g, '');
    this.captionOn = { text: [o.step ? o.step.toUpperCase() : '', plain(text), o.why ? `Why: ${plain(o.why)}` : ''].filter(Boolean).join('\n'), start: this.elapsed };
    const chars = text.length + (o.why?.length ?? 0);
    await this.hold(o.hold ?? Math.min(12000, Math.max(2400, 1000 + chars * 66)));
  }

  /** Full-screen title card (opening / closing): kicker, title, bullet lines. */
  async card(kicker: string, title: string, lines: string[], holdMs?: number) {
    await this.endCaption();
    await this.page.evaluate(() => (window as any).__dir.caption(''));
    const fmt = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    const html = `<div class="k">${fmt(kicker)}</div><h1>${fmt(title)}</h1><ul>${lines.map((l) => `<li>${fmt(l)}</li>`).join('')}</ul>`;
    await this.page.evaluate((h) => (window as any).__dir.card(h), html);
    this.captionOn = { text: [kicker, title, ...lines].map((x) => x.replace(/\*\*/g, '')).join('\n'), start: this.elapsed };
    await this.hold(holdMs ?? Math.min(14000, 2500 + lines.join('').length * 55));
    await this.endCaption();
    await this.page.evaluate(() => (window as any).__dir.card(''));
    await this.wait(400);
  }

  /** Highlight box around a screen rectangle (CSS px). */
  private async hlRect(x: number, y: number, w: number, h: number, label?: string, warn = false) {
    await this.page.evaluate(([a, b, c, d, l, wn, below]) => (window as any).__dir.hl(a, b, c, d, l, wn, below), [x, y, w, h, label ?? '', warn, y < 120] as const);
    await this.wait(250);
  }
  /** Highlight a UI element. */
  async highlightEl(selector: string, label?: string, warn = false) {
    const box = await this.page.locator(selector).first().boundingBox();
    if (box) await this.hlRect(box.x - 4, box.y - 4, box.width + 8, box.height + 8, label, warn);
  }
  /** Highlight a board area: a square of `halfMm` around a point. */
  async highlightBoard(x: number, y: number, halfMm: number, label?: string, warn = false) {
    const side = await this.side();
    const a = await this.screenOf(x - halfMm, y + halfMm, side), b = await this.screenOf(x + halfMm, y - halfMm, side);
    const l = Math.min(a.x, b.x), t = Math.min(a.y, b.y);
    await this.hlRect(l, t, Math.max(24, Math.abs(b.x - a.x)), Math.max(24, Math.abs(b.y - a.y)), label, warn);
  }
  async highlightPart(ref: string, label?: string, halfMm = 3, warn = false) { const p = await this.part(ref); await this.highlightBoard(p.x, p.y, halfMm, label ?? ref, warn); }
  async highlightPad(ref: string, pad: string, label?: string, warn = false) { const p = await this.pad(ref, pad); await this.highlightBoard(p.x, p.y, 1.2, label ?? `${ref}.${pad}`, warn); }
  async clear() { await this.page.evaluate(() => (window as any).__dir.clear()); }

  private async endCaption() {
    if (!this.captionOn) return;
    this.cues.push({ ...this.captionOn, end: this.elapsed });
    this.captionOn = null;
  }

  async moveTo(x: number, y: number) {
    this.cursor = { x, y };
    await this.page.evaluate(([a, b]) => (window as any).__dir.move(a, b), [x, y]);
    await this.page.mouse.move(x, y, { steps: 8 });
    await this.wait(600);
  }

  async clickAt(x: number, y: number, opts: { button?: 'left' | 'right' } = {}) {
    await this.moveTo(x, y);
    await this.page.evaluate(([a, b]) => (window as any).__dir.ring(a, b), [x, y]);
    await this.page.mouse.click(x, y, { button: opts.button ?? 'left' });
    await this.wait(450);
  }

  /** Board point (mm) on a side → screen, via the app's automation hook. */
  async screenOf(x: number, y: number, side?: Side) {
    return this.page.evaluate(([a, b, s]) => (window as any).deadboard.toScreen(a, b, s ?? undefined), [x, y, side ?? null] as const);
  }

  async clickBoard(x: number, y: number, side?: Side, opts: { button?: 'left' | 'right' } = {}) {
    let p = await this.screenOf(x, y, side);
    // a HUD panel (supply, meter, scope) may cover the target: bring it to the middle of the view
    const covered = await this.page.evaluate(([a, b]) => { const el = document.elementFromPoint(a, b); return !el || el.tagName !== 'CANVAS'; }, [p.x, p.y]);
    if (covered) {
      await this.focus(x, y, 12);
      p = await this.screenOf(x, y, side);
    }
    await this.clickAt(p.x, p.y, opts);
  }

  async pad(ref: string, name: string): Promise<{ x: number; y: number; side: Side }> {
    const p = await this.page.evaluate(([r, n]) => (window as any).deadboard.pad(r, n), [ref, name]);
    if (!p) throw new Error(`no pad ${ref}.${name}`);
    return p;
  }

  async part(ref: string): Promise<{ x: number; y: number; side: Side }> {
    const p = await this.page.evaluate((r) => (window as any).deadboard.part(r), ref);
    if (!p) throw new Error(`no part ${ref}`);
    return p;
  }

  /** Pad of `ref` whose net name matches. */
  async padOnNet(ref: string, re: RegExp) {
    const pads = await this.page.evaluate((r) => (window as any).deadboard.pads(r), ref) as { name: string; net: string }[];
    const p = pads.find((q) => re.test(q.net));
    if (!p) throw new Error(`${ref}: no pad on ${re}`);
    return this.pad(ref, p.name);
  }

  async clickPad(ref: string, name: string, opts: { button?: 'left' | 'right' } = {}) {
    const p = await this.pad(ref, name);
    await this.clickBoard(p.x, p.y, (await this.side()) as Side, opts);
  }

  async clickPart(ref: string) {
    const p = await this.part(ref);
    await this.clickBoard(p.x, p.y, (await this.side()) as Side);
  }

  async clickEl(selector: string) {
    const box = await this.page.locator(selector).first().boundingBox();
    if (!box) throw new Error(`no element ${selector}`);
    await this.clickAt(box.x + box.width / 2, box.y + box.height / 2);
  }

  async key(k: string) { await this.page.keyboard.press(k); await this.wait(350); }

  /** Clicks a field, then types into it (visible). */
  async fill(selector: string, text: string) {
    await this.clickEl(selector);
    await this.page.locator(selector).first().fill('');
    await this.page.locator(selector).first().type(text, { delay: 90 });
    await this.wait(300);
  }

  async focus(x: number, y: number, halfH = 10, side?: Side) {
    await this.clear();
    await this.page.evaluate(([a, b, h, s]) => (window as any).deadboard.focus(a, b, h, s ?? undefined), [x, y, halfH, side ?? null] as const);
    await this.wait(700);
  }

  /** Centres the camera on a part, keeping the side currently viewed. */
  async focusPart(ref: string, halfH = 8) { const p = await this.part(ref); await this.focus(p.x, p.y, halfH); }
  async fit() { await this.clear(); await this.page.evaluate(() => (window as any).deadboard.fit()); await this.wait(500); }
  side(): Promise<Side> { return this.page.evaluate(() => (window as any).deadboard.side()); }
  async flipTo(side: Side) { if ((await this.side()) !== side) { await this.clear(); await this.key('f'); await this.wait(900); } }

  async benchSelect(selector: string, value: string) {
    await this.clickEl('#btn-bench');
    await this.page.selectOption(selector, value);
    await this.wait(400);
    await this.clickEl('#btn-bench');
  }

  async finish() {
    await this.clear();
    await this.endCaption();
    await this.page.evaluate(() => (window as any).__dir.caption(''));
    await this.wait(600);
    return { cues: this.cues, t0: this.t0, end: this.elapsed };
  }
}

export interface TakeResult { file: string; captions: string; poster: string; seconds: number }

const vttTime = (s: number) => {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), sec = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
};

export class Director {
  private browser!: Browser;
  private tmp = mkdtempSync(join(tmpdir(), 'deadboard-video-'));

  constructor(private baseUrl: string, private outDir: string, private dry = false) {}

  async launch() {
    this.browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-unsafe-webgpu', '--use-angle=metal'] });
  }

  /** Records one take of scenario `scenarioId` into `<outDir>/<name>.mp4|.vtt|.jpg`. */
  async record(scenarioId: string, name: string, script: (t: Take) => Promise<void>): Promise<TakeResult> {
    const ctx = await this.browser.newContext({ viewport: VIEW, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${this.baseUrl}/app.html?automation=1`);
    await page.waitForFunction(() => (window as any).deadboard?.ready());
    if (!(await page.evaluate((id) => (window as any).deadboard.open(id), scenarioId))) throw new Error(`unknown scenario ${scenarioId}`);
    // close the beginner tutorial so the board is unobstructed
    await page.locator('#tut-close').click({ timeout: 1500 }).catch(() => {});
    await page.evaluate(() => (window as any).deadboard.fit());
    await page.waitForTimeout(1200);

    // frame capture loop
    const dir = join(this.tmp, name);
    mkdirSync(dir, { recursive: true });
    const frames: number[] = [];
    let capturing = !this.dry;
    const loop = (async () => {
      while (capturing) {
        const buf = await page.screenshot({ type: 'jpeg', quality: 88, animations: 'allow', caret: 'initial' });
        frames.push(Date.now());
        writeFileSync(join(dir, `f${frames.length - 1}.jpg`), buf);
      }
    })();
    const take = new Take(page, this.dry);
    await take.start();
    const tCapture = take.startedAt;
    let cues: Cue[];
    try {
      await script(take);
      ({ cues } = await take.finish());
    } finally {
      capturing = false;
      await loop.catch(() => {});
      await ctx.close();
    }
    if (errors.length) throw new Error(`${scenarioId}/${name}: page errors: ${errors.join(' | ')}`);
    if (this.dry) return { file: '', captions: '', poster: '', seconds: 0 };

    // frames from the take's start, each held for its real duration
    const first = Math.max(0, frames.findIndex((t) => t >= tCapture) - 1);
    const lines = ['ffconcat version 1.0'];
    for (let i = first; i < frames.length; i++) {
      lines.push(`file 'f${i}.jpg'`, `duration ${(((frames[i + 1] ?? frames[i] + 500) - frames[i]) / 1000).toFixed(3)}`);
    }
    lines.push(`file 'f${frames.length - 1}.jpg'`);
    writeFileSync(join(dir, 'list.ffconcat'), lines.join('\n') + '\n');
    const seconds = (frames[frames.length - 1] - Math.max(tCapture, frames[first])) / 1000;

    const mp4 = join(this.outDir, `${name}.mp4`), jpg = join(this.outDir, `${name}.jpg`), vtt = join(this.outDir, `${name}.vtt`);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.ffconcat'),
      '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '28', '-movflags', '+faststart', '-an', mp4]);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', Math.min(2, seconds / 2).toFixed(2), '-i', mp4, '-frames:v', '1', '-vf', 'scale=960:-2', '-q:v', '5', jpg]);
    writeFileSync(vtt, 'WEBVTT\n\n' + cues.map((c, i) => `${i + 1}\n${vttTime(c.start)} --> ${vttTime(c.end)}\n${c.text}\n`).join('\n'));
    const base = (p: string) => p.split('/').pop()!;
    const encoded = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4]).toString().trim());
    return { file: base(mp4), captions: base(vtt), poster: base(jpg), seconds: Math.round(encoded || seconds) };
  }

  async close() {
    await this.browser?.close();
    rmSync(this.tmp, { recursive: true, force: true });
  }
}
