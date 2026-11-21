// Renders the synced upstream WebGLVector cases with ol's WebGLVector and the
// ol-webgpu layers, and compares each with upstream's expected.png (and the
// WebGL2 output with the WebGPU output).
//
// Usage: npm run test:rendering -- [--match=substring] [--layers=ol,webgl2,webgpu]
//        [--require-webgpu] [--channel=msedge|chrome] [--headed]
// Without a WebGPU adapter the WebGPU layer is skipped with a warning,
// unless --require-webgpu is given.
import {existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import pixelmatch from 'pixelmatch';
import {PNG} from 'pngjs';
import {createServer} from 'vite';
import {gpuInfo, launchChromium} from '../browser.js';

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
const KNOWN = {};

/**
 * Cases whose expected.png cannot be reproduced on another machine, so our
 * layers are compared with ol's WebGLVector rendered here instead. Text is
 * drawn by ol's text worker, which only sees fonts registered inside the
 * worker: upstream's @font-face 'Ubuntu' never reaches it, so the glyphs
 * come from whatever fallback font the machine has. Our layers run these
 * cases with `text: 'canvas'`, the same text worker; GPU text has its own
 * checks below.
 */
const COMPARE_WITH_OL = {
  'webgl-text-style': 'fonts differ per machine',
  'webgl-text-style-linestring': 'fonts differ per machine',
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
  optimizeDeps: {entries: ['harness.ts', 'cases/*/main.js', 'gputext.ts', 'labels.ts']},
  worker: {format: 'es'},
});
await server.listen();
const base = server.resolvedUrls.local[0];

