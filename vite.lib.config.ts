import {resolve} from 'node:path';
import {defineConfig} from 'vite';

// Library build: dist/index.js + a worker chunk + the two .wasm files as
// separate assets, referenced with `new URL(..., import.meta.url)` so the
// consumer's bundler (Vite, webpack 5, ...) copies them. `ol` stays external.
//
// Library mode is needed: an app-mode build wraps dynamic imports (ol's text
// worker) in Vite's `__vitePreload` helper, which then clashes with the
// consumer's own Vite build. Library mode inlines assets as base64 though,
// so the wasm URLs in src/wasm carry `?no-inline`.
export default defineConfig({
  publicDir: false,
  base: './', // asset URLs relative to the module, not the site root
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true, // runs before tsc writes the .d.ts files
    target: 'es2022',
    minify: false,
    sourcemap: true,
    lib: {
      entry: resolve(import.meta.dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: 'index',
    },
    rollupOptions: {
      external: (id) => id === 'ol' || id.startsWith('ol/'),
      output: {
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  worker: {
    format: 'es',
    rollupOptions: {
      // the worker is a separate module: bundle its ol imports into it
      external: [],
    },
  },
});
