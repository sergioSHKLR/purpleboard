import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// version + commit, shown in bug reports so a report can be matched to the build that produced it
const version = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
let commit = '';
try { commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* not a checkout */ }

export default defineConfig({
  base: './',
  define: { __APP_BUILD__: JSON.stringify(commit ? `${version}+${commit}` : version) },
  build: {
    target: 'es2022',
    sourcemap: false,
    cssMinify: true,
    // homepage at /, the bench app at /app.html
    rollupOptions: { input: { home: 'index.html', app: 'app.html' } },
  },
});
