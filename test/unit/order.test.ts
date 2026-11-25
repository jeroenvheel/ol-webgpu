/**
 * The order features are drawn in (render/order.ts) and how the
 * instructions follow it (render/instructions.ts).
 */
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import MixedGeometryBatch from 'ol/render/webgl/MixedGeometryBatch.js';
import {create as createTransform} from 'ol/transform.js';
import {describe, expect, it, vi} from 'vitest';
import {InstructionBuilder} from '../../src/render/instructions.js';
import {featureZIndex, styleOrder} from '../../src/render/order.js';
import {REF_ATTRIBUTE, buildStylePasses} from '../../src/render/stylePasses.js';

const point = (x: number, properties: Record<string, unknown>) => new Feature({geometry: new Point([x, 0]), ...properties});

describe('styleOrder', () => {
  it('is null when the styles are in order, or have no z-index', () => {
    expect(styleOrder({'circle-radius': 4})).toBeNull();
    expect(styleOrder([{'circle-radius': 4}, {'circle-radius': 2}])).toBeNull();
    expect(styleOrder([{'circle-radius': 4, 'z-index': 1}, {'circle-radius': 2, 'z-index': 2}])).toBeNull();
    // an expression is not an order of the styles
    expect(styleOrder([{'circle-radius': 4, 'z-index': ['get', 'z']}, {'circle-radius': 2}])).toBeNull();
  });

  it('sorts styles by their number, and keeps the order of equal ones', () => {
    expect(styleOrder([{'circle-radius': 4, 'z-index': 2}, {'circle-radius': 2}, {'circle-radius': 1, 'z-index': 2}, {'circle-radius': 3, 'z-index': -1}])).toEqual([
      3, 1, 0, 2,
    ]);
  });

  it('counts every style of a rule', () => {
    const style = [
      {filter: ['==', ['get', 'a'], 1], style: [{'circle-radius': 4, 'z-index': 5}, {'circle-radius': 2}]},
      {else: true, style: {'circle-radius': 1, 'z-index': 3}},
    ];
    expect(styleOrder(style as any)).toEqual([1, 2, 0]);
  });

  it('orders the passes of a style', () => {
    const style = [
      {'circle-radius': 4, 'circle-fill-color': [255, 0, 0, 1], 'z-index': 2},
      {'stroke-width': 2, 'stroke-color': [0, 0, 255, 1], 'z-index': 1},
    ];
    const {passes} = buildStylePasses(style as any, {});
    expect(passes.map((p) => (p.symbol ? 'symbol' : p.stroke ? 'stroke' : 'other'))).toEqual(['stroke', 'symbol']);
  });
});

describe('featureZIndex', () => {
  it('is null without a z-index that is an expression', () => {
    expect(featureZIndex({'circle-radius': 4}, {}, () => 0)).toBeNull();
    expect(featureZIndex({'circle-radius': 4, 'z-index': 3}, {}, () => 0)).toBeNull();
  });

  it('gives the z-index of the feature', () => {
    const z = featureZIndex({'circle-radius': 4, 'z-index': ['*', ['get', 'z'], 2]}, {}, () => 0)!;
    expect(z.volatile).toBe(false);
    expect(z.of(point(0, {z: 3}))).toBe(6);
    // nothing to tell: as a feature without a z-index
    expect(z.of(point(0, {}))).toBe(0);
  });

  it('takes the first style whose filter the feature passes', () => {
    const style = [
      {filter: ['==', ['get', 'kind'], 'a'], style: {'circle-radius': 4, 'z-index': ['get', 'z']}},
      {else: true, style: {'circle-radius': 4, 'z-index': 7}},
    ];
    const z = featureZIndex(style as any, {}, () => 0)!;
    expect(z.of(point(0, {kind: 'a', z: 2}))).toBe(2);
    expect(z.of(point(0, {kind: 'b', z: 2}))).toBe(7);
  });

  it('knows when it depends on variables or the zoom', () => {
    const variables = {lift: 10};
    const z = featureZIndex({'circle-radius': 4, 'z-index': ['+', ['get', 'z'], ['var', 'lift'], ['zoom']]}, variables, () => 4)!;
    expect(z.volatile).toBe(true);
    expect(z.of(point(0, {z: 1}))).toBe(15);
    variables.lift = 20;
    expect(z.of(point(0, {z: 1}))).toBe(25);
  });
});

