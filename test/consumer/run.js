// Builds test/consumer (an app importing the built dist/) for production,
// serves it and checks in Chromium that both backends render and pick, and
// that GpuVectorLayer falls back to WebGL2 when no WebGPU adapter is found.
// Requires `npm run build` first.
import {existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {build, preview} from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
if (!existsSync(join(here, '../../dist/index.js'))) {
  console.error('dist/index.js not found: run `npm run build` first');
  process.exit(1);
}
const configFile = join(here, 'vite.config.ts');
await build({configFile});
const server = await preview({configFile, preview: {port: 5182, strictPort: true}});
const url = server.resolvedUrls.local[0];

const browser = await chromium.launch({
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--disable-dawn-features=use_dxc'],
});
const cases = [
  ['auto', 'webgpu'],
  ['webgl2', 'webgl2'],
  ['fallback', 'webgl2'],
];
let failures = 0;
for (const [name, expectedBackend] of cases) {
  const page = await browser.newPage({viewport: {width: 200, height: 200}});
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => (m.type() === 'error' ? errors.push(m.text()) : m.type() === 'warning' && console.log(`     [${name}] ${m.text()}`)));
  await page.goto(`${url}?case=${name}`);
  let result;
  try {
    await page.waitForFunction(() => window.__result, null, {timeout: 30_000});
    result = await page.evaluate(() => window.__result);
  } catch (e) {
    result = {error: String(e.message ?? e)};
  }
  const ok =
    !result.error &&
    result.backend === expectedBackend &&
    result.pixel[0] > 200 &&
    result.pixel[1] < 50 &&
    result.picked?.[0] === 'dot' &&
    result.labelPixels > 20 &&
    errors.length === 0;
  failures += ok ? 0 : 1;
  if (!ok) {
    const shot = join(here, 'dist', `failed-${name}.png`);
    await page.screenshot({path: shot});
    console.log(`     screenshot: ${shot}`);
  }
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(9)} ${JSON.stringify(result)}${errors.length ? `  errors: ${errors.join(' | ')}` : ''}`);
  await page.close();
}
await browser.close();
await server.close();
console.log(failures ? `${failures} failure(s)` : 'dist works in a production consumer build');
process.exitCode = failures ? 1 : 0;
