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

  // educational guides: internal markdown links and ?board=<id> deep links resolve to real boards
  const LEARN = ['INDEX.md', 'MULTIMETER.md', 'SHORTS.md', 'POWER_RAILS.md', 'REWORK.md', 'BOARDVIEW.md', 'CASE_STUDIES.md'];
  const allBoardIds = new Set([...(await builtinScenarios()).map((s) => s.id), ...demos.map((d) => d.id)]);
  const learnAnchors = new Map(LEARN.map((d) => [d, new Set([...read(`docs/learn/${d}`).matchAll(/^#{1,4} (.+)$/gm)].map((m) => slug(m[1])))]));
  let learnBoards = 0;
  for (const d of LEARN) {
    const src = read(`docs/learn/${d}`);
    for (const m of src.matchAll(/\]\(((?:\.\.\/)?[A-Z_]+\.md)(#[\w-]+)?\)/g)) {
      const target = m[1], hash = m[2]?.slice(1);
      if (target.startsWith('../')) {
        const file = target.slice(3);
        assert(anchors.has(file), `learn/${d}: link to ${target}, which isn't a docs page`);
        if (hash) assert(anchors.get(file)!.has(hash), `learn/${d}: link to ${target}#${hash}, no such section`);
      } else {
        assert(learnAnchors.has(target), `learn/${d}: link to ${target}, which isn't a learn page`);
        if (hash) assert(learnAnchors.get(target)!.has(hash), `learn/${d}: link to ${target}#${hash}, no such section`);
      }
      checked++;
    }
    for (const m of src.matchAll(/\.\/app\.html\?board=([a-z0-9-]+)/g)) {
      assert(allBoardIds.has(m[1]), `learn/${d}: unknown board id ${m[1]}`);
      learnBoards++;
    }
  }
  assert(learnBoards >= 25, `learn bench links checked (${learnBoards})`);
  assert(fs.existsSync('public/robots.txt') && fs.existsSync('public/sitemap.xml'), 'robots.txt and sitemap.xml present');

  // SEO parity: every site page in vite.config.ts is listed in sitemap.xml and carries core meta tags
  const sitemap = read('public/sitemap.xml');
  const viteSrc = read('vite.config.ts');
  const inputBlock = /rollupOptions:\s*\{\s*input:\s*\{([\s\S]*?)\}\s*,?\s*\}/.exec(viteSrc)?.[1] ?? '';
  const htmlPages = [...inputBlock.matchAll(/:\s*'([^']+\.html)'/g)].map((m) => m[1]);
  assert(htmlPages.length >= 15, `vite HTML entry points (${htmlPages.length})`);
  for (const p of htmlPages) {
    const loc = p === 'index.html' ? 'https://deadboard.org/' : `https://deadboard.org/${p}`;
    assert(sitemap.includes(`<loc>${loc}</loc>`), `public/sitemap.xml is missing ${loc}`);
    if (p === 'ru.html') continue; // generated at build time from index.html
    const html = read(p);
    for (const [label, re] of [
      ['title', /<title>[^<]+<\/title>/],
      ['meta description', /<meta name="description" content="[^"]+" \/>/],
      ['canonical', /<link rel="canonical" href="https:\/\/deadboard\.org\/[^"]*" \/>/],
      ['og:title', /<meta property="og:title" content="[^"]+" \/>/],
      ['og:description', /<meta property="og:description" content="[^"]+" \/>/],
      ['og:image', /<meta property="og:image" content="https:\/\/deadboard\.org\/[^"]+" \/>/],
      ['twitter:card', /<meta name="twitter:card" content="summary_large_image" \/>/],
    ] as const) {
      assert(re.test(html), `${p}: missing ${label}`);
    }
  }
  console.log(`DOCS TESTS PASSED (generated blocks current, ${checked} links between docs pages resolve, ${learnBoards} learn board links, ${htmlPages.length} pages SEO + sitemap checked)`);
}

run().catch((e) => { console.error(e); (globalThis as unknown as { process: { exitCode: number } }).process.exitCode = 1; });
