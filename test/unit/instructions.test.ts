/**
 * The render instructions with kept attribute values must be, float for
 * float, those of ol's generators (`ol/render/webgl/renderinstructions.js`):
 * the worker and the shaders read them the same way. Also after features
 * changed, were removed and added, where a kept value could go stale.
 */
import Feature from 'ol/Feature.js';
import GeometryCollection from 'ol/geom/GeometryCollection.js';
import LineString from 'ol/geom/LineString.js';
import MultiPoint from 'ol/geom/MultiPoint.js';
import MultiPolygon from 'ol/geom/MultiPolygon.js';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';
import MixedGeometryBatch from 'ol/render/webgl/MixedGeometryBatch.js';
import {
  generateLineStringRenderInstructions,
  generatePointRenderInstructions,
  generatePolygonRenderInstructions,
} from 'ol/render/webgl/renderinstructions.js';
import {type Transform, compose, create as createTransform} from 'ol/transform.js';
import LabelsArray from 'ol/webgl/LabelsArray.js';
import {describe, expect, it, vi} from 'vitest';
import {InstructionBuilder} from '../../src/render/instructions.js';
import {buildStylePasses} from '../../src/render/stylePasses.js';
import {rng} from './helpers.js';

/** Attributes from feature properties: a number, a colour, a boolean and the geometry type. */
const style = {
  'circle-radius': ['get', 'size'],
  'circle-fill-color': ['get', 'color'],
  'circle-opacity': ['case', ['get', 'faded'], 0.5, 1],
  'stroke-width': ['match', ['geometry-type'], 'LineString', ['get', 'size'], 2],
  'stroke-color': ['get', 'color'],
  'fill-color': ['get', 'color'],
};

// as arrays: ol parses colour strings with a canvas, which node does not have
const COLORS = [[255, 0, 0, 1], [0, 120, 255, 0.5], [0, 128, 0, 1], undefined];

function properties(r: () => number) {
  const size = r() < 0.1 ? undefined : r() < 0.1 ? null : Math.round(r() * 20);
  return {size, color: COLORS[Math.floor(r() * COLORS.length)], faded: r() < 0.5};
}

function features(seed: number, count: number): Feature[] {
  const r = rng(seed);
  const at = () => [r() * 2e7 - 1e7, r() * 2e7 - 1e7];
  const ring = () => {
    const [x, y] = at();
    return [[x, y], [x + 1e5, y], [x + 1e5, y + 1e5], [x, y + 1e5], [x, y]];
  };
  const shapes = [
    () => new Point(at()),
    () => new MultiPoint([at(), at(), at()]),
    () => new LineString([at(), at(), at()]),
    () => new LineString([[...at(), 5], [...at(), 7]], 'XYM'),
    () => new Polygon([ring()]),
    () => new MultiPolygon([[ring()], [ring()]]),
    () => new GeometryCollection([new Point(at()), new LineString([at(), at()]), new Polygon([ring()])]),
  ];
  return Array.from({length: count}, (_, i) => new Feature({geometry: shapes[i % shapes.length](), ...properties(r)}));
}

function view(center: number[], resolution: number): Transform {
  return compose(createTransform(), 0, 0, 2 / (resolution * 1200), 2 / (resolution * 800), 0, -center[0], -center[1]);
}

function expectSameAsOl(builder: InstructionBuilder, batch: MixedGeometryBatch, custom: any, transform: Transform) {
  const labels = new LabelsArray();
  const empty = new Float32Array(0);
  expect(builder.points(batch.pointBatch, transform)).toEqual(generatePointRenderInstructions(batch.pointBatch, empty, labels, custom, transform));
  expect(builder.lines(batch.lineStringBatch, transform)).toEqual(generateLineStringRenderInstructions(batch.lineStringBatch, empty, labels, custom, transform));
  expect(builder.polygons(batch.polygonBatch, transform)).toEqual(generatePolygonRenderInstructions(batch.polygonBatch, empty, labels, custom, transform));
}

describe('render instructions with kept attributes', () => {
  it('equal those of ol, for every view', () => {
    const {customAttributes} = buildStylePasses(style as any, {});
    expect(Object.keys(customAttributes).length).toBeGreaterThan(3);
    const batch = new MixedGeometryBatch();
    batch.addFeatures(features(3, 700));
    const builder = new InstructionBuilder(customAttributes);
    expect(builder.points(batch.pointBatch, view([0, 0], 1000))!.length).toBeGreaterThan(0);
    expectSameAsOl(builder, batch, customAttributes, view([0, 0], 1000));
    expectSameAsOl(builder, batch, customAttributes, view([5e6, -3e6], 2.5));
  });

  it('calls the attribute callbacks once per feature, not once per rebuild', () => {
    const {customAttributes} = buildStylePasses(style as any, {});
    const list = features(4, 300);
    const batch = new MixedGeometryBatch();
    batch.addFeatures(list);
    const get = vi.spyOn(Feature.prototype, 'get');
    const builder = new InstructionBuilder(customAttributes);
    builder.points(batch.pointBatch, view([0, 0], 1000));
    const first = get.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    builder.points(batch.pointBatch, view([10, 10], 500));
    expect(get.mock.calls.length).toBe(first);
    get.mockRestore();
  });

  it('follow features that change, go and come', () => {
    const {customAttributes} = buildStylePasses(style as any, {});
    const r = rng(9);
    const list = features(5, 700);
    const batch = new MixedGeometryBatch();
    batch.addFeatures(list);
    const builder = new InstructionBuilder(customAttributes);
    const transform = view([1e6, 1e6], 300);
    expectSameAsOl(builder, batch, customAttributes, transform);

    for (let round = 0; round < 4; round++) {
      // other properties
      for (let i = round; i < list.length; i += 5) {
        list[i].setProperties(properties(r), true);
        builder.forget(batch, list[i]);
        batch.changeFeature(list[i]);
      }
      // removed: their refs are given to the features added next
      for (const feature of list.splice(round * 7, 60)) {
        builder.forget(batch, feature);
        batch.removeFeature(feature);
      }
      const added = features(100 + round, 90);
      batch.addFeatures(added);
      list.push(...added);
      expectSameAsOl(builder, batch, customAttributes, transform);
    }

    batch.clear();
    builder.reset();
    batch.addFeatures(features(200, 50));
    expectSameAsOl(builder, batch, customAttributes, transform);
  });

  it('leave attributes with text to ol', () => {
    const customAttributes = {
      ref: {size: 1, callback(this: any) { return this.ref ?? 0; }},
      label: {size: 3, callback: (feature: any) => String(feature.get('size'))},
    };
    const batch = new MixedGeometryBatch();
    batch.addFeatures(features(6, 20));
    const builder = new InstructionBuilder(customAttributes as any);
    expect(builder.points(batch.pointBatch, view([0, 0], 1000))).toBeNull();
    expect(builder.lines(batch.lineStringBatch, view([0, 0], 1000))).toBeNull();
    expect(builder.polygons(batch.polygonBatch, view([0, 0], 1000))).toBeNull();
  });
});
