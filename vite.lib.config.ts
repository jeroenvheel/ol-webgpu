import {resolve} from 'node:path';
import {defineConfig} from 'vite';

// Library build: dist/index.js + a worker chunk + the two .wasm files as
// separate assets, referenced with `new URL(..., import.meta.url)` so the
// consumer's bundler (Vite, webpack 5, ...) copies them. Vite's `build.lib`
// mode is not used because it always inlines assets as base64 (that would
// put the 1.3 MB shader translator into index.js, even for WebGL2 users).
// `ol` stays external.
export default defineConfig({
  publicDir: false,
  base: './', // asset URLs relative to the module, not the site root
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true, // runs before tsc writes the .d.ts files
    target: 'es2022',
    minify: false,
    sourcemap: true,
    assetsInlineLimit: 0,
    modulePreload: false,
    rollupOptions: {
      input: {index: resolve(import.meta.dirname, 'src/index.ts')},
      preserveEntrySignatures: 'strict',
      external: (id) => id === 'ol' || id.startsWith('ol/'),
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: '[name]-[hash].js',
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
