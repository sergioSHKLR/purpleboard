import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build as esbuild } from 'esbuild';
import { defineConfig, type Plugin } from 'vite';
import { Marked } from 'marked';

// version + commit, shown in bug reports so a report can be matched to the build that produced it
const version = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
let commit = '';
try { commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* not a checkout */ }

// GitHub-style heading anchors, so links like #where-mods-live work on the site as on GitHub
const slug = (s: string) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/g, '').replace(/[^\w\- ]/g, '').trim().replace(/ /g, '-');

/** Site pages rendered from Markdown into the homepage design (one source for repo and site).
 *  The mod docs share a navigation (<!--DOCNAV-->) and are also published as raw Markdown
 *  (/modding.md, …) for AI agents, with links between them pointing at the .md versions.
 *  The educational guides share their own curriculum navigation (<!--DOCNAV-->) and pager (<!--DOCPAGER-->). */
interface DocPage { md: string; slot: string; nav?: string; group?: 'mod' | 'learn' }
const docPages: Record<string, DocPage> = {
  'modding.html': { md: 'docs/MODDING.md', slot: '<!--MODDING-->', nav: 'Make a mod', group: 'mod' },
  'mod-reference.html': { md: 'docs/MOD_REFERENCE.md', slot: '<!--DOC-->', nav: 'Mod reference', group: 'mod' },
  'code-mods.html': { md: 'docs/CODE_MODS.md', slot: '<!--DOC-->', nav: 'Code mods', group: 'mod' },
  'mod-safety.html': { md: 'docs/MOD_SAFETY.md', slot: '<!--DOC-->', nav: 'Are mods safe?', group: 'mod' },
  'mods-for-agents.html': { md: 'docs/MODS_FOR_AGENTS.md', slot: '<!--DOC-->', nav: 'For AI agents', group: 'mod' },
  'learn.html': { md: 'docs/learn/INDEX.md', slot: '<!--DOC-->', nav: 'Overview & repair path', group: 'learn' },
  'learn-multimeter.html': { md: 'docs/learn/MULTIMETER.md', slot: '<!--DOC-->', nav: 'Multimeter & Ohm’s law', group: 'learn' },
  'learn-shorts.html': { md: 'docs/learn/SHORTS.md', slot: '<!--DOC-->', nav: 'Finding short circuits', group: 'learn' },
  'learn-rails.html': { md: 'docs/learn/POWER_RAILS.md', slot: '<!--DOC-->', nav: 'Power rails & scope', group: 'learn' },
  'learn-rework.html': { md: 'docs/learn/REWORK.md', slot: '<!--DOC-->', nav: 'Soldering & rework', group: 'learn' },
  'privacy.html': { md: 'docs/PRIVACY.md', slot: '<!--PRIVACY-->' },
};
/** Markdown filename (as linked inside docs/*.md or docs/learn/*.md) → page name. */
const docLinks: Record<string, string> = Object.fromEntries(
  Object.entries(docPages).map(([page, d]) => [d.md.replace(/^docs\/(?:learn\/)?/, ''), page.replace('.html', '')]),
);
const mapDocLinks = (src: string, to: (page: string) => string) =>
  src.replace(/\]\((?:\.\.\/)?([A-Z_]+\.md)(#[^)\s]*)?\)/g, (m, file: string, hash?: string) => (docLinks[file] ? `](${to(docLinks[file])}${hash ?? ''})` : m));

function moddingGuide(): Plugin {
  const md = new Marked({ gfm: true });
  md.use({
    renderer: {
      heading({ tokens, depth }) {
        const html = this.parser.parseInline(tokens);
        const id = slug(html);
        return `<h${depth} id="${id}">${html}${depth > 1 ? ` <a class="anchor" href="#${id}" aria-label="Link to this section">#</a>` : ''}</h${depth}>\n`;
      },
    },
  });
  const docNav = (current: string) => {
    const group = docPages[current]?.group;
    if (!group) return '';
    const label = group === 'learn' ? 'Repair curriculum' : 'Mod documentation';
    const eyebrow = group === 'learn' ? '&gt; repair curriculum' : '&gt; mod docs';
    const items = Object.entries(docPages)
      .filter(([, d]) => d.nav && d.group === group)
      .map(([page, d]) => `<a href="./${page}"${page === current ? ' aria-current="page"' : ''}>${d.nav}</a>`);
    const tail = group === 'mod'
      ? ['<a href="./llms.txt" class="muted">llms.txt</a>']
      : ['<a href="./app.html?tutorial=1" class="muted">Interactive tutorials →</a>'];
    return [`<nav class="doc-nav" aria-label="${label}"><p class="eyebrow">${eyebrow}</p>`, ...items, ...tail, '</nav>'].join('');
  };
  const docPager = (current: string) => {
    const group = docPages[current]?.group;
    if (group !== 'learn') return '';
    const list = Object.entries(docPages).filter(([, d]) => d.nav && d.group === 'learn');
    const idx = list.findIndex(([page]) => page === current);
    if (idx < 0) return '';
    const prev = idx > 0 ? list[idx - 1] : null;
    const next = idx + 1 < list.length ? list[idx + 1] : null;
    return [
      '<nav class="doc-pager" aria-label="Lesson navigation">',
      prev ? `<a class="doc-pager-link prev" href="./${prev[0]}"><span>← Previous</span><strong>${prev[1].nav}</strong></a>` : '<span></span>',
      next ? `<a class="doc-pager-link next" href="./${next[0]}"><span>Next guide →</span><strong>${next[1].nav}</strong></a>` : '<a class="doc-pager-link next" href="./app.html?tutorial=1"><span>Ready to practice →</span><strong>Open the bench</strong></a>',
      '</nav>',
    ].join('');
  };
  /** The doc as raw Markdown for agents: absolute links, other docs as .md. */
  const rawDoc = (file: string) => mapDocLinks(readFileSync(file, 'utf8'), (page) => `https://deadboard.org/${page}.md`);
  return {
    name: 'modding-guide',
    transformIndexHtml(html, ctx) {
      const page = Object.keys(docPages).find((p) => ctx.filename.endsWith(p));
      if (!page) return html;
      // site-relative links: the download sits next to the page; other docs are pages
      const src = mapDocLinks(readFileSync(docPages[page].md, 'utf8').replaceAll('https://deadboard.org/', './'), (p) => `./${p}.html`);
      return html
        .replace(docPages[page].slot, md.parse(src) as string)
        .replace('<!--DOCNAV-->', docNav(page))
        .replace('<!--DOCPAGER-->', docPager(page));
    },
    generateBundle() {
      for (const [page, d] of Object.entries(docPages)) {
        if (d.nav && d.group === 'mod') this.emitFile({ type: 'asset', fileName: page.replace('.html', '.md'), source: rawDoc(d.md) });
      }
    },
    configureServer(server) {
      for (const { md: f } of Object.values(docPages)) server.watcher.add(f);
      server.watcher.on('change', (f) => { if (Object.values(docPages).some((d) => f.endsWith(d.md))) server.ws.send({ type: 'full-reload' }); });
      // the raw Markdown in dev too
      server.middlewares.use((req, res, next) => {
        const page = Object.entries(docPages).find(([p, d]) => d.nav && d.group === 'mod' && req.url?.split('?')[0] === `/${p.replace('.html', '.md')}`);
        if (!page) { next(); return; }
        res.setHeader('content-type', 'text/markdown; charset=utf-8');
        res.end(rawDoc(page[1].md));
      });
    },
  };
}

/** The code-mod sandbox runtime (src/mods/api/runtime-worker.ts) bundled into one script and
 *  exported as a string: the sandbox starts it from a blob, so it can't import from the app's origin. */
function modRuntime(): Plugin {
  const id = 'virtual:deadboard-mod-runtime';
  return {
    name: 'mod-runtime',
    resolveId: (x) => (x === id ? `\0${id}` : null),
    async load(x) {
      if (x !== `\0${id}`) return null;
      const r = await esbuild({ entryPoints: ['src/mods/api/runtime-worker.ts'], bundle: true, write: false, format: 'iife', target: 'es2020', minify: true, metafile: true, logLevel: 'silent' });
      for (const f of Object.keys(r.metafile.inputs)) this.addWatchFile(resolve(f));
      return `export default ${JSON.stringify(r.outputFiles[0].text)};`;
    },
  };
}

export default defineConfig({
  plugins: [moddingGuide(), modRuntime()],
  base: './',
  define: { __APP_BUILD__: JSON.stringify(commit ? `${version}+${commit}` : version) },
  build: {
    target: 'es2022',
    sourcemap: false,
    cssMinify: true,
    // homepage at /, the bench app at /app.html, educational guides at /learn*.html, mod docs at /modding.html (+ mod-reference, code-mods, mod-safety, mods-for-agents), privacy policy at /privacy.html
    rollupOptions: {
      input: {
        home: 'index.html',
        app: 'app.html',
        learn: 'learn.html',
        learnMultimeter: 'learn-multimeter.html',
        learnShorts: 'learn-shorts.html',
        learnRails: 'learn-rails.html',
        learnRework: 'learn-rework.html',
        modding: 'modding.html',
        privacy: 'privacy.html',
        modReference: 'mod-reference.html',
        codeMods: 'code-mods.html',
        modSafety: 'mod-safety.html',
        modsForAgents: 'mods-for-agents.html',
      },
    },
  },
});
