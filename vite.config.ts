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

/** modding.html is docs/MODDING.md rendered into the homepage design: one source for repo and site. */
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
      if (!ctx.filename.endsWith('modding.html')) return html;
      // site-relative links: the download sits next to the page
      const src = readFileSync('docs/MODDING.md', 'utf8').replaceAll('https://tholtman1-del.github.io/deadboard/', './');
      return html.replace('<!--MODDING-->', md.parse(src) as string);
    },
    configureServer(server) {
      server.watcher.add('docs/MODDING.md');
      server.watcher.on('change', (f) => { if (f.endsWith('MODDING.md')) server.ws.send({ type: 'full-reload' }); });
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
    // homepage at /, the bench app at /app.html, the modding guide at /modding.html
    rollupOptions: { input: { home: 'index.html', app: 'app.html', modding: 'modding.html' } },
  },
});