// flags per platform: see test/browser.js (--channel=msedge|chrome to use an installed browser)
const browser = await launchChromium({channel: args.channel, headed: args.headed === 'true'});
const page = await browser.newPage({viewport: {width: 256, height: 256}, deviceScaleFactor: 1});
await page.goto(`${base}index.html`);
const gpu = await gpuInfo(page);
console.log(`WebGL: ${gpu.webgl}\nWebGPU: ${gpu.webgpu ?? 'no adapter'}\n`);
if (!gpu.webgpu && layers.includes('webgpu')) {
  if (args['require-webgpu'] === 'true') {
    console.error('no WebGPU adapter, but --require-webgpu was given');
    process.exit(1);
  }
  layers.splice(layers.indexOf('webgpu'), 1);
  const message = 'no WebGPU adapter in this browser: the WebGPU layer is skipped';
  console.log(process.env.GITHUB_ACTIONS ? `::warning::${message}` : `warning: ${message}`);
}
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
  // renders the case with a layer and judges the image
  const capture = async (layer) => {
    errors.length = 0;
    const rendered = new Promise((resolve) => (onRender = resolve));
    await page.goto(`${base}index.html?case=${name}&layer=${layer}${name in COMPARE_WITH_OL ? '&text=canvas' : ''}`, {waitUntil: 'networkidle'});
    const config = await Promise.race([rendered, new Promise((r) => setTimeout(() => r({timeout: true}), 30_000))]);
    try {
      await page.waitForFunction(() => window.__olgpuSettled?.(), null, {timeout: 30_000, polling: 50});
    } catch {
      errors.push('timed out waiting for ol-webgpu renderers');
    }
    if (name in COMPARE_WITH_OL) {
      // ol's layer has no readiness signal for its text overlay: give its worker time
      await page.waitForTimeout(500);
      if (layer === 'ol') {
        // On a slow machine that is not enough, and the reference would be
        // an image without text. The text shows as a change of the page:
        // wait for one (none within the time means the text was there
        // already), then until the page stays the same.
        let last = await page.screenshot();
        let changed = false;
        for (let waited = 0; waited < (changed ? 6000 : 3000); waited += 250) {
          await page.waitForTimeout(250);
          const now = await page.screenshot();
          const same = now.equals(last);
          last = now;
          if (!same) {
            changed = true;
          } else if (changed) {
            break;
          }
        }
      }
    }
    // let the map draw the final state
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const file = join(casesDir, name, `actual-${layer}.png`);
    await page.screenshot({path: file});
    row[layer] = {tolerance: config.tolerance ?? 0.005, errors: [...new Set(errors)].slice(0, 5)};
    judge(layer);
  };
  // compares the image of a layer with its reference: expected.png, or ol's image
  const judge = (layer) => {
    const r = row[layer];
    const reference = name in COMPARE_WITH_OL && layer !== 'ol' && row.ol ? readPng(join(casesDir, name, 'actual-ol.png')) : expected;
    r.mismatch = compare(readPng(join(casesDir, name, `actual-${layer}.png`)), reference, join(reportDir, `${name}-${layer}-diff.png`));
    r.pass = r.mismatch <= r.tolerance;
    r.reference = reference === expected ? 'expected' : 'ol';
  };
  for (const layer of layers) {
    await capture(layer);
  }
  // ol's layer sometimes never shows its text on the CI runner (its image is
  // then the same textless one every time). The ol-webgpu layers fail
  // against that through no fault of theirs: take ol's image again, and
  // judge the images they already made against it.
  const others = layers.filter((l) => l !== 'ol');
  for (let retry = 0; retry < 2 && name in COMPARE_WITH_OL && row.ol && others.some((l) => !row[l].pass); retry++) {
    await capture('ol');
    others.forEach(judge);
    row.retriedOl = retry + 1;
  }
  if (name in COMPARE_WITH_OL) {
    if (row.ol) {
      row.note = `${COMPARE_WITH_OL[name]}: ol vs expected.png is informative, webgl2/webgpu are checked against ol${row.retriedOl ? `; ol's image was taken ${row.retriedOl + 1} times` : ''}`;
    } else {
      row.known = `${COMPARE_WITH_OL[name]}; include --layers=ol to check against ol`;
    }
  }
  if (layers.includes('webgl2') && layers.includes('webgpu')) {
    row.webgl2VsWebgpu = compare(
      readPng(join(casesDir, name, 'actual-webgl2.png')),
      readPng(join(casesDir, name, 'actual-webgpu.png')),
      join(reportDir, `${name}-webgl2-vs-webgpu-diff.png`),
    );
  }
  results.push(row);
  const cell = (r) =>
    r ? `${r.pass ? 'ok  ' : 'FAIL'} ${(r.mismatch * 100).toFixed(2).padStart(6)}%${r.reference === 'ol' ? ' vs ol' : ''}` : '';
  console.log(
    `${name.padEnd(46)} ${layers.map((l) => `${l}: ${cell(row[l])}`).join('   ')}` +
      (row.webgl2VsWebgpu !== undefined ? `   gl2↔gpu ${(row.webgl2VsWebgpu * 100).toFixed(2)}%` : '') +
      (row.known ? `   (known: ${row.known})` : '') +
      (row.note ? `   (${row.note})` : ''),
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
  'point of a second layer': ['other'],
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

// --- text overlay while the view moves -------------------------------------
let textFailures = 0;
if (args.text !== 'false' && (!args.match || 'text'.includes(args.match) || args.match.includes('text'))) {
  console.log('\ntext overlay reprojected while panning (text.ts):');
  for (const layer of layers.filter((l) => l !== 'ol')) {
    for (const rotation of [0, 0.5]) {
      errors.length = 0;
      await page.goto(`${base}text.html?layer=${layer}&rotation=${rotation}`);
      let r = null;
      try {
        await page.waitForFunction(() => window.__textPan, null, {timeout: 30_000, polling: 50});
        r = await page.evaluate(() => window.__textPan);
      } catch {
        // reported below
      }
      // a few edge pixels may differ (linear filtering at the image border)
      const ok = r && r.textPixels > 500 && r.differing <= r.compared * 0.001;
      textFailures += ok ? 0 : 1;
      console.log(
        `  ${`${layer}, rotation ${rotation}`.padEnd(24)} ${ok ? 'ok  ' : 'FAIL'} ${r ? `${r.differing} of ${r.compared} pixels differ (${r.textPixels} drawn)` : `timed out ${errors.join(' | ').slice(0, 200)}`}`,
      );
    }
  }
}

// --- map export on rendercomplete, and clearing an emptied layer -------------
let exportFailures = 0;
if (args.export !== 'false' && (!args.match || 'export'.includes(args.match) || args.match.includes('export'))) {
  console.log('\nmap export on rendercomplete (export.ts):');
  // pixels of the screenshot that are not the white map background
  const coloured = (png) => {
    let n = 0;
    for (let i = 0; i < png.data.length; i += 4) {
      n += png.data[i] < 250 || png.data[i + 1] < 250 || png.data[i + 2] < 250 ? 1 : 0;
    }
    return n;
  };
  for (const layer of layers.filter((l) => l !== 'ol')) {
    errors.length = 0;
    await page.goto(`${base}export.html?layer=${layer}`);
    let r = null;
    let shown = -1;
    let cleared = -1;
    try {
      await page.waitForFunction(() => window.__export, null, {timeout: 30_000, polling: 50});
      r = await page.evaluate(() => window.__export);
      shown = coloured(PNG.sync.read(await page.screenshot()));
      await page.evaluate(() => window.__clearExport());
      cleared = coloured(PNG.sync.read(await page.screenshot()));
    } catch {
      // reported below
    }
    // a 120 x 120 px square
    const ok = r && r.drawn > 14_000 && r.empty === 0 && shown > 14_000 && cleared === 0;
    exportFailures += ok ? 0 : 1;
    console.log(
      `  ${layer.padEnd(24)} ${ok ? 'ok  ' : 'FAIL'} ${r ? `exported ${r.drawn} px (empty layer ${r.empty}), shown ${shown} px, ${cleared} px after clearing` : `timed out ${errors.join(' | ').slice(0, 200)}`}`,
    );
  }
}

// --- shared canvases: grouping, order and layer opacity ----------------------
let sharedFailures = 0;
if (args.shared !== 'false' && (!args.match || 'shared'.includes(args.match) || args.match.includes('shared'))) {
  console.log('\nshared canvases (shared.ts), compared with ol:');
  const shots = {};
  const runs = ['ol', ...layers.filter((l) => l !== 'ol').flatMap((l) => [l, `${l}&antialias=1`])];
  for (const run of runs) {
    errors.length = 0;
    await page.goto(`${base}shared.html?layer=${run}`);
    const name = run.replace('&antialias=1', ', antialias');
    let r = null;
    try {
      await page.waitForFunction(() => window.__shared, null, {timeout: 30_000, polling: 50});
      r = await page.evaluate(() => window.__shared);
      shots[run] = PNG.sync.read(await page.screenshot({path: join(reportDir, `shared-${name.replace(', ', '-')}.png`)}));
    } catch {
      // reported below
    }
    const problems = errors.filter((e) => !e.includes('powerPreference')).join(' | ').slice(0, 300);
    if (run === 'ol') {
      console.log(`  ${'ol'.padEnd(24)} reference, ${r ? `${r.canvases} canvases (${r.elements.join(', ')})` : 'timed out'} ${problems}`);
      continue;
    }
    const mismatch = shots.ol && shots[run] ? compare(shots[run], shots.ol, join(reportDir, `shared-${name.replace(', ', '-')}-diff.png`)) : 1;
    // layers 1+2 share a canvas, ol's canvas layer, then layer 4; multisampled edges differ from ol a little
    const tolerance = run.includes('antialias') ? 0.02 : 0.001;
    const ok = r && r.canvases === 3 && r.elements.join() === 'canvas,div,canvas' && mismatch <= tolerance && !problems;
    sharedFailures += ok ? 0 : 1;
    console.log(
      `  ${name.padEnd(24)} ${ok ? 'ok  ' : 'FAIL'} ${r ? `${r.canvases} canvases (${r.elements.join(', ')}), ${(mismatch * 100).toFixed(2)}% differ from ol` : 'timed out'} ${problems}`,
    );
  }
}

// --- GPU text against ol's Canvas vector layer --------------------------------
/**
 * Scenarios of gputext.ts with the share of pixels that may differ from the
 * Canvas layer. Upright text is placed and drawn like Canvas does, pixel
 * for pixel; rotated text and text along lines is resampled a little
 * differently, and Canvas resamples upright labels in a rotated view
 * ('styles') where GPU text keeps them sharp.
 */
const GPU_TEXT = {
  styles: 0.035,
  multiline: 0.002,
  overlap: 0.002,
  line: 0.025,
  lineRotated: 0.025,
  polygon: 0.002,
  declutter: 0.002,
  wrap: 0.002,
  webfont: 0.002,
  scripts: 0.002,
};
let gpuTextFailures = 0;
if (args.gputext !== 'false' && (!args.match || 'gputext'.includes(args.match) || args.match.includes('gputext'))) {
  console.log('\nGPU text (gputext.ts), compared with ol/layer/Vector (Canvas):');
  for (const pixelRatio of [1, 2]) {
    const textPage = pixelRatio === 1 ? page : await browser.newPage({viewport: {width: 256, height: 256}, deviceScaleFactor: pixelRatio});
    const pageErrors = [];
    if (textPage !== page) {
      textPage.on('pageerror', (e) => pageErrors.push(String(e)));
    }
    for (const [name, tolerance] of Object.entries(GPU_TEXT)) {
      const shots = {};
      const problems = {};
      for (const layer of ['canvas', ...layers.filter((l) => l !== 'ol')]) {
        errors.length = 0;
        pageErrors.length = 0;
        await textPage.goto(`${base}gputext.html?layer=${layer}&scenario=${name}`);
        try {
          await textPage.waitForFunction(() => window.__gpuText, null, {timeout: 30_000, polling: 50});
          shots[layer] = PNG.sync.read(await textPage.screenshot({path: join(reportDir, `gputext-${name}-${pixelRatio}x-${layer}.png`)}));
        } catch {
          // reported below
        }
        problems[layer] = [...errors, ...pageErrors].filter((e) => !e.includes('powerPreference')).join(' | ').slice(0, 200);
      }
      const cells = layers
        .filter((l) => l !== 'ol')
        .map((layer) => {
          const mismatch = shots.canvas && shots[layer] ? compare(shots[layer], shots.canvas, join(reportDir, `gputext-${name}-${pixelRatio}x-${layer}-diff.png`)) : 1;
          const ok = mismatch <= tolerance && !problems[layer];
          gpuTextFailures += ok ? 0 : 1;
          return `${layer}: ${ok ? 'ok  ' : 'FAIL'} ${(mismatch * 100).toFixed(2).padStart(6)}% ${problems[layer]}`;
        });
      console.log(`  ${`${name}, ${pixelRatio}x`.padEnd(24)} ${cells.join('   ')}`);
    }
    if (textPage !== page) {
      await textPage.close();
    }
  }

  console.log('\nGPU text when the view, style and data change (labels.ts):');
  const checks = {};
  for (const layer of layers.filter((l) => l !== 'ol')) {
    errors.length = 0;
    await page.goto(`${base}labels.html?layer=${layer}`);
    try {
      await page.waitForFunction(() => window.__labels, null, {timeout: 60_000, polling: 50});
      checks[layer] = await page.evaluate(() => window.__labels);
    } catch {
      checks[layer] = {'page finished': {ok: false, detail: errors.join(' | ').slice(0, 300)}};
    }
  }
  const checkNames = [...new Set(Object.values(checks).flatMap((c) => Object.keys(c)))];
  for (const name of checkNames) {
    const cells = Object.entries(checks).map(([layer, c]) => {
      const r = c[name];
      gpuTextFailures += r?.ok ? 0 : 1;
      return `${layer}: ${r?.ok ? 'ok' : `FAIL ${r?.detail ?? 'missing'}`}`;
    });
    console.log(`  ${name.padEnd(40)} ${cells.join('   ')}`);
  }
  results.push({gpuText: checks});
}

await browser.close();
await server.close();
writeFileSync(join(reportDir, 'results.json'), JSON.stringify(results, null, 2));

const failures = results.filter((r) => r.case && !r.known && ['webgl2', 'webgpu'].some((l) => r[l] && !r[l].pass));
console.log(
  `\n${results.filter((r) => r.case).length} cases, ${failures.length} unexpected rendering failures, ${pickFailures} hit detection failures, ${textFailures} text overlay failures, ${exportFailures} export failures, ${sharedFailures} shared canvas failures, ${gpuTextFailures} GPU text failures (report: ${reportDir})`,
);
process.exitCode = failures.length || pickFailures || textFailures || exportFailures || sharedFailures || gpuTextFailures ? 1 : 0;
