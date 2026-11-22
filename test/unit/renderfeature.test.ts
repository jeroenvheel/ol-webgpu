/**
 * RenderFeatures (`ol/render/Feature`, what vector tile formats produce) in
 * the CPU part of the pipeline: they must give the same render instructions,
 * buffers and text styles as the same shapes as `ol/Feature`. The browser
 * part (drawing, labels, hit detection) is in test/rendering/renderfeature.ts.
 */
import Feature from 'ol/Feature.js';
import LineString from 'ol/geom/LineString.js';
import MultiLineString from 'ol/geom/MultiLineString.js';
import MultiPoint from 'ol/geom/MultiPoint.js';
import MultiPolygon from 'ol/geom/MultiPolygon.js';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';
import RenderFeature from 'ol/render/Feature.js';
import MixedGeometryBatch from 'ol/render/webgl/MixedGeometryBatch.js';
import {beforeAll, describe, expect, it} from 'vitest';
import {buildTextEvaluator} from '../../src/text/style.js';
import type {Core} from '../../src/wasm/core.js';
import {instructionsFromFeatures, loadTestCore, rng} from './helpers.js';

let core: Core;
beforeAll(async () => {
  core = await loadTestCore();
});

/**
 * Random shapes of every type, each as a Feature and as the RenderFeature a
 * vector tile format would make of it: polygon rings oriented (outer
 * counter-clockwise, holes clockwise) and a MultiPolygon as one 'Polygon'
 * whose rings are split by orientation. The Feature gets the same oriented
 * coordinates, so both describe identical rings.
 */
function pairs(seed: number): {features: Feature[]; renderFeatures: RenderFeature[]} {
  const r = rng(seed);
  const features: Feature[] = [];
  const renderFeatures: RenderFeature[] = [];
  const add = (geometry: any, renderType: string, flat: number[], ends: number[], properties: Record<string, unknown>) => {
    const id = features.length;
    const feature = new Feature({geometry, ...properties});
    feature.setId(id);
    features.push(feature);
    renderFeatures.push(new RenderFeature(renderType as any, flat, ends, 2, {...properties}, id));
  };
  const walk = (n: number, step: number) => {
    const coords: number[][] = [];
    let x = r() * 2e7 - 1e7;
    let y = r() * 2e7 - 1e7;
    for (let k = 0; k < n; k++) {
      coords.push([x, y]);
      x += (r() - 0.5) * step;
      y += (r() - 0.5) * step;
    }
    return coords;
  };
  const ring = (cx: number, cy: number, radius: number, n: number) => {
    const pts: number[][] = [];
    for (let k = 0; k < n; k++) {
      const a = (k * 2 * Math.PI) / n;
      const rr = radius * (0.6 + 0.4 * r());
      pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
    }
    pts.push(pts[0].slice());
    return pts;
  };
  const polygonRings = () => {
    const cx = r() * 2e7 - 1e7;
    const cy = r() * 2e7 - 1e7;
    const rings = [ring(cx, cy, 1e6, 5 + Math.floor(r() * 30))];
    if (r() < 0.5) {
      rings.push(ring(cx, cy, 2e5, 4 + Math.floor(r() * 8)));
    }
    return rings;
  };

  for (let i = 0; i < 60; i++) {
    const p = [r() * 2e7 - 1e7, r() * 2e7 - 1e7];
    add(new Point(p), 'Point', p.slice(), [], {name: `point ${i}`, size: i % 5});
  }
  for (let i = 0; i < 20; i++) {
    const geometry = new MultiPoint(walk(2 + Math.floor(r() * 5), 2e6));
    add(geometry, 'MultiPoint', geometry.getFlatCoordinates().slice(), [geometry.getFlatCoordinates().length], {size: i % 3});
  }
  for (let i = 0; i < 40; i++) {
    const coords = walk(2 + Math.floor(r() * 30), 1e6);
    if (i % 5 === 0) {
      coords.push(coords[0].slice()); // closed loop
    }
    const geometry = new LineString(coords);
    add(geometry, 'LineString', geometry.getFlatCoordinates().slice(), [geometry.getFlatCoordinates().length], {name: `line ${i}`});
  }
  for (let i = 0; i < 20; i++) {
    const geometry = new MultiLineString([walk(2 + Math.floor(r() * 10), 1e6), walk(2 + Math.floor(r() * 10), 1e6)]);
    add(geometry, 'MultiLineString', geometry.getFlatCoordinates().slice(), geometry.getEnds().slice(), {name: `lines ${i}`});
  }
  for (let i = 0; i < 40; i++) {
    const polygon = new Polygon(polygonRings());
    const flat = polygon.getOrientedFlatCoordinates().slice();
    const ends = polygon.getEnds().slice();
    add(new Polygon(flat.slice(), 'XY', ends.slice()), 'Polygon', flat, ends, {name: `polygon ${i}`});
  }
  for (let i = 0; i < 20; i++) {
    const multi = new MultiPolygon([polygonRings(), polygonRings(), polygonRings()].slice(0, 2 + (i % 2)));
    const flat = multi.getOrientedFlatCoordinates().slice();
    const endss = multi.getEndss().map((e) => e.slice());
    add(new MultiPolygon(flat.slice(), 'XY', endss), 'Polygon', flat, endss.flat(), {name: `polygons ${i}`});
  }
  return {features, renderFeatures};
}

