// Reading DEADBOARD's puzzle statistics (collector/) from scripts: SQL through wrangler, which
// uses the Cloudflare login of this machine (`npx wrangler login`). `--local` reads the database
// of `wrangler dev` instead (collector/README.md).
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const collector = fileURLToPath(new URL('../collector/', import.meta.url));

export function d1Query<T>(sql: string, local = process.argv.includes('--local')): T[] {
  const out = execFileSync('npx', ['--yes', 'wrangler@4', 'd1', 'execute', 'deadboard-attempts', local ? '--local' : '--remote', '--json', '--command', sql], { cwd: collector, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const res = JSON.parse(out) as { results: T[] }[];
  return res[0]?.results ?? [];
}

/** `--days N` (default `def`) as the first day of the window, YYYY-MM-DD. */
export function sinceArg(def = 7): { since: string; days: number } {
  const a = process.argv.indexOf('--days');
  const days = (a >= 0 && Number(process.argv[a + 1])) || def;
  return { since: new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10), days };
}

/** Groups smaller than this are shown as "<10": small groups could point at a person. */
export const MIN_GROUP = 10;
