// Looks for memory leaks: repeats what a layer does (test/rendering/memory.ts)
// and checks that nothing grows with the repetitions: the JS heap, the GL
// and WebGPU objects that are alive, and the maps, layers and features that
// are left after everything is disposed.
//
// Each scenario runs with ol/Feature and with RenderFeatures (ol/render/Feature,
// as vector tile formats read them).
//
// Usage: npm run test:memory -- [--layers=webgl2,webgpu] [--cycles=12]
//        [--features=feature,render] [--only=scenario,scenario] [--channel=msedge|chrome]
//        npm run test:memory -- --big [--layers=...] [--features=...]
// --big measures one big layer step by step instead (300k points, 200k lines,
// 50k polygons): the features alone, the drawn layer, rebuilds, and what is
// left after disposing, with each kind of feature side by side.
// On Windows the private memory of the browser's renderer and GPU processes
// is printed too: wasm memory, array buffers and workers are not in the heap.
import {execFileSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {launchChromium} from '../browser.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v] = a.slice(2).split('=');
      return [k, v ?? 'true'];
    }),
);
const layers = (args.layers ?? 'webgl2,webgpu').split(',');
const cycles = Number(args.cycles ?? 12);
const kinds = (args.features ?? 'feature,render').split(',');
/** Cycles before the first measurement: caches fill and code is compiled. */
const WARM_UP = 3;
/** Heap growth per cycle above this fails a scenario (leaked features or buffers are far more). */
const MAX_HEAP_PER_CYCLE = 100 * 1024;

const server = await createServer({
  configFile: false,
  root: join(root, 'test', 'rendering'),
  logLevel: 'error',
  worker: {format: 'es'},
  server: {hmr: false, watch: null, port: 5183, strictPort: false, fs: {allow: [root]}},
});
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await launchChromium({channel: args.channel, extraArgs: ['--js-flags=--expose-gc', '--enable-precise-memory-info']});

/** Runs in the page before its scripts: counts what is alive by wrapping what creates and deletes it. */
function counters() {
  const c = (window.__counts = {gpuBuffers: 0, gpuBufferBytes: 0, gpuTextures: 0, glBuffers: 0, glTextures: 0, glPrograms: 0, glVaos: 0, glFramebuffers: 0, workers: 0});
  const wrap = (proto, create, destroy, key) => {
    if (!proto) {
      return;
    }
    const make = proto[create];
    proto[create] = function (...a) {
      const r = make.apply(this, a);
      if (r) {
        c[key]++;
      }
      return r;
    };
    const kill = proto[destroy];
    proto[destroy] = function (o, ...a) {
      if (o) {
        c[key]--;
      }
      return kill.call(this, o, ...a);
    };
  };
  const gl = window.WebGL2RenderingContext?.prototype;
  wrap(gl, 'createBuffer', 'deleteBuffer', 'glBuffers');
  wrap(gl, 'createTexture', 'deleteTexture', 'glTextures');
  wrap(gl, 'createProgram', 'deleteProgram', 'glPrograms');
  wrap(gl, 'createVertexArray', 'deleteVertexArray', 'glVaos');
  wrap(gl, 'createFramebuffer', 'deleteFramebuffer', 'glFramebuffers');
  if (window.GPUDevice) {
    const track = (create, count, bytes) => {
      const make = GPUDevice.prototype[create];
      GPUDevice.prototype[create] = function (descriptor) {
        const object = make.call(this, descriptor);
        const size = bytes ? descriptor.size : 0;
        c[count]++;
        c.gpuBufferBytes += size;
        const destroy = object.destroy.bind(object);
        let dead = false;
        object.destroy = () => {
          if (!dead) {
            dead = true;
            c[count]--;
            c.gpuBufferBytes -= size;
          }
          destroy();
        };
        return object;
      };
    };
    track('createBuffer', 'gpuBuffers', true);
    track('createTexture', 'gpuTextures', false);
  }
  const W = window.Worker;
  window.Worker = class extends W {
    constructor(...a) {
      super(...a);
      c.workers++;
    }
    terminate() {
      c.workers--;
      super.terminate();
    }
  };
  const memories = [];
  const instantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = async function (...a) {
    const r = await instantiate.apply(this, a);
    const instance = r.instance ?? r;
    if (instance.exports?.memory) {
      memories.push(new WeakRef(instance.exports.memory));
    }
    return r;
  };
  // of the main thread; the worker's is not visible from here
  window.__wasmBytes = () => memories.reduce((sum, m) => sum + (m.deref()?.buffer.byteLength ?? 0), 0);
}

