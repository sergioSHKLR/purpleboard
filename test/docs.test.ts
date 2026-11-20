// The mod docs' generated blocks match the code (npm run docs), and their links between pages and
// to sections resolve, so the website's docs can't drift from what the app does.
import { apiTypesMarkdown, fillGenerated, officialItemsMarkdown } from '../src/mods/docgen';
import { builtinScenarios } from '../src/scenarios/builtin';

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
interface Fs { readFileSync(p: string, enc: string): string; existsSync(p: string): boolean }

const slug = (s: string) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/`/g, '').replace(/&[a-z#0-9]+;/g, '').replace(/[^\w\- ]/g, '').trim().replace(/ /g, '-');
const DOCS = ['MODDING.md', 'MOD_REFERENCE.md', 'CODE_MODS.md', 'MOD_SAFETY.md', 'MODS_FOR_AGENTS.md'];

async function run() {
  const fsName = 'node:fs';
  const fs = (await import(/* @vite-ignore */ fsName)) as Fs;
  const read = (p: string) => fs.readFileSync(p, 'utf8');

  const demos = JSON.parse(read('public/demos/index.json')) as { id: string; title: string }[];
  const ref = read('docs/MOD_REFERENCE.md');
  assert(fillGenerated(ref, 'official-items', officialItemsMarkdown(await builtinScenarios(), demos)) === ref, 'docs/MOD_REFERENCE.md is stale: run npm run docs');
  const code = read('docs/CODE_MODS.md');
  assert(fillGenerated(code, 'api-types', apiTypesMarkdown(read('src/mods/api/types.ts'))) === code, 'docs/CODE_MODS.md is stale: run npm run docs');

  // links between the docs pages and to their sections resolve (the site maps X.md → x.html)
  const anchors = new Map(DOCS.map((d) => [d, new Set([...read(`docs/${d}`).matchAll(/^#{1,4} (.+)$/gm)].map((m) => slug(m[1])))]));
  let checked = 0;
  for (const d of DOCS) {
    for (const m of read(`docs/${d}`).matchAll(/\]\(((?:[A-Z_]+\.md)?)(#[\w-]+)?\)/g)) {
      const file = m[1] || d, hash = m[2]?.slice(1);
      if (!m[1] && !hash) continue;
      assert(anchors.has(file), `${d}: link to ${file}, which isn't a docs page`);
      if (hash) assert(anchors.get(file)!.has(hash), `${d}: link to ${file}#${hash}, which has no such section`);
      checked++;
    }
  }
  assert(checked > 20, `links checked (${checked})`);
  assert(fs.existsSync('public/llms.txt') && /mods-for-agents\.md/.test(read('public/llms.txt')), 'llms.txt points agents to the docs');
  console.log(`DOCS TESTS PASSED (generated blocks current, ${checked} links between docs pages resolve, llms.txt)`);
}

run().catch((e) => { console.error(e); (globalThis as unknown as { process: { exitCode: number } }).process.exitCode = 1; });
