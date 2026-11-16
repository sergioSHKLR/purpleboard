import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: false,
    cssMinify: true,
    // homepage at /, the bench app at /app.html
    rollupOptions: { input: { home: 'index.html', app: 'app.html' } },
  },
});
