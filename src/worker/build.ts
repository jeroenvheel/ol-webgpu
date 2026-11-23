/**
 * One build: render instructions in, GPU buffers and the hit index out.
 * Runs in the worker, and on the main thread when the worker is unavailable.
 */
import type {Core} from '../wasm/core.js';
import {buildLinesJs, buildPointsJs, buildPolygonsJs} from './fallback.js';
import type {BufferSet, BuildRequest, BuildResponse} from './protocol.js';

function transferables(set: BufferSet | null): ArrayBuffer[] {
  return set ? [set.indices.buffer as ArrayBuffer, set.vertices.buffer as ArrayBuffer, set.instances.buffer as ArrayBuffer] : [];
}

/** The buffers of a response, for `postMessage`. */
export function responseTransferables(response: BuildResponse): ArrayBuffer[] {
  return [
    ...transferables(response.points),
    ...transferables(response.lines),
    ...transferables(response.polygons),
    ...(response.index ? [response.index.buffer as ArrayBuffer] : []),
  ];
}

/**
 * @param core the wasm core, or null to build with ol's JS code (no hit index then)
 * @return the response; a failed build has `error` set
 */
export function runBuild(req: BuildRequest, core: Core | null): BuildResponse {
  const timings: Record<string, number> = {};
  const time = <T>(name: string, fn: () => T): T => {
    const t0 = performance.now();
    const r = fn();
    timings[name] = performance.now() - t0;
    return r;
  };
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
    const points = req.points ? new Float32Array(req.points) : null;
    const lines = req.lines ? new Float32Array(req.lines) : null;
    const polygons = req.polygons ? new Float32Array(req.polygons) : null;
    const invert = req.invert as [number, number, number, number, number, number];
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
  return response;
}