const system = await browser.newBrowserCDPSession();
/** Private memory of the browser's renderer and GPU processes (Windows only, else zeros). */
async function processes() {
  if (process.platform !== 'win32') {
    return {renderer: 0, gpu: 0};
  }
  const {processInfo} = await system.send('SystemInfo.getProcessInfo');
  const ids = processInfo.filter((p) => p.type === 'renderer' || p.type === 'GPU');
  const out = execFileSync(
    'powershell',
    ['-NoProfile', '-Command', `Get-Process -Id ${ids.map((p) => p.id).join(',')} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.PrivateMemorySize64)" }`],
    {encoding: 'utf8'},
  );
  const bytes = Object.fromEntries(
    out
      .trim()
      .split('\n')
      .map((line) => line.trim().split(' ').map(Number)),
  );
  const sum = (type) => ids.filter((p) => p.type === type).reduce((s, p) => s + (bytes[p.id] ?? 0), 0);
  return {renderer: sum('renderer'), gpu: sum('GPU')};
}

const mb = (n) => (n / 1048576).toFixed(1).padStart(7);
const LIVE = ['gpuBuffers', 'gpuTextures', 'glBuffers', 'glTextures', 'glPrograms', 'glVaos', 'glFramebuffers', 'workers', 'renderers', 'canvases'];
let failures = 0;

/** Opens the memory page for a layer and a kind of feature, with what the checks need to measure it. */
async function openPage(layer, kind) {
  const page = await browser.newPage({viewport: {width: 600, height: 450}});
  page.on('pageerror', (e) => {
    failures++;
    console.log('  page error:', String(e).slice(0, 300));
  });
  page.on('console', (m) => {
    if (m.type() === 'error' || /CONTEXT_LOST/.test(m.text())) {
      failures++;
      console.log('  console:', m.text().slice(0, 300));
    }
  });
  await page.addInitScript(counters);
  await page.goto(`${base}memory.html?layer=${layer}&features=${kind}`, {waitUntil: 'networkidle'});
  await page.waitForFunction(() => window.__memory);

  const measure = async () => ({
    ...(await page.evaluate(async () => {
      for (let i = 0; i < 3; i++) {
        window.gc();
        await new Promise((r) => setTimeout(r, 60));
      }
      return {heap: performance.memory.usedJSHeapSize, wasm: window.__wasmBytes(), ...window.__counts, ...window.__memory.live()};
    })),
    ...(await processes()),
  });
  const cdp = await page.context().newCDPSession(page);
  /** Instances of a class that are still alive. */
  const alive = async (name) => {
    const proto = await cdp.send('Runtime.evaluate', {expression: `window.__memory.classes.${name}.prototype`});
    const {objects} = await cdp.send('Runtime.queryObjects', {prototypeObjectId: proto.result.objectId});
    const {result} = await cdp.send('Runtime.callFunctionOn', {objectId: objects.objectId, functionDeclaration: 'function () { return this.length; }', returnByValue: true});
    return result.value;
  };
  // ol keeps one RenderFeature of its own (`textFeature` in ol/render/webgl/textUtil.js):
  // instances are counted against what is alive on the page before any scenario
  const CLASSES = ['Feature', 'RenderFeature', 'Map', 'Layer'];
  const baseline = {};
  for (const name of CLASSES) {
    baseline[name] = await alive(name);
  }
  /** What of the library and of ol is still alive beyond the page's own; after disposing everything all must be 0. */
  const leftovers = async () => {
    const end = await measure();
    const left = [];
    for (const name of CLASSES) {
      left.push([name, (await alive(name)) - baseline[name]]);
    }
    const leaked = left.some(([, count]) => count > 0) || end.renderers > 0 || end.canvases > 0 || end.glBuffers > 0 || end.gpuBuffers > 0;
    const text =
      `${left.map(([name, count]) => `${count} ${name}`).join(', ')}, ${end.renderers} renderers, ${end.canvases} canvases, ` +
      `${end.glBuffers + end.gpuBuffers} buffers; heap ${mb(end.heap).trim()} MB, main wasm ${mb(end.wasm).trim()} MB`;
    return {leaked, text: `${text}${Object.values(baseline).some(Boolean) ? ` (not counted, alive on the empty page: ${CLASSES.filter((n) => baseline[n]).map((n) => `${baseline[n]} ${n}`).join(', ')})` : ''}`};
  };
  return {page, measure, leftovers};
}

