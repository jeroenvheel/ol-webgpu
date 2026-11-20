/**
 * Golden tests: the Rust/WASM buffers must match what ol's own worker code
 * (bufferUtil.js, via the JS fallback) produces for the same instructions.
 */
import Feature from 'ol/Feature.js';
import LineString from 'ol/geom/LineString.js';
import MultiPolygon from 'ol/geom/MultiPolygon.js';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';
import {beforeAll, describe, expect, it} from 'vitest';
import type {Core} from '../../src/wasm/core.js';
import {buildLinesJs, buildPointsJs, buildPolygonsJs} from '../../src/worker/fallback.js';
import {
  countriesFeatures,
  instructionsFromFeatures,
  rng,
  loadTestCore,
  triangleArea,
} from './helpers.js';

let core: Core;
beforeAll(async () => {
  core = await loadTestCore();
});

function syntheticFeatures(seed: number) {
  const r = rng(seed);
  const features: Feature[] = [];
  for (let i = 0; i < 300; i++) {
    features.push(new Feature(new Point([r() * 2e7 - 1e7, r() * 2e7 - 1e7])));
  }
  for (let i = 0; i < 150; i++) {
    const coords: number[][] = [];
    let x = r() * 2e7 - 1e7;
    let y = r() * 2e7 - 1e7;
    const n = 2 + Math.floor(r() * 30);
    for (let k = 0; k < n; k++) {
      coords.push([x, y]);
      x += (r() - 0.5) * 1e6;
      y += (r() - 0.5) * 1e6;
    }
    if (i % 5 === 0) {
      coords.push(coords[0].slice()); // closed loop
    }
    features.push(new Feature(new LineString(coords)));
  }
  for (let i = 0; i < 100; i++) {
    const cx = r() * 2e7 - 1e7;
    const cy = r() * 2e7 - 1e7;
    const ring = (radius: number, n: number, reverse: boolean) => {
      const pts: number[][] = [];
      for (let k = 0; k < n; k++) {
        const a = ((reverse ? -1 : 1) * k * 2 * Math.PI) / n;
        const rr = radius * (0.6 + 0.4 * r());
        pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
      }
      pts.push(pts[0].slice());
      return pts;
    };
    const rings = [ring(1e6, 5 + Math.floor(r() * 40), false)];
    if (i % 3 === 0) {
      rings.push(ring(2e5, 4 + Math.floor(r() * 8), true));
    }
    features.push(
      new Feature(i % 7 === 0 ? new MultiPolygon([rings, [ring(3e5, 6, false)]]) : new Polygon(rings)),
    );
  }
  return features;
}

function expectClose(actual: Float32Array, expected: Float32Array, stride: number, angleCols: number[]) {
  expect(actual.length).toBe(expected.length);
  let mismatches = 0;
  for (let i = 0; i < expected.length; i++) {
    const col = i % stride;
    const a = actual[i];
    const e = expected[i];
    if (angleCols.includes(col)) {
      // trig functions may differ by an ulp between V8 and Rust libm
      if (Math.abs(a - e) > 1e-5 * Math.max(1, Math.abs(e))) {
        mismatches++;
      }
    } else if (!Object.is(a, e)) {
      mismatches++;
    }
  }
  expect(mismatches).toBe(0);
}

const datasets: Array<[string, () => any[] | null]> = [
  ['synthetic', () => syntheticFeatures(42)],
  ['countries.json (ol v10.11 test data)', countriesFeatures],
];

describe.each(datasets)('Rust vs ol bufferUtil on %s', (_name, load) => {
  const features = load();
  const run = features ? it : it.skip;
  const instr = features ? instructionsFromFeatures(features) : null;

  run('points: identical buffers', () => {
    const js = buildPointsJs(instr!.points, instr!.customSize);
    const rs = core.buildPoints(instr!.points, instr!.customSize);
    expect(rs.indices).toEqual(js.indices);
    expect(rs.vertices).toEqual(js.vertices);
    expect(rs.instances).toEqual(js.instances);
  });

  run('lines: identical buffers (angles within 1e-5)', () => {
    const js = buildLinesJs(instr!.lines, instr!.customSize, instr!.invert);
    const rs = core.buildLines(instr!.lines, instr!.customSize, instr!.invert);
    expect(rs.indices).toEqual(js.indices);
    expect(rs.vertices).toEqual(js.vertices);
    expect(js.instances.length).toBeGreaterThan(0);
    // columns 6, 7: join angles; 10: tangent sum
    expectClose(rs.instances, js.instances, 11 + instr!.customSize, [6, 7, 10]);
  });

  run('polygons: identical vertices, same triangle count and area', () => {
    const js = buildPolygonsJs(instr!.polygons, instr!.customSize);
    const rs = core.buildPolygons(instr!.polygons, instr!.customSize);
    expect(rs.vertices).toEqual(js.vertices);
    expect(rs.indices.length).toBe(js.indices.length);
    const stride = 2 + instr!.customSize;
    const areaJs = triangleArea(js.vertices, js.indices, stride);
    const areaRs = triangleArea(rs.vertices, rs.indices, stride);
    expect(Math.abs(areaRs - areaJs)).toBeLessThanOrEqual(1e-6 * areaJs);
    expect(Math.max(...rs.indices)).toBeLessThan(rs.vertices.length / stride);
  });
});

describe('wasm robustness', () => {
  it('handles empty input', () => {
    expect(core.buildPolygons(new Float32Array(0), 0).indices.length).toBe(0);
    expect(core.buildLines(new Float32Array(0), 0, [1, 0, 0, 1, 0, 0]).instances.length).toBe(0);
    expect(core.buildPoints(new Float32Array(0), 0).instances.length).toBe(0);
  });

  it('does not trap on malformed input', () => {
    const bad = Float32Array.from([1, 1e6, 3, 4, 5]);
    expect(() => core.buildPolygons(bad, 0)).not.toThrow();
    expect(() => core.buildLines(bad, 0, [1, 0, 0, 1, 0, 0])).not.toThrow();
  });

  it('survives many calls without leaking memory', () => {
    const features = syntheticFeatures(7);
    const instr = instructionsFromFeatures(features);
    core.buildPolygons(instr.polygons, instr.customSize);
    const memory = (core as any).ex.memory.buffer.byteLength;
    for (let i = 0; i < 200; i++) {
      core.buildPolygons(instr.polygons, instr.customSize);
      core.buildLines(instr.lines, instr.customSize, instr.invert);
    }
    expect((core as any).ex.memory.buffer.byteLength).toBeLessThanOrEqual(memory * 2);
  });
});
