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
    ...transferables(response.edges ?? null),
    ...(response.index ? [response.index.buffer as ArrayBuffer] : []),
  ];
}

/**
 * The rings of polygons as line instructions, for the soft edge of fills:
 * `[custom.., rings, count per ring.., (x, y)..]` per polygon becomes
 * `[custom.., count, (x, y, 0)..]` per ring. Every ring has the fill on its
 * left: outer rings (the first of a polygon) go counterclockwise, holes
 * clockwise, turned around when they come the other way.
 */
export function edgeInstructions(polygons: Float32Array, customSize: number): Float32Array {
  const out = new Float32Array(Math.ceil(polygons.length * 1.5) + 16);
  let at = 0;
  let i = 0;
  const n = polygons.length;
  while (i + customSize < n) {
    const custom = i;
    const rings = polygons[i + customSize];
    let counts = i + customSize + 1;
    let coords = counts + rings;
    if (!(rings >= 0) || coords > n) {
      break;
    }
    for (let r = 0; r < rings; r++, counts++) {
      const count = polygons[counts];
      const end = coords + count * 2;
      if (!(count >= 0) || end > n) {
        return out.subarray(0, at);
      }
      // twice the area, positive for a counterclockwise ring
      let area = 0;
      for (let k = coords, j = end - 2; k < end; j = k, k += 2) {
        area += polygons[j] * polygons[k + 1] - polygons[k] * polygons[j + 1];
      }
      const forward = area >= 0 === (r === 0);
      for (let c = 0; c < customSize; c++) {
        out[at++] = polygons[custom + c];
      }
      out[at++] = count;
      for (let k = 0; k < count; k++) {
        const p = forward ? coords + k * 2 : end - 2 - k * 2;
        out[at++] = polygons[p];
        out[at++] = polygons[p + 1];
        out[at++] = 0;
      }
      coords = end;
    }
    i = coords;
  }
  return out.subarray(0, at);
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
      if (req.edges && polygons) {
        response.edges = time('edges', () => core.buildLines(edgeInstructions(polygons, req.customSize), req.customSize, invert));
      }
    } else {
      if (req.edges && polygons) {
        response.edges = time('edges', () => buildLinesJs(edgeInstructions(polygons, req.customSize), req.customSize, invert));
      }
      response.lines = lines && time('lines', () => buildLinesJs(lines, req.customSize, invert));
      response.polygons = polygons && time('polygons', () => buildPolygonsJs(polygons, req.customSize));
    }
  } catch (e) {
    response.error = String((e as Error)?.stack ?? e);
  }
  return response;
}
