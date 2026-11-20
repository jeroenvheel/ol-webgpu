// Renders the synced upstream WebGLVector cases with ol's WebGLVector and the
// ol-gpu layers, and compares each with upstream's expected.png (and the
// WebGL2 output with the WebGPU output).
//
// Usage: npm run test:rendering -- [--match=substring] [--layers=ol,webgl2,webgpu] [--headed]
import {existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import pixelmatch from 'pixelmatch';
import {chromium} from 'playwright';
import {PNG} from 'pngjs';
import {createServer} from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v] = a.slice(2).split('=');
      return [k, v ?? 'true'];
    }),
);

/**
 * Cases our layers are not expected to pass yet, with the reason. They are
 * still rendered and reported, but do not fail the run.
 */
const KNOWN = {
  'webgl-text-style': 'text styles are not supported yet',
  'webgl-text-style-linestring': 'text styles are not supported yet',
};

const casesDir = join(here, 'cases');
if (!existsSync(join(here, 'data'))) {
  console.error('test data missing: run `npm run sync-upstream-tests` first');
  process.exit(1);
}
const cases = readdirSync(casesDir, {withFileTypes: true})
  .filter((d) => d.isDirectory() && (!args.match || d.name.includes(args.match)))
  .map((d) => d.name);
const layers = (args.layers ?? 'ol,webgl2,webgpu').split(',');
const reportDir = join(here, 'report');
mkdirSync(reportDir, {recursive: true});

const server = await createServer({
  configFile: false,
  root: here,
  logLevel: 'warn',
  server: {port: 5181, strictPort: false, fs: {allow: [root]}},
  optimizeDeps: {entries: ['harness.ts', 'cases/*/main.js']},
  worker: {format: 'es'},
});
await server.listen();
const base = server.resolvedUrls.local[0];

// Playwright's bundled Chromium on Windows ships without dxcompiler.dll, so
// WebGPU device creation fails unless Dawn falls back to FXC. Use
// --channel=msedge or --channel=chrome to test with an installed browser.
const browser = await chromium.launch({
  headless: args.headed !== 'true',
  channel: args.channel,
  args: [
    '--enable-unsafe-webgpu',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--use-angle=d3d11',
    ...(args.channel ? [] : ['--disable-dawn-features=use_dxc']),
  ],
});
const page = await browser.newPage({viewport: {width: 256, height: 256}, deviceScaleFactor: 1});
let onRender = null;
await page.exposeFunction('render', (config) => onRender?.(config ?? {}));
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') {
    errors.push(m.text());
  }
});

function readPng(file) {
  return PNG.sync.read(readFileSync(file));
}

function compare(a, b, diffFile) {
  const {width, height} = b;
  if (a.width !== width || a.height !== height) {
    return 1;
  }
  const diff = new PNG({width, height});
  const count = pixelmatch(a.data, b.data, diff.data, width, height);
  if (diffFile && count) {
    writeFileSync(diffFile, PNG.sync.write(diff));
  }
  return count / (width * height);
}

const results = [];
for (const name of cases) {
  const expected = readPng(join(casesDir, name, 'expected.png'));
  const row = {case: name, known: KNOWN[name]};
  for (const layer of layers) {
    errors.length = 0;
    const rendered = new Promise((resolve) => (onRender = resolve));
    await page.goto(`${base}index.html?case=${name}&layer=${layer}`, {waitUntil: 'networkidle'});
    const config = await Promise.race([rendered, new Promise((r) => setTimeout(() => r({timeout: true}), 30_000))]);
    try {
      await page.waitForFunction(() => window.__olgpuSettled?.(), null, {timeout: 30_000, polling: 50});
    } catch {
      errors.push('timed out waiting for ol-gpu renderers');
    }
    // let the map draw the final state
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const file = join(casesDir, name, `actual-${layer}.png`);
    await page.screenshot({path: file});
    const tolerance = config.tolerance ?? 0.005;
    const mismatch = compare(readPng(file), expected, join(reportDir, `${name}-${layer}-diff.png`));
    row[layer] = {mismatch, tolerance, pass: mismatch <= tolerance, errors: [...new Set(errors)].slice(0, 5)};
  }
  if (layers.includes('webgl2') && layers.includes('webgpu')) {
    row.webgl2VsWebgpu = compare(
      readPng(join(casesDir, name, 'actual-webgl2.png')),
      readPng(join(casesDir, name, 'actual-webgpu.png')),
      join(reportDir, `${name}-webgl2-vs-webgpu-diff.png`),
    );
  }
  results.push(row);
  const cell = (r) => (r ? `${r.pass ? 'ok  ' : 'FAIL'} ${(r.mismatch * 100).toFixed(2).padStart(6)}%` : '');
  console.log(
    `${name.padEnd(46)} ${layers.map((l) => `${l}: ${cell(row[l])}`).join('   ')}` +
      (row.webgl2VsWebgpu !== undefined ? `   gl2↔gpu ${(row.webgl2VsWebgpu * 100).toFixed(2)}%` : '') +
      (row.known ? `   (known: ${row.known})` : ''),
  );
  for (const l of layers) {
    for (const e of row[l].errors) {
      console.log(`    [${l}] ${e.slice(0, 300)}`);
    }
  }
}

// --- hit detection -------------------------------------------------------
const EXPECTED_PICKS = {
  'point center': ['point'],
  'point inside radius (8px)': ['point'],
  'point outside radius (13px)': [],
  'point outside, within hitTolerance 5': ['point'],
  'polygon fill': ['poly'],
  'polygon hole': [],
  'line on axis': ['line'],
  'line within half width (2px)': ['line'],
  'line outside half width (5px)': [],
  'filtered-out feature': [],
  'empty space': [],
  'big point overlapping polygon edge': ['big'],
  'rotated view: point': ['point'],
  'panned view: point': ['point'],
};
let pickFailures = 0;
if (args.picking !== 'false' && !args.match) {
  console.log('\nhit detection (forEachFeatureAtPixel):');
  const picks = {};
  for (const layer of layers) {
    errors.length = 0;
    await page.goto(`${base}picking.html?layer=${layer}`);
    try {
      await page.waitForFunction(() => window.__pick, null, {timeout: 30_000, polling: 50});
      picks[layer] = await page.evaluate(() => window.__pick);
    } catch {
      picks[layer] = null;
      console.log(`  [${layer}] timed out ${errors.join(' | ').slice(0, 300)}`);
    }
  }
  for (const [name, expected] of Object.entries(EXPECTED_PICKS)) {
    const cells = layers.map((l) => {
      const got = picks[l]?.[name];
      const ok = JSON.stringify(got) === JSON.stringify(expected);
      if (!ok && l !== 'ol') {
        pickFailures++;
      }
      return `${l}: ${ok ? 'ok  ' : 'FAIL'} ${JSON.stringify(got ?? null)}`.padEnd(28);
    });
    console.log(`  ${name.padEnd(40)} expected ${JSON.stringify(expected).padEnd(10)} ${cells.join(' ')}`);
  }
  results.push({picking: picks});
}

await browser.close();
await server.close();
writeFileSync(join(reportDir, 'results.json'), JSON.stringify(results, null, 2));

const failures = results.filter((r) => r.case && !r.known && ['webgl2', 'webgpu'].some((l) => r[l] && !r[l].pass));
console.log(
  `\n${results.filter((r) => r.case).length} cases, ${failures.length} unexpected rendering failures, ${pickFailures} hit detection failures (report: ${reportDir})`,
);
process.exitCode = failures.length || pickFailures ? 1 : 0;
