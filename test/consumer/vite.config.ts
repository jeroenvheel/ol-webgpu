import {resolve} from 'node:path';
import {defineConfig} from 'vite';

// A consumer app of the built package: 'ol-gpu' resolves to dist/index.js,
// so the wasm and worker URLs go through the app's own bundling.
export default defineConfig({
  root: import.meta.dirname,
  logLevel: 'warn',
  resolve: {
    alias: {'ol-gpu': resolve(import.meta.dirname, '../../dist/index.js')},
  },
  build: {
    outDir: resolve(import.meta.dirname, '../../test/consumer/dist'),
    emptyOutDir: true,
  },
});
