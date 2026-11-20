/// <reference lib="webworker" />
/**
 * ol-gpu worker: turns render instructions into GPU buffers and builds the
 * hit index, with the Rust/WASM core (JS fallback if wasm cannot load).
 */
import {type Core, loadCore} from '../wasm/core.js';
import {buildLinesJs, buildPointsJs, buildPolygonsJs} from './fallback.js';
import type {BufferSet, BuildRequest, BuildResponse, InitMessage, ReadyMessage} from './protocol.js';

declare const self: DedicatedWorkerGlobalScope;

let core: Core | null = null;
let resolveInit: (url: string) => void;
const initUrl = new Promise<string>((r) => (resolveInit = r));
const coreReady: Promise<void> = (async () => {
  try {
    // the main thread sends the wasm URL so bundlers resolve it once
    core = await loadCore(await initUrl);
    self.postMessage({type: 'ready', engine: 'wasm'} satisfies ReadyMessage);
  } catch (e) {
    core = null;
    self.postMessage({type: 'ready', engine: 'js', error: String(e)} satisfies ReadyMessage);
  }
})();

function transferables(set: BufferSet | null): ArrayBuffer[] {
  return set ? [set.indices.buffer as ArrayBuffer, set.vertices.buffer as ArrayBuffer, set.instances.buffer as ArrayBuffer] : [];
}

self.onmessage = async (event: MessageEvent<BuildRequest | InitMessage>) => {
  const req = event.data;
  if (req.type === 'init') {
    resolveInit(req.wasmUrl);
    return;
  }
  if (req.type !== 'build') {
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
    if (core) {
      const c = core;
      response.points = points && time('points', () => c.buildPoints(points, req.customSize));
      response.lines = lines && time('lines', () => c.buildLines(lines, req.customSize, invert));
      response.polygons = polygons && time('polygons', () => c.buildPolygons(polygons, req.customSize));
      if (req.indexTransform) {
        response.index = time('index', () =>
          c.buildIndex(points, lines, polygons, req.customSize, req.refOffset, req.indexTransform!),
        );
      }
    } else {
      response.points = points && time('points', () => buildPointsJs(points, req.customSize));
      response.lines = lines && time('lines', () => buildLinesJs(lines, req.customSize, invert));
      response.polygons = polygons && time('polygons', () => buildPolygonsJs(polygons, req.customSize));
    }
  } catch (e) {
    response.error = String((e as Error)?.stack ?? e);
  }
  self.postMessage(response, [
    ...transferables(response.points),
    ...transferables(response.lines),
    ...transferables(response.polygons),
    ...(response.index ? [response.index.buffer as ArrayBuffer] : []),
  ]);
};
