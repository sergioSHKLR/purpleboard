import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import { Marked } from 'marked';

// version + commit, shown in bug reports so a report can be matched to the build that produced it
const version = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
let commit = '';
try { commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* not a checkout */ }

// GitHub-style heading anchors, so links like #where-mods-live work on the site as on GitHub
const slug = (s: string) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/g, '').replace(/[^\w\- ]/g, '').trim().replace(/ /g, '-');

/** Site pages rendered from Markdown into the homepage design (one source for repo and site):
 *  modding.html ← docs/MODDING.md, privacy.html ← docs/PRIVACY.md. */
const docPages: Record<string, { md: string; slot: string }> = {
  'modding.html': { md: 'docs/MODDING.md', slot: '<!--MODDING-->' },
  'privacy.html': { md: 'docs/PRIVACY.md', slot: '<!--PRIVACY-->' },
};
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
  return {
    name: 'modding-guide',
    transformIndexHtml(html, ctx) {
      const page = Object.keys(docPages).find((p) => ctx.filename.endsWith(p));
      if (!page) return html;
      // site-relative links: the download sits next to the page
      const src = readFileSync(docPages[page].md, 'utf8').replaceAll('https://deadboard.org/', './');
      return html.replace(docPages[page].slot, md.parse(src) as string);
    },
    configureServer(server) {
      for (const { md: f } of Object.values(docPages)) server.watcher.add(f);
      server.watcher.on('change', (f) => { if (Object.values(docPages).some((d) => f.endsWith(d.md))) server.ws.send({ type: 'full-reload' }); });
    },
  };
}

export default defineConfig({
  plugins: [moddingGuide()],
  base: './',
  define: { __APP_BUILD__: JSON.stringify(commit ? `${version}+${commit}` : version) },
  build: {
    target: 'es2022',
    sourcemap: false,
    cssMinify: true,
    // homepage at /, the bench app at /app.html, the modding guide at /modding.html, privacy policy at /privacy.html
    rollupOptions: { input: { home: 'index.html', app: 'app.html', modding: 'modding.html', privacy: 'privacy.html' } },
  },
});
