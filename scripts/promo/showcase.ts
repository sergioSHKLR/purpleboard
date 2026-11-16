// Showcase video (Reddit / GitHub): motion-graphics stage around the REAL app, driven live.
//
//   npx vite --port 5199                      # or a frozen build: npx vite build && npx vite preview --port 5299
//   npm run showcase -- --base http://localhost:5199
//   npm run showcase -- --hook                # keep the 3 s thermal cold open at the start
//
// Writes docs/media/deadboard-showcase.mp4 (1920×1080, H.264, no audio), a README loop
// (deadboard-showcase.gif) and a poster. The page runs `--slow` times slower than the video
// (default 2.5): frames are captured with real timestamps and retimed, so motion is smooth.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { FRAME, STAGE, STAGE_INIT } from './stage';

const args = process.argv.slice(2);
const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const BASE = opt('--base') ?? 'http://localhost:5199';
const SLOW = Number(opt('--slow') ?? 2.5);
/** The thermal cold open is recorded but cut by default: the video starts at "01" (the board flying in). */
const KEEP_HOOK = args.includes('--hook');
const OUT = 'docs/media';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

type Side = 'F' | 'B';

class Show {
  marks: Record<string, number> = {};
  private t0 = 0;
  constructor(readonly page: Page) {}
  begin() { this.t0 = Date.now(); }
  /** Output-time chapter marker (seconds into the video). */
  mark(name: string) { this.marks[name] = (Date.now() - this.t0) / 1000 / SLOW; }
  /** Holds for `sec` seconds of OUTPUT time. */
  hold(sec: number) { return this.page.waitForTimeout(sec * 1000 * SLOW); }
  pr(fn: string, ...a: unknown[]) { return this.page.evaluate(([f, x]) => (window as any).__pr[f as string](...(x as unknown[])), [fn, a] as const); }
  app<T>(fn: string, ...a: unknown[]): Promise<T> { return this.page.evaluate(([f, x]) => (window as any).deadboard[f as string](...(x as unknown[])), [fn, a] as const) as Promise<T>; }

  async moveTo(x: number, y: number) {
    this.last = { x, y };
    await this.pr('cursor', x, y, true);
    await this.page.mouse.move(x, y, { steps: 6 });
    await this.hold(0.55);
  }
  async clickAt(x: number, y: number, button: 'left' | 'right' = 'left') {
    await this.moveTo(x, y);
    await this.pr('ring', x, y);
    await this.page.mouse.click(x, y, { button });
    await this.hold(0.3);
  }
  /** Clicks again where the cursor already is (repeated passes). */
  async clickHere() {
    await this.pr('ring', this.last.x, this.last.y);
    await this.page.mouse.click(this.last.x, this.last.y);
    await this.hold(0.35);
  }
  private last = { x: 0, y: 0 };
  async screenOf(x: number, y: number, side?: Side) { return this.app<{ x: number; y: number }>('toScreen', x, y, side); }
  async clickPad(ref: string, pad: string) { const p = await this.app<{ x: number; y: number; side: Side }>('pad', ref, pad); const s = await this.screenOf(p.x, p.y); await this.clickAt(s.x, s.y); }
  async clickPart(ref: string) { const p = await this.app<{ x: number; y: number }>('part', ref); const s = await this.screenOf(p.x, p.y); await this.clickAt(s.x, s.y); }
  async clickEl(sel: string) {
    const b = await this.page.locator(sel).first().boundingBox();
    if (!b) throw new Error(`no element ${sel}`);
    await this.clickAt(b.x + b.width / 2, b.y + b.height / 2);
  }
  async key(k: string) { await this.page.keyboard.press(k); await this.hold(0.15); }
  async type(sel: string, text: string) {
    await this.clickEl(sel);
    await this.page.locator(sel).first().fill('');
    await this.page.locator(sel).first().pressSequentially(text, { delay: 70 * SLOW });
  }
  async focus(ref: string, halfH: number) { const p = await this.app<{ x: number; y: number }>('part', ref); await this.app('focus', p.x, p.y, halfH); await this.hold(0.2); }
  /** Zooms the app onto an element (s = 1 resets). */
  async zoomEl(sel: string, s: number, ms = 700) {
    const b = await this.page.locator(sel).first().boundingBox();
    if (!b) throw new Error(`no element ${sel}`);
    await this.pr('zoom', b.x + b.width / 2, b.y + b.height / 2, s, ms);
    await this.hold(ms / 1000);
  }
  async zoomReset(ms = 600) { await this.pr('zoom', 0, 0, 1, ms); await this.hold(ms / 1000); }
  async hlPart(ref: string, halfMm: number, label: string) {
    const p = await this.app<{ x: number; y: number }>('part', ref);
    const a = await this.screenOf(p.x - halfMm, p.y + halfMm), b = await this.screenOf(p.x + halfMm, p.y - halfMm);
    await this.pr('hl', Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y), label);
  }
  async expect(sel: string, re: RegExp) {
    const t = Date.now();
    let txt = '';
    while (Date.now() - t < 5000) {
      txt = ((await this.page.locator(sel).first().textContent()) ?? '').replace(/\s+/g, ' ').trim();
      if (re.test(txt.replace(/^\+/, ''))) return txt;
      await this.page.waitForTimeout(150);
    }
    throw new Error(`expected ${sel} ~ ${re}, got "${txt}"`);
  }
  /** Slow right-drag orbit on the canvas (deltas only, so it works on a tilted window). */
  async orbit(dx: number, dy: number, sec: number) {
    const cx = FRAME.x + FRAME.w * 0.45, cy = FRAME.y + FRAME.h * 0.5;
    await this.page.mouse.move(cx, cy);
    await this.page.mouse.down({ button: 'right' });
    const n = Math.max(8, Math.round(sec * 20));
    for (let i = 1; i <= n; i++) {
      await this.page.mouse.move(cx + (dx * i) / n, cy + (dy * i) / n);
      await this.page.waitForTimeout((sec * 1000 * SLOW) / n);
    }
    await this.page.mouse.up({ button: 'right' });
  }
}