describe('InstructionBuilder with an order', () => {
  // one attribute, the ref: the points come out as x, y, ref
  const custom = {[REF_ATTRIBUTE]: {size: 1, callback: function (this: {ref?: number}) {
    return this.ref ?? 0;
  }}};
  const xs = (instructions: Float32Array | null) => Array.from(instructions!).filter((_v, i) => i % 3 === 0);
  const batchOf = (features: Feature[]) => {
    const batch = new MixedGeometryBatch();
    batch.addFeatures(features);
    return batch;
  };
  const transform = createTransform();

  it('keeps the order of the batch without one', () => {
    const batch = batchOf([point(1, {z: 3}), point(2, {z: 1}), point(3, {z: 2})]);
    expect(xs(new InstructionBuilder(custom).points(batch.pointBatch, transform))).toEqual([1, 2, 3]);
  });

  it('orders by the number of a feature, then by the comparison, then as in the batch', () => {
    const features = [point(1, {z: 2, rank: 1}), point(2, {z: 1, rank: 1}), point(3, {z: 2, rank: 0}), point(4, {z: 1, rank: 1})];
    const batch = batchOf(features);
    const builder = new InstructionBuilder(custom);
    builder.setOrder({key: (f) => f.get('z'), volatile: false, compare: null});
    expect(xs(builder.points(batch.pointBatch, transform))).toEqual([2, 4, 1, 3]);
    builder.setOrder({key: (f) => f.get('z'), volatile: false, compare: (a, b) => a.get('rank') - b.get('rank')});
    expect(xs(builder.points(batch.pointBatch, transform))).toEqual([2, 4, 3, 1]);
    builder.setOrder({key: null, volatile: false, compare: (a, b) => b.get('z') - a.get('z')});
    expect(xs(builder.points(batch.pointBatch, transform))).toEqual([1, 3, 2, 4]);
    builder.setOrder(null);
    expect(xs(builder.points(batch.pointBatch, transform))).toEqual([1, 2, 3, 4]);
  });

  it('orders by number the same with few and with many different numbers', () => {
    // few different numbers go per number, many are sorted: the result is the same order
    for (const different of [5, 400]) {
      const features = Array.from({length: 500}, (_v, i) => point(i, {z: (i * 7919) % different}));
      const builder = new InstructionBuilder(custom);
      builder.setOrder({key: (f) => f.get('z'), volatile: false, compare: null});
      const expected = features.map((f, i) => [f.get('z'), i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((p) => p[1]);
      expect(xs(builder.points(batchOf(features).pointBatch, transform))).toEqual(expected);
    }
  });

  it('asks the number of a feature once, until the feature changes', () => {
    const features = [point(1, {z: 2}), point(2, {z: 1})];
    const batch = batchOf(features);
    const builder = new InstructionBuilder(custom);
    const key = vi.fn((f: Feature) => f.get('z'));
    builder.setOrder({key, volatile: false, compare: null});
    builder.points(batch.pointBatch, transform);
    builder.points(batch.pointBatch, transform);
    expect(key).toHaveBeenCalledTimes(2);
    // as the renderer does for a changed feature
    builder.forget(batch as any, features[0]);
    features[0].set('z', 0);
    batch.changeFeature(features[0]);
    expect(xs(builder.points(batch.pointBatch, transform))).toEqual([1, 2]);
    expect(key).toHaveBeenCalledTimes(3);
  });

  it('asks again for every build when the numbers do not follow from the features alone', () => {
    const batch = batchOf([point(1, {z: 2}), point(2, {z: 1})]);
    const builder = new InstructionBuilder(custom);
    let flip = 1;
    const key = vi.fn((f: Feature) => f.get('z') * flip);
    builder.setOrder({key, volatile: true, compare: null});
    expect(xs(builder.points(batch.pointBatch, transform))).toEqual([2, 1]);
    flip = -1;
    expect(xs(builder.points(batch.pointBatch, transform))).toEqual([1, 2]);
    expect(key).toHaveBeenCalledTimes(4);
  });
});
