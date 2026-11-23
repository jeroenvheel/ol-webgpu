/**
 * The batch with its own refs must hold what ol's MixedGeometryBatch holds:
 * the same entries, refs and counts, and the same feature for a ref, also
 * after features changed, were removed (their refs are used again) and
 * after a clear.
 */
import Feature from 'ol/Feature.js';
import GeometryCollection from 'ol/geom/GeometryCollection.js';
import LineString from 'ol/geom/LineString.js';
import MultiPoint from 'ol/geom/MultiPoint.js';
import MultiPolygon from 'ol/geom/MultiPolygon.js';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';
import RenderFeature from 'ol/render/Feature.js';
import MixedGeometryBatch from 'ol/render/webgl/MixedGeometryBatch.js';
import {describe, expect, it} from 'vitest';
import {FeatureBatch} from '../../src/render/batch.js';
import {rng} from './helpers.js';

function features(seed: number, count: number): any[] {
  const r = rng(seed);
  const at = () => [r() * 2e7 - 1e7, r() * 2e7 - 1e7];
  const ring = () => {
    const [x, y] = at();
    return [[x, y], [x + 1e5, y], [x + 1e5, y + 1e5], [x, y + 1e5], [x, y]];
  };
  const shapes = [
    () => new Feature(new Point(at())),
    () => new Feature(new MultiPoint([at(), at(), at()])),
    () => new Feature(new LineString([at(), at(), at()])),
    () => new Feature(new Polygon([ring()])),
    () => new Feature(new MultiPolygon([[ring()], [ring()]])),
    () => new Feature(new GeometryCollection([new Point(at()), new LineString([at(), at()]), new Polygon([ring()])])),
    () => new Feature(), // no geometry
    () => new RenderFeature('Point', at(), [2], 2, {}, 1),
    () => new RenderFeature('LineString', [...at(), ...at()], [4], 2, {}, 2),
  ];
  return Array.from({length: count}, (_, i) => shapes[i % shapes.length]());
}

function expectSame(lean: MixedGeometryBatch, ol: MixedGeometryBatch, all: any[]) {
  expect(lean.pointBatch).toEqual(ol.pointBatch);
  expect(lean.lineStringBatch).toEqual(ol.lineStringBatch);
  expect(lean.polygonBatch).toEqual(ol.polygonBatch);
  // same order of the entries: it is the order in which they are drawn
  expect(Object.keys(lean.polygonBatch.entries)).toEqual(Object.keys(ol.polygonBatch.entries));
  expect(lean.isEmpty()).toBe(ol.isEmpty());
  for (let ref = 0; ref <= all.length + 1; ref++) {
    expect(lean.getFeatureFromRef(ref)).toBe(ol.getFeatureFromRef(ref));
  }
}

describe('batch with its own refs', () => {
  it('holds what the batch of ol holds', () => {
    const r = rng(21);
    const lean = new FeatureBatch();
    const ol = new MixedGeometryBatch();
    const both = (fn: (batch: MixedGeometryBatch) => void) => {
      fn(lean);
      fn(ol);
    };
    expectSame(lean, ol, []);
    const list = features(1, 600);
    both((b) => b.addFeatures(list));
    expect(Object.keys(lean.pointBatch.entries).length).toBeGreaterThan(100);
    expectSame(lean, ol, list);

    for (let round = 0; round < 5; round++) {
      for (const feature of list.splice(Math.floor(r() * 200), 80)) {
        both((b) => b.removeFeature(feature));
      }
      for (let i = round; i < list.length; i += 6) {
        const feature = list[i];
        if (feature instanceof Feature) {
          // another kind of geometry, or none
          feature.setGeometry(i % 4 === 0 ? undefined : i % 4 === 1 ? new Point([i, round]) : new LineString([[i, 0], [0, round]]));
        }
        both((b) => b.changeFeature(feature));
      }
      const added = features(50 + round, 120);
      list.push(...added);
      both((b) => b.addFeatures(added));
      expectSame(lean, ol, list);
    }

    // a feature that was never added stays out
    const stranger = new Feature(new Point([1, 2]));
    both((b) => b.changeFeature(stranger));
    both((b) => b.removeFeature(stranger));
    expectSame(lean, ol, list);

    both((b) => b.clear());
    expectSame(lean, ol, list);
    const again = features(99, 40);
    both((b) => b.addFeatures(again));
    expectSame(lean, ol, again);
  });
});
