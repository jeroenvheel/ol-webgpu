/**
 * The batch of the layer keeps a few numbers per feature and reads the
 * geometries when they are needed. What it gives must be what ol's
 * MixedGeometryBatch holds: the same entries and counts (`toOl`), the same
 * features per kind in the same order, and a feature for every ref, also
 * after features changed, were removed (their refs are used again) and
 * after a clear.
 */
import Feature from 'ol/Feature.js';
import GeometryCollection from 'ol/geom/GeometryCollection.js';
import LineString from 'ol/geom/LineString.js';
import MultiLineString from 'ol/geom/MultiLineString.js';
import MultiPoint from 'ol/geom/MultiPoint.js';
import MultiPolygon from 'ol/geom/MultiPolygon.js';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';
import RenderFeature from 'ol/render/Feature.js';
import MixedGeometryBatch from 'ol/render/webgl/MixedGeometryBatch.js';
import {getUid} from 'ol/util.js';
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
    () => new Feature(new MultiLineString([[at(), at()], [at(), at(), at()]])),
    () => new Feature(new LineString([[...at(), 5], [...at(), 7]], 'XYM')),
    () => new Feature(new LineString([[...at(), 5, 6], [...at(), 7, 8]], 'XYZM')),
    () => new Feature(new Polygon([ring(), ring()])),
    () => new RenderFeature('Polygon', [...ring().flat(), ...ring().flat()], [10, 20], 2, {}, 3),
    () => new RenderFeature('MultiLineString', [...at(), ...at(), ...at(), ...at()], [4, 8], 2, {}, 4),
    () => new RenderFeature('Point', at(), [2], 2, {}, 1),
    () => new RenderFeature('LineString', [...at(), ...at()], [4], 2, {}, 2),
  ];
  return Array.from({length: count}, (_, i) => shapes[i % shapes.length]());
}

/** The entries of a batch of ol without their refs: the two batches give refs their own way. */
function withoutRefs(part: any) {
  const entries: Record<string, unknown> = {};
  for (const uid in part.entries) {
    const {ref: _ref, ...entry} = part.entries[uid];
    entries[uid] = entry;
  }
  return {...part, entries};
}

function expectSame(lean: FeatureBatch, ol: MixedGeometryBatch) {
  const made = lean.toOl();
  expect(withoutRefs(made.pointBatch)).toEqual(withoutRefs(ol.pointBatch));
  expect(withoutRefs(made.lineStringBatch)).toEqual(withoutRefs(ol.lineStringBatch));
  expect(withoutRefs(made.polygonBatch)).toEqual(withoutRefs(ol.polygonBatch));
  expect(lean.isEmpty()).toBe(ol.isEmpty());
  // the counts the instructions are sized with
  expect(lean.geometriesCount('points')).toBe(ol.pointBatch.geometriesCount);
  expect(lean.geometriesCount('lines')).toBe(ol.lineStringBatch.geometriesCount);
  expect(lean.verticesCount('lines')).toBe(ol.lineStringBatch.verticesCount);
  expect(lean.geometriesCount('polygons')).toBe(ol.polygonBatch.geometriesCount);
  expect(lean.verticesCount('polygons')).toBe(ol.polygonBatch.verticesCount);
  expect(lean.ringsCount()).toBe(ol.polygonBatch.ringsCount);
  // the features of each kind in the order of ol: that is the order they are drawn in
  const parts = {points: ol.pointBatch, lines: ol.lineStringBatch, polygons: ol.polygonBatch} as const;
  const seen = new Set<number>();
  for (const kind of ['points', 'lines', 'polygons'] as const) {
    const features = Object.values(parts[kind].entries).map((entry) => entry.feature);
    expect(lean.featuresOf(kind)).toEqual(features);
    for (const ref of lean.refsOf(kind)) {
      // a ref is of one feature, and the entries made for ol have it
      expect(ref).toBeGreaterThan(0);
      expect(lean.refOf(lean.getFeatureFromRef(ref)!)).toBe(ref);
      expect((made as any)[kind === 'points' ? 'pointBatch' : kind === 'lines' ? 'lineStringBatch' : 'polygonBatch'].entries[getUid(lean.getFeatureFromRef(ref)!)].ref).toBe(ref);
      seen.add(ref);
    }
  }
  expect(seen.size).toBe(new Set([...Object.keys(ol.pointBatch.entries), ...Object.keys(ol.lineStringBatch.entries), ...Object.keys(ol.polygonBatch.entries)]).size);
}

describe('the batch of the layer', () => {
  it('gives what the batch of ol holds', () => {
    const r = rng(21);
    const lean = new FeatureBatch();
    const ol = new MixedGeometryBatch();
    const both = (fn: (batch: FeatureBatch | MixedGeometryBatch) => void) => {
      fn(lean);
      fn(ol);
    };
    expectSame(lean, ol);
    const list = features(1, 600);
    both((b) => b.addFeatures(list));
    expect(lean.refsOf('points').length).toBeGreaterThan(100);
    expectSame(lean, ol);

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
      if (round % 2) {
        expectSame(lean, ol); // also between removing and adding: refs are given again after this
      }
      // not in the order they were made in
      const added = features(50 + round, 120).reverse();
      list.push(...added);
      both((b) => b.addFeatures(added));
      expectSame(lean, ol);
    }

    // a feature that was never added stays out
    const stranger = new Feature(new Point([1, 2]));
    both((b) => b.changeFeature(stranger));
    both((b) => b.removeFeature(stranger));
    expect(lean.refOf(stranger)).toBe(0);
    expectSame(lean, ol);

    both((b) => b.clear());
    expectSame(lean, ol);
    const again = features(99, 40);
    both((b) => b.addFeatures(again));
    expectSame(lean, ol);
  });

  it('uses the refs of removed features again, and no ref for two features', () => {
    const batch = new FeatureBatch();
    const list = features(7, 300).filter((f) => f.getGeometry());
    batch.addFeatures(list);
    let highest = 0;
    for (const feature of list) {
      highest = Math.max(highest, batch.refOf(feature));
    }
    for (let round = 0; round < 20; round++) {
      for (const feature of list.splice(0, 30)) {
        batch.removeFeature(feature);
      }
      batch.refsOf('points'); // a build
      const added = features(300 + round, 40).filter((f) => f.getGeometry()).slice(0, 30);
      batch.addFeatures(added);
      list.push(...added);
      const refs = list.map((f) => batch.refOf(f));
      expect(new Set(refs).size).toBe(list.length);
      expect(Math.max(...refs)).toBeLessThanOrEqual(highest);
      list.forEach((f, i) => expect(batch.getFeatureFromRef(refs[i])).toBe(f));
    }
  });

  it('reads the geometry as it is in the projection of the view', () => {
    const batch = new FeatureBatch();
    const ol = new MixedGeometryBatch();
    const feature = new Feature(new LineString([[1, 2], [3, 4]]));
    const double = (input: number[], output?: number[]) => {
      const out = output ?? input.slice();
      for (let i = 0; i < input.length; i++) {
        out[i] = input[i] * 2;
      }
      return out;
    };
    batch.addFeature(feature, double);
    ol.addFeature(feature, double as any);
    expectSame(batch, ol);
    expect((batch.geometryOf(batch.refOf(feature)) as LineString).getFlatCoordinates()).toEqual([2, 4, 6, 8]);
    expect(feature.getGeometry()!.getFlatCoordinates()).toEqual([1, 2, 3, 4]);
  });
});
