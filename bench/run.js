// Runs examples/bench.html in Playwright Chromium and stores the results.
// Usage: npm run bench -- [--points=N] [--lines=N] [--polygons=N] [--layers=ol,webgl2,webgpu]
//        [--style=full|fill|stroke|simple] [--smooth (smoothFill, for --style=fill)] [--timeout=minutes] [--channel=msedge] [--headed]
import {writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {launchChromium} from '../test/browser.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v] = a.slice(2).split('=');
      return [k, v ?? 'true'];
    }),
);

// no HMR / file watching: editing sources must not reload the page mid-run
const server = await createServer({
  configFile: join(root, 'vite.config.ts'),
  logLevel: 'warn',
  server: {hmr: false, watch: null},
});
await server.listen();
const url = server.resolvedUrls.local[0];

const browser = await launchChromium({
  channel: args.channel,
  headed: args.headed === 'true',
  extraArgs: ['--js-flags=--max-old-space-size=8192 --expose-gc'],
});
const page = await browser.newPage({viewport: {width: 1100, height: 900}});
page.on('console', (m) => console.log('[page]', m.text()));
page.on('pageerror', (e) => console.error('[page error]', e));
let died = null;
page.on('crash', () => (died = 'page crashed (out of memory?)'));
page.on('close', () => (died ??= 'page closed'));

const query = new URLSearchParams();
for (const k of ['points', 'lines', 'polygons', 'layers', 'style', 'smooth']) {
  if (args[k]) {
    query.set(k, args[k]);
  }
}
await page.goto(`${url}bench.html?${query}`);

// Poll instead of waitForFunction: that never settles when the page crashes.
const timeoutMs = Number(args.timeout ?? 20) * 60_000;
const t0 = Date.now();
let results = null;
let partial = null;
while (!results) {
  if (died) {
    results = {...(partial ?? {}), error: died};
    break;
  }
  if (Date.now() - t0 > timeoutMs) {
    results = {...(partial ?? {}), error: `timed out after ${timeoutMs / 60_000} min`};
    break;
  }
  await new Promise((r) => setTimeout(r, 2000));
  try {
    [results, partial] = await Promise.race([
      page.evaluate(() => [window.__bench ?? null, window.__benchPartial ?? null]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('page unresponsive for 5 min')), 5 * 60_000)),
    ]);
  } catch (e) {
    died ??= String(e.message ?? e);
  }
}
if (results.error) {
  console.error(`\nbenchmark failed: ${results.error}`);
}
await browser.close().catch(() => {});
await server.close();

const file = join(root, 'bench', `results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify(results, null, 2));
console.log(`\nresults written to ${file}`);
if (results.error) {
  process.exitCode = 1;
}