describe('RenderFeatures in the buffers', () => {
  const {features, renderFeatures} = pairs(11);
  const fromFeatures = instructionsFromFeatures(features);
  const fromRender = instructionsFromFeatures(renderFeatures);

  it('give the same render instructions as Features', () => {
    expect(fromRender.points.length).toBeGreaterThan(0);
    expect(fromRender.lines.length).toBeGreaterThan(0);
    expect(fromRender.polygons.length).toBeGreaterThan(0);
    expect(fromRender.points).toEqual(fromFeatures.points);
    expect(fromRender.lines).toEqual(fromFeatures.lines);
    expect(fromRender.polygons).toEqual(fromFeatures.polygons);
  });

  it('give the same Rust/WASM buffers as Features', () => {
    const size = fromRender.customSize;
    for (const [build, kind] of [
      [(i: typeof fromRender) => core.buildPoints(i.points, size), 'points'],
      [(i: typeof fromRender) => core.buildLines(i.lines, size, i.invert), 'lines'],
      [(i: typeof fromRender) => core.buildPolygons(i.polygons, size), 'polygons'],
    ] as const) {
      const a = build(fromRender);
      const b = build(fromFeatures);
      expect(a.indices, kind).toEqual(b.indices);
      expect(a.vertices, kind).toEqual(b.vertices);
      expect((a as any).instances, kind).toEqual((b as any).instances);
    }
  });

  it('split a Polygon with several outer rings into its polygons, as for a MultiPolygon', () => {
    const multi = renderFeatures.filter((f) => String(f.get('name')).startsWith('polygons'));
    expect(multi.length).toBeGreaterThan(0);
    for (const renderFeature of multi) {
      const feature = features.find((f) => f.getId() === renderFeature.getId())!;
      const a = new MixedGeometryBatch();
      a.addFeature(renderFeature);
      const b = new MixedGeometryBatch();
      b.addFeature(feature);
      expect(a.polygonBatch.geometriesCount).toBe((feature.getGeometry() as MultiPolygon).getPolygons().length);
      expect(a.polygonBatch.geometriesCount).toBe(b.polygonBatch.geometriesCount);
      expect(a.polygonBatch.ringsCount).toBe(b.polygonBatch.ringsCount);
    }
  });
});

describe('RenderFeatures in text styles', () => {
  const style = [
    {
      filter: ['==', ['geometry-type'], 'LineString'],
      style: {'text-value': ['concat', 'L ', ['get', 'name']], 'text-placement': 'line', 'text-font': '12px sans-serif'},
    },
    {
      filter: ['==', ['geometry-type'], 'Polygon'],
      style: {'text-value': ['concat', 'P ', ['get', 'name'], ' ', ['id']], 'text-font': 'bold 11px serif'},
    },
    {
      else: true,
      style: {'text-value': ['to-string', ['get', 'size']], 'text-offset-y': ['*', ['get', 'size'], 2], 'z-index': ['get', 'size']},
    },
  ];

  it('evaluate the same text, placement, offset and z-index as Features', () => {
    const evaluate = buildTextEvaluator(style as any, {})!;
    const {features, renderFeatures} = pairs(5);
    const texts = (f: any) => {
      const out: string[] = [];
      evaluate(f, 1000, (text, zIndex) => out.push(`${text.getText()}|${text.getPlacement()}|${text.getFont()}|${text.getOffsetY()}|${zIndex}`));
      return out;
    };
    let compared = 0;
    for (let i = 0; i < features.length; i++) {
      const expected = texts(features[i]);
      expect(texts(renderFeatures[i]), `feature ${i} (${renderFeatures[i].getType()})`).toEqual(expected);
      compared += expected.length;
    }
    expect(compared).toBe(features.length);
  });
});