/** Repeats each scenario and checks that nothing grows; then that nothing is left. */
async function leakChecks(layer, kind) {
  const {page, measure, leftovers} = await openPage(layer, kind);
  const run = (name) => page.evaluate((n) => window.__memory.run(n), name);

  const start = await measure();
  console.log(`\n${layer}, ${kind === 'render' ? 'RenderFeatures' : 'ol/Feature'}: ${cycles} cycles per scenario after ${WARM_UP} to warm up; empty page: heap ${mb(start.heap).trim()} MB`);
  console.log('     scenario              heap MB before -> after   per cycle | renderer process MB | GPU process MB   | main wasm MB | alive after (change)');
  const names = (await page.evaluate(() => window.__memory.names)).filter((n) => !args.only || args.only.split(',').includes(n));
  for (const name of names) {
    for (let i = 0; i < WARM_UP; i++) {
      await run(name);
    }
    const before = await measure();
    for (let i = 0; i < cycles; i++) {
      await run(name);
    }
    const after = await measure();
    const perCycle = (after.heap - before.heap) / cycles;
    // what the scenario's own map needs stays alive; it must not multiply
    const grown = LIVE.filter((k) => after[k] > before[k]);
    const bad = perCycle > MAX_HEAP_PER_CYCLE || grown.length > 0;
    failures += bad ? 1 : 0;
    const live = LIVE.filter((k) => after[k] || before[k])
      .map((k) => `${k} ${after[k]}${after[k] !== before[k] ? ` (${after[k] > before[k] ? '+' : ''}${after[k] - before[k]})` : ''}`)
      .join(', ');
    console.log(
      `${bad ? 'FAIL' : 'ok  '} ${name.padEnd(20)} ${mb(before.heap)} -> ${mb(after.heap)}  ${(perCycle / 1024).toFixed(0).padStart(6)} KB | ${mb(before.renderer)} -> ${mb(after.renderer)}  | ${mb(before.gpu)} -> ${mb(after.gpu)} | ${mb(after.wasm)}      | ${live}`,
    );
  }

  await page.evaluate(() => window.__memory.end());
  const {leaked, text} = await leftovers();
  failures += leaked ? 1 : 0;
  console.log(`${leaked ? 'FAIL' : 'ok  '} after disposing everything: ${text}`);
  await page.close();
}

/** The big layer step by step: memory after each step, for the table of each kind side by side. */
async function bigLayer(layer, kind) {
  const {page, measure, leftovers} = await openPage(layer, kind);
  const rows = [['empty page', await measure(), 0]];
  const step = async (label, name) => {
    const t0 = performance.now();
    await page.evaluate((n) => window.__memory.big(n), name);
    const ms = performance.now() - t0;
    rows.push([label, await measure(), ms]);
  };
  await step('features made', 'features');
  await step('layer drawn', 'map');
  for (let i = 1; i <= 4; i++) {
    await step(`rebuild ${i} (pan)`, 'pan');
  }
  await step('map disposed', 'dispose');
  await step('features dropped', 'drop');
  const {leaked, text} = await leftovers();
  failures += leaked ? 1 : 0;
  await page.close();
  return {rows, leaked, text};
}

if (args.big === 'true') {
  console.log('Big layer: 300k points, 200k lines, 50k polygons. MB after each step (heap | renderer process | GPU process), and the time of the step.');
  for (const layer of layers) {
    const results = {};
    for (const kind of kinds) {
      results[kind] = await bigLayer(layer, kind);
    }
    console.log(`\n${layer}`);
    console.log(`  ${'step'.padEnd(20)} ${kinds.map((k) => (k === 'render' ? 'RenderFeature' : 'ol/Feature').padEnd(42)).join(' ')}`);
    const steps = results[kinds[0]].rows.map(([label]) => label);
    steps.forEach((label, i) => {
      const cells = kinds.map((k) => {
        const [, m, ms] = results[k].rows[i];
        return `${mb(m.heap)} | ${mb(m.renderer)} | ${mb(m.gpu)}  ${ms ? `${(ms / 1000).toFixed(1).padStart(5)} s` : '       '}`;
      });
      console.log(`  ${label.padEnd(20)} ${cells.join('   ')}`);
    });
    for (const kind of kinds) {
      const r = results[kind];
      console.log(`${r.leaked ? 'FAIL' : 'ok  '} ${kind === 'render' ? 'RenderFeature' : 'ol/Feature'}, after disposing everything: ${r.text}`);
    }
  }
} else {
  for (const layer of layers) {
    for (const kind of kinds) {
      await leakChecks(layer, kind);
    }
  }
}

await browser.close();
await server.close();
console.log(`\n${failures} memory check${failures === 1 ? '' : 's'} failed`);
process.exitCode = failures ? 1 : 0;
