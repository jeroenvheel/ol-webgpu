import {readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {defineConfig} from 'vitest/config';

const examples = resolve(import.meta.dirname, 'examples');
const pages = Object.fromEntries(
  readdirSync(examples)
    .filter((f) => f.endsWith('.html'))
    .map((f) => [f.replace(/\.html$/, ''), resolve(examples, f)]),
);

export default defineConfig({
  root: examples,
  publicDir: resolve(import.meta.dirname, 'test', 'rendering', 'data'),
  server: {
    port: 5180,
    fs: {allow: [import.meta.dirname]},
    headers: {
      // cross-origin isolation enables SharedArrayBuffer (optional)
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    outDir: resolve(import.meta.dirname, 'dist-examples'),
    emptyOutDir: true,
    rollupOptions: {input: pages},
  },
  worker: {format: 'es'},
  test: {
    root: import.meta.dirname,
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
  },
});
