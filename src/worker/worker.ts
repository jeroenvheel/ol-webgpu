/// <reference lib="webworker" />
/**
 * ol-webgpu worker: turns render instructions into GPU buffers and builds the
 * hit index, with the Rust/WASM core (JS fallback if wasm cannot load).
 */
import {type Core, LARGE_MEMORY_BYTES, compileWasm, loadCore} from '../wasm/core.js';
import {buildLinesJs, buildPointsJs, buildPolygonsJs} from './fallback.js';
import type {BufferSet, BuildRequest, BuildResponse, InitMessage, ReadyMessage} from './protocol.js';

declare const self: DedicatedWorkerGlobalScope;

let core: Core | null = null;
let module: WebAssembly.Module | null = null;
let resolveInit: (url: string) => void;
const initUrl = new Promise<string>((r) => (resolveInit = r));
let coreReady: Promise<void> = (async () => {
  try {
    // the main thread sends the wasm URL so bundlers resolve it once
    module = await compileWasm(await initUrl);
    core = await loadCore(module);
    self.postMessage({type: 'ready', engine: 'wasm'} satisfies ReadyMessage);
  } catch (e) {
    core = null;
    self.postMessage({type: 'ready', engine: 'js', error: String(e)} satisfies ReadyMessage);
  }
})();

/** Milliseconds without a build after which a large instance is replaced. */
const IDLE = 5000;
let idleTimer = 0;

/**
 * The memory of a wasm instance only grows, so after the buffers of a
 * large layer were built it would stay that large for good. Nothing is
 * kept in it between builds: when no build came for a while, a large
 * instance makes way for a new one and its memory goes back to the system.
 */
function recycleWhenIdle() {
  clearTimeout(idleTimer);
  idleTimer = self.setTimeout(() => {
    if (core && module && core.memoryBytes > LARGE_MEMORY_BYTES) {
      const fresh = loadCore(module);
      coreReady = fresh.then(
        (c) => {
          core = c;
        },
        () => {}, // the instance on hand keeps working
      );
    }
  }, IDLE);
}

function transferables(set: BufferSet | null): ArrayBuffer[] {
  return set ? [set.indices.buffer as ArrayBuffer, set.vertices.buffer as ArrayBuffer, set.instances.buffer as ArrayBuffer] : [];
}

self.onmessage = async (event: MessageEvent<BuildRequest | InitMessage>) => {
  const req = event.data;
  if (req.type === 'init') {
    resolveInit(req.wasmUrl);
    return;
  }
  await coreReady;
  const timings: Record<string, number> = {};
  const time = <T>(name: string, fn: () => T): T => {
    const t0 = performance.now();
    const r = fn();
    timings[name] = performance.now() - t0;
    return r;
  };
  const points = req.points ? new Float32Array(req.points) : null;
  const lines = req.lines ? new Float32Array(req.lines) : null;
  const polygons = req.polygons ? new Float32Array(req.polygons) : null;
  const invert = req.invert as [number, number, number, number, number, number];

  const response: BuildResponse = {
    type: 'build',
    id: req.id,
    points: null,
    lines: null,
    polygons: null,
    index: null,
    engine: core ? 'wasm' : 'js',
    timings,
  };
  try {
    // the point instances are the point instructions, which go back as they came
    response.points = points && time('points', () => buildPointsJs(points, req.customSize));
    if (core) {
      const built = core.buildAll(points, lines, polygons, req.customSize, invert, req.indexTransform, req.refOffset, timings);
      response.lines = built.lines;
      response.polygons = built.polygons;
      response.index = built.index;
    } else {
      response.lines = lines && time('lines', () => buildLinesJs(lines, req.customSize, invert));
      response.polygons = polygons && time('polygons', () => buildPolygonsJs(polygons, req.customSize));
    }
  } catch (e) {
    response.error = String((e as Error)?.stack ?? e);
  }
  recycleWhenIdle();
  self.postMessage(response, [
    ...transferables(response.points),
    ...transferables(response.lines),
    ...transferables(response.polygons),
    ...(response.index ? [response.index.buffer as ArrayBuffer] : []),
  ]);
};
