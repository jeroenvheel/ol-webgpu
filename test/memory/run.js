// Looks for memory leaks: repeats what a layer does (test/rendering/memory.ts)
// and checks that nothing grows with the repetitions: the JS heap, the GL
// and WebGPU objects that are alive, and the maps, layers and features that
// are left after everything is disposed.
//
// Usage: npm run test:memory -- [--layers=webgl2,webgpu] [--cycles=12]
//        [--only=scenario,scenario] [--channel=msedge|chrome]
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

for (const layer of layers) {
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
  await page.goto(`${base}memory.html?layer=${layer}`, {waitUntil: 'networkidle'});
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
  const run = (name) => page.evaluate((n) => window.__memory.run(n), name);

  const start = await measure();
  console.log(`\n${layer}: ${cycles} cycles per scenario after ${WARM_UP} to warm up; empty page: heap ${mb(start.heap).trim()} MB`);
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
  const end = await measure();
  const left = [];
  for (const name of ['Feature', 'Map', 'Layer']) {
    left.push([name, await alive(name)]);
  }
  const leaked = left.some(([, count]) => count > 0) || end.renderers > 0 || end.canvases > 0 || end.glBuffers > 0 || end.gpuBuffers > 0;
  failures += leaked ? 1 : 0;
  console.log(
    `${leaked ? 'FAIL' : 'ok  '} after disposing everything: ${left.map(([name, count]) => `${count} ${name}`).join(', ')}, ${end.renderers} renderers, ${end.canvases} canvases, ` +
      `${end.glBuffers + end.gpuBuffers} buffers; heap ${mb(end.heap).trim()} MB, main wasm ${mb(end.wasm).trim()} MB`,
  );
  await page.close();
}

await browser.close();
await server.close();
console.log(`\n${failures} memory check${failures === 1 ? '' : 's'} failed`);
process.exitCode = failures ? 1 : 0;
