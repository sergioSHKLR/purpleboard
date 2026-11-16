// Renders the walkthrough videos into public/videos/ (MP4 + WebVTT + poster + index.json).
//
//   npx vite --port 5199                       # in another terminal
//   npm run videos                             # all scenes
//   npm run videos -- --only builtin-first-light --base http://localhost:5199
//   npm run videos -- --dry                    # run the scripts and check every reading, no recording
//
// Needs Google Chrome (CHROME_PATH to override) and ffmpeg with libx264.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Director } from './director';
import { SCENES } from './scenes';

async function main() {
  const args = process.argv.slice(2);
  const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const base = opt('--base') ?? 'http://localhost:5199';
  const only = opt('--only')?.split(',');
  const out = 'public/videos';
  mkdirSync(out, { recursive: true });
  const indexPath = `${out}/index.json`;
  const index: Record<string, unknown> = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : {};
  const dry = args.includes('--dry');
  const director = new Director(base, out, dry);
  await director.launch();
  try {
    for (const s of SCENES) {
      if (only && !only.includes(s.id)) continue;
      const approach = await director.record(s.id, `${s.id}.approach`, s.approach);
      const solution = await director.record(s.id, `${s.id}.solution`, s.solution);
      if (dry) { console.log(`${s.id}: script OK`); continue; }
      index[s.id] = { approach, solution };
      console.log(`${s.id}: approach ${approach.seconds}s, solution ${solution.seconds}s`);
      writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
    }
  } finally {
    await director.close();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