interface Prep { temp: number; hot: { x: number; y: number }; viz: string }

/** Off camera: heat the faulted board on the thermal view and frame the hot spot full-bleed. */
async function prepare(s: Show): Promise<Prep> {
  const p = s.page;
  const viz = await p.$eval('#viz-select', (e) => (e as HTMLSelectElement).value);
  await p.selectOption('#viz-select', 'thermal');
  const c = await s.app<{ x: number; y: number }>('part', 'C173');
  await s.app('focus', c.x, c.y, 7);
  await p.waitForTimeout(8000);
  const hot = await s.screenOf(c.x + 0.3, c.y);
  await p.mouse.move(hot.x, hot.y);
  await p.waitForTimeout(300);
  const status = (await p.locator('.statusbar, footer, #status').first().textContent()) ?? '';
  const temp = Number(status.match(/IR (\d+) °C/)?.[1]);
  if (!(temp > 60)) throw new Error(`hot spot not hot: "${status.slice(0, 120)}"`);
  await p.mouse.move(4, 4);
  await s.pr('frame', { y: 36, s: 1.137, o: 1 }, 1);
  await s.pr('zoom', hot.x, hot.y, 1.6, 1);
  await p.waitForTimeout(600);
  return { temp, hot, viz };
}

async function script(s: Show, prep: Prep) {
  const p = s.page;
  const MNT = 'demo-mnt-reform2-mb30', ANT = 'demo-antmicro-jetson-nano-bb';

  // ---- cold open: the dead board on the thermal camera, full-bleed (prepared off camera) ----
  s.mark('hook');
  await s.pr('zoom', prep.hot.x, prep.hot.y, 1.35, 3400);
  await s.hold(0.15);
  await s.pr('hook', "This laptop board won't boot.", `One part is running at <b>${prep.temp}&nbsp;°C</b>. Find it. Fix it. Prove it.`);
  await s.hold(3.0);
  await s.pr('hookOut', 280);
  await s.pr('frame', { y: 36, s: 1.2, o: 0 }, 280);
  await s.hold(0.3);

  // ---- hero: the window flies in, tilted, the MNT board in 3D ----
  s.mark('hero');
  await p.selectOption('#viz-select', prep.viz);
  await p.evaluate(() => (document.querySelector('#seg-view [data-view="3d"]') as HTMLElement).click());
  await s.app('fit');
  await s.pr('zoom', 0, 0, 1, 1);
  await s.pr('frame', { y: 260, rx: 34, s: 0.66, o: 0 }, 1);
  await s.hold(0.05);
  await s.pr('frame', { y: 10, rx: 14, ry: -9, s: 0.86, o: 1 }, 1200);
  await s.pr('cap', '01', 'Real open hardware', 'MNT Reform 2 laptop mainboard · <b>530</b> parts, imported from KiCad');
  await s.orbit(260, 150, 3.2); // grab-style orbit: same camera move as before the direction fix
  await s.pr('frame', {}, 1000);
  await s.hold(1.0);

  // ---- probe ----
  s.mark('probe');
  await p.evaluate(() => (document.querySelector('#seg-view [data-view="2d"]') as HTMLElement).click());
  await s.pr('cap', '02', 'Probe it like a real bench', 'Multimeter, bench supply, scope: on a SPICE-simulated circuit');
  await s.focus('C29', 5);
  await s.key('2');
  await s.clickPad('C29', '1');
  const bad = await s.expect('.dmm-val', /^0\.\d+ V$/);
  await s.zoomEl('.dmm-card', 1.9, 800);
  await s.pr('cap', '02', 'Probe it like a real bench', `+3V3 reads <b>${bad}</b>. Something is dragging the rail down.`);
  await s.hold(2.4);
  await s.zoomReset(600);

  // ---- thermal ----
  s.mark('thermal');
  const viz = await p.$eval('#viz-select', (e) => (e as HTMLSelectElement).value);
  await s.pr('cap', '03', 'Find the short by its heat', 'Thermal camera, freeze spray, IPA, rosin');
  await s.app('fit');
  await p.selectOption('#viz-select', 'thermal');
  await s.hold(0.8);
  await s.focus('C173', 16);
  await s.hold(1.6);
  await s.focus('C173', 6);
  await s.hlPart('C173', 1.6, 'C173 · hot');
  await s.hold(2.2);
  await s.pr('clearHl');

  // ---- repair ----
  s.mark('repair');
  await s.pr('cap', '04', 'Repair it', 'Wick, iron, hot air, jumper wire, fresh parts');
  await s.key('4');
  await s.clickPart('C173');
  await s.key('1');
  await s.clickPart('C173');
  await s.type('#inp-cap-val', '22u');
  await s.clickEl('#act-install-cap');
  await s.hold(0.4);
  await s.focus('C97', 7);
  await s.key('0');
  await s.pr('cap', '04', 'Repair it', 'Scrub the liquid residue off with IPA');
  await s.clickPart('C97');
  for (let k = 0; k < 3; k++) await s.clickHere();
  await p.selectOption('#viz-select', viz);
  await s.focus('C29', 5);
  await s.key('2');
  await s.clickPad('C29', '1');
  const good = await s.expect('.dmm-val', /^3\.[2-4]\d* V$/);
  await s.zoomEl('.dmm-card', 1.9, 700);
  await s.pr('cap', '04', 'Repair it', `+3V3 is back: <b>${good}</b>`);
  await s.hold(1.8);
  await s.zoomReset(500);

  // ---- prove ----
  s.mark('prove');
  await s.pr('cap', '05', 'Prove it', 'The test bench checks every rail. Pass, and the flag decrypts.');
  await s.key('1');
  await s.clickEl('#btn-verify');
  await s.hold(0.5);
  await s.clickEl('[data-tab="mission"]');
  if (!(await p.locator('.flag-box').count())) throw new Error('no flag: repair did not pass');
  await s.zoomEl('.flag-box', 1.6, 800);
  await s.hold(2.4);
  await s.zoomReset(500);

  // ---- second board: scope a converter ----
  s.mark('scope');
  await s.pr('frame', { ry: 88, s: 0.9 }, 550, 'cubic-bezier(.6,0,.9,.4)');
  await s.hold(0.6);
  await s.pr('cap', '06', 'Scope the switch node', 'Antmicro Jetson baseboard · <b>392</b> parts');
  await s.app('open', ANT);
  await p.locator('#tut-close').click({ timeout: 500 }).catch(() => {});
  await s.app('fit');
  await s.hold(0.3);
  await s.pr('frame', { ry: -88, s: 0.9 }, 1);
  await s.hold(0.05);
  await s.pr('frame', {}, 650);
  await s.hold(0.7);
  const pads = await s.app<{ name: string; net: string }[]>('pads', 'L4');
  const sw = pads.find((q) => /5V_SW/.test(q.net))!;
  const pp = await s.app<{ x: number; y: number }>('pad', 'L4', sw.name);
  await s.app('focus', pp.x, pp.y, 6);
  await s.hold(0.3);
  await s.key('o');
  const sc = await s.screenOf(pp.x, pp.y);
  await s.clickAt(sc.x, sc.y);
  await s.zoomEl('.scope-card', 1.7, 800);
  await s.hold(2.6);
  await s.zoomReset(500);

  // ---- outro ----
  s.mark('outro');
  await s.pr('cap', '', '', '');
  await s.pr('cursor', 0, 0, false);
  await s.pr('frame', { y: 140, rx: 30, s: 0.55, o: 0.18 }, 1100);
  await s.hold(0.5);
  await s.pr('logo', true);
  await s.hold(1.6);
  await s.pr('bullets', ['Free & open source', 'Runs in the browser (WebGPU)', 'Build and share your own repair challenges'], 150);
  await s.hold(1.2);
  await s.pr('link', 'tholtman1-del.github.io/deadboard', 215, 'try it ▸ ');
  await s.hold(1.6);
  await s.pr('link', 'github.com/tholtman1-del/deadboard', 275, 'source ▸ ');
  await s.hold(4.2);
  s.mark('end');
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'deadboard-showcase-'));
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-unsafe-webgpu', '--use-angle=metal'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: STAGE.width, height: STAGE.height }, deviceScaleFactor: STAGE.scale });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    // tsx may wrap functions in __name(); give the page a no-op so the serialized stage runs
    await page.addInitScript({ content: `var __name = (f) => f; (${STAGE_INIT.toString()})(${SLOW}, ${JSON.stringify(FRAME)});` });
    await page.goto(`${BASE}/app.html?automation=1`);
    await page.waitForFunction(() => (window as any).deadboard?.ready() && (window as any).__pr, null, { timeout: 60000 });
    await page.evaluate((id) => (window as any).deadboard.open(id), 'demo-mnt-reform2-mb30');
    await page.locator('#tut-close').click({ timeout: 1000 }).catch(() => {});
    await page.waitForTimeout(2500); // board load + power-up sequence settles before the first frame

    const show = new Show(page);
    const prep = await prepare(show);
    show.begin();
    const frames: number[] = [];
    let capturing = true;
    const loop = (async () => {
      while (capturing) {
        const buf = await page.screenshot({ type: 'jpeg', quality: 92 });
        frames.push(Date.now());
        writeFileSync(join(tmp, `f${frames.length - 1}.jpg`), buf);
      }
    })();
    const t0 = Date.now();
    try { await script(show, prep); } finally { capturing = false; await loop.catch(() => {}); }
    if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);

    const cut = KEEP_HOOK ? 0 : show.marks.hero;
    for (const k of Object.keys(show.marks)) show.marks[k] -= cut;
    const first = Math.max(0, frames.findIndex((t) => t >= t0 + cut * SLOW * 1000) - (KEEP_HOOK ? 1 : 0));
    const lines = ['ffconcat version 1.0'];
    for (let i = first; i < frames.length; i++) {
      const dt = ((frames[i + 1] ?? frames[i] + 300) - frames[i]) / 1000 / SLOW;
      lines.push(`file 'f${i}.jpg'`, `duration ${dt.toFixed(4)}`);
    }
    lines.push(`file 'f${frames.length - 1}.jpg'`);
    writeFileSync(join(tmp, 'list.ffconcat'), lines.join('\n') + '\n');
    const realFps = (frames.length - first) / ((frames[frames.length - 1] - frames[first]) / 1000);
    console.log(`captured ${frames.length - first} frames at ${realFps.toFixed(1)} fps real → ${(realFps * SLOW).toFixed(1)} fps in the video`);

    const mp4 = join(OUT, 'deadboard-showcase.mp4');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(tmp, 'list.ffconcat'),
      '-vf', 'scale=1920:1080:flags=lanczos,fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '20',
      '-profile:v', 'high', '-movflags', '+faststart', '-an', mp4]);
    const m = show.marks;
    // README loop: probe → thermal → repair, smaller and palette-optimised
    const gifFrom = m.probe, gifTo = m.prove;
    const pal = join(tmp, 'pal.png');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', gifFrom.toFixed(2), '-t', (gifTo - gifFrom).toFixed(2), '-i', mp4,
      '-vf', 'fps=12,scale=880:-1:flags=lanczos,palettegen=stats_mode=diff', pal]);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', gifFrom.toFixed(2), '-t', (gifTo - gifFrom).toFixed(2), '-i', mp4, '-i', pal,
      '-lavfi', 'fps=12,scale=880:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
      join(OUT, 'deadboard-showcase.gif')]);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', (KEEP_HOOK ? m.hook + 1.6 : m.hero + 2.2).toFixed(2), '-i', mp4, '-frames:v', '1', '-q:v', '3',
      join(OUT, 'deadboard-showcase-poster.jpg')]);
    console.log('chapters (s):', Object.fromEntries(Object.entries(m).map(([k, v]) => [k, +v.toFixed(1)])));
    for (const f of ['deadboard-showcase.mp4', 'deadboard-showcase.gif', 'deadboard-showcase-poster.jpg']) {
      const p = join(OUT, f);
      if (existsSync(p)) console.log(`${p}: ${(Number(execFileSync('stat', ['-f', '%z', p]).toString()) / 1e6).toFixed(1)} MB`);
    }
  } finally {
    await browser.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
