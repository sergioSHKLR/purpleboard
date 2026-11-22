// Renders the board pictures of the board picker into public/thumbs/<id>.webp: each shipped board
// as the player first sees it (fitted, top side, bench UI hidden), cropped to the board, 480×300.
//
//   npx vite --port 5199                       # in another terminal
//   npm run thumbs                             # every board in src/scenarios/catalog.ts
//   npm run thumbs -- --only builtin-first-light --base http://localhost:5199
//
// Needs Google Chrome (CHROME_PATH to override). Re-run it when a shipped board changes how it looks;
// test/catalog.test.ts fails when a board in the catalogue has no picture.
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { BOARD_INFO } from '../src/scenarios/catalog';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const W = 480, H = 300;

async function main() {
  const args = process.argv.slice(2);
  const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const base = opt('--base') ?? 'http://localhost:5199';
  const only = opt('--only')?.split(',');
  const ids = Object.keys(BOARD_INFO).filter((id) => !only || only.includes(id));
  mkdirSync('public/thumbs', { recursive: true });

  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-unsafe-webgpu', '--use-angle=metal'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const tool = await ctx.newPage(); // plain 2D canvas page for cropping and encoding
    await page.goto(`${base}/app.html?automation=1`);
    await page.waitForFunction(() => (window as any).deadboard?.ready(), null, { timeout: 60000 });
    for (const id of ids) {
      if (!(await page.evaluate((i) => (window as any).deadboard.open(i), id))) throw new Error(`unknown board ${id}`);
      await page.locator('#tut-close').click({ timeout: 800 }).catch(() => {});
      await page.waitForTimeout(id.startsWith('demo-') ? 2500 : 600);
      // focus() leaves the both-sides view big boards open in; then fit the whole board
      await page.evaluate(() => { const d = (window as any).deadboard; d.focus(0, 0, 10, 'F'); d.fit(); });
      await page.waitForTimeout(id.startsWith('demo-') ? 2500 : 900);
      const hide = await page.addStyleTag({ content: '*{visibility:hidden!important} canvas{visibility:visible!important}' });
      await page.waitForTimeout(150);
      const png = (await page.locator('canvas').first().screenshot()).toString('base64');
      await hide.evaluate((el) => el.remove());
      const webp = await tool.evaluate(async ({ src, W, H }) => {
        const img = new Image();
        img.src = `data:image/png;base64,${src}`;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const g = c.getContext('2d')!;
        g.drawImage(img, 0, 0);
        // the board: everything clearly green (solder mask and copper) on the dark background
        const d = g.getImageData(0, 0, c.width, c.height).data;
        let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
        for (let y = 0; y < c.height; y += 2) for (let x = 0; x < c.width; x += 2) {
          const i = (y * c.width + x) * 4;
          if (d[i + 1] > d[i] + 25 && d[i + 1] > 60) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
        }
        if (x1 <= x0 || y1 <= y0) throw new Error('no board on screen');
        const pad = 10;
        x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(c.width, x1 + pad); y1 = Math.min(c.height, y1 + pad);
        const o = document.createElement('canvas');
        o.width = W; o.height = H;
        const og = o.getContext('2d')!;
        og.fillStyle = '#0b0f0d';
        og.fillRect(0, 0, W, H);
        const s = Math.min(W / (x1 - x0), H / (y1 - y0)), dw = (x1 - x0) * s, dh = (y1 - y0) * s;
        og.imageSmoothingQuality = 'high';
        og.drawImage(c, x0, y0, x1 - x0, y1 - y0, (W - dw) / 2, (H - dh) / 2, dw, dh);
        return o.toDataURL('image/webp', 0.78);
      }, { src: png, W, H });
      const buf = Buffer.from(webp.split(',')[1], 'base64');
      writeFileSync(`public/thumbs/${id}.webp`, buf);
      console.log(`${id}: ${(buf.length / 1024).toFixed(1)} KB`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
