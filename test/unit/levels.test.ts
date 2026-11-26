/** Drawing by z-index: where the features of each number are in the buffers (render/levels.ts). */
import Feature from 'ol/Feature.js';
import LineString from 'ol/geom/LineString.js';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';
import {FeatureBatch} from '../../src/render/batch.js';
import {create as createTransform} from 'ol/transform.js';
import {describe, expect, it} from 'vitest';
import {InstructionBuilder, InstructionJob} from '../../src/render/instructions.js';
import {MAX_LEVELS, drawLevels, mergeStarts, orderLevels} from '../../src/render/levels.js';
import {REF_ATTRIBUTE} from '../../src/render/stylePasses.js';
import {edgeInstructions} from '../../src/worker/build.js';
import {buildLinesJs, buildPointsJs, buildPolygonsJs} from '../../src/worker/fallback.js';

// one attribute, the ref
const custom = {
  [REF_ATTRIBUTE]: {
    size: 1,
    callback: function (this: {ref?: number}) {
      return this.ref ?? 0;
    },
  },
};
const transform = createTransform();
const square = (x: number, z: number) =>
  new Feature({
    geometry: new Polygon([
      [
        [x, 0],
        [x + 4, 0],
        [x + 4, 4],
        [x, 4],
        [x, 0],
      ],
    ]),
    z,
  });
const line = (x: number, z: number, vertices = 3) => new Feature({geometry: new LineString(Array.from({length: vertices}, (_v, i) => [x + i, i % 2])), z});
const point = (x: number, z: number) => new Feature({geometry: new Point([x, 0]), z});

/** The instructions of the features and the buffers made of them, as a build does it (without the worker). */
function build(features: Feature[], edges = false) {
  const batch = new FeatureBatch();
  batch.addFeatures(features);
  const builder = new InstructionBuilder(custom);
  builder.setOrder({key: (f) => f.get('z'), volatile: false, compare: null});
  const job = new InstructionJob(builder, batch, {polygons: true, lines: true, points: true}, transform);
  while (!job.step(Infinity)) {
    // goes on
  }
  const polygons = job.result('polygons')!;
  const sets = {
    polygons: buildPolygonsJs(polygons, 1),
    edges: edges ? buildLinesJs(edgeInstructions(polygons, 1), 1, [1, 0, 0, 1, 0, 0]) : null,
    lines: buildLinesJs(job.result('lines')!, 1, [1, 0, 0, 1, 0, 0]),
    points: buildPointsJs(job.result('points')!, 1),
  };
  return {starts: job.levels(), sets};
}

describe('mergeStarts', () => {
  it('gives every kind a start for every number', () => {
    const starts = mergeStarts({
      points: {levels: [1, 0, 3, 2], end: 5},
      lines: {levels: [2, 0], end: 4},
      polygons: null,
      edges: null,
    })!;
    expect(starts.z).toEqual([1, 2, 3]);
    expect(Array.from(starts.points!)).toEqual([0, 2, 2, 5]);
    expect(Array.from(starts.lines!)).toEqual([0, 0, 4, 4]);
    expect(starts.polygons).toBeNull();
  });

  it('is null with one number, and with more than are drawn one by one', () => {
    expect(mergeStarts({points: {levels: [1, 0], end: 5}, lines: {levels: [1, 0], end: 2}, polygons: null, edges: null})).toBeNull();
    const many = Array.from({length: MAX_LEVELS + 1}, (_v, i) => [i, i]).flat();
    expect(mergeStarts({points: {levels: many, end: MAX_LEVELS + 1}, lines: null, polygons: null, edges: null})).toBeNull();
    // and tells how many there were, which the layer warns about; not when they fit
    const told: number[] = [];
    mergeStarts({points: {levels: many, end: MAX_LEVELS + 1}, lines: null, polygons: null, edges: null}, (count) => told.push(count));
    mergeStarts({points: {levels: [1, 0, 2, 3], end: 5}, lines: null, polygons: null, edges: null}, (count) => told.push(count));
    expect(told).toEqual([MAX_LEVELS + 1]);
  });
});

describe('orderLevels', () => {
  const FILL = 1;
  const STROKE = 2;
  const SYMBOL = 4;

  it('is null when kind by kind gives the same picture', () => {
    expect(orderLevels([])).toBeNull();
    expect(orderLevels([SYMBOL, SYMBOL, SYMBOL])).toBeNull();
    // fills, then strokes, then symbols: as they are drawn anyway
    expect(orderLevels([FILL, FILL, STROKE, SYMBOL, SYMBOL])).toBeNull();
  });

  it('starts a number where a feature has a kind that comes before one of an earlier feature', () => {
    // a symbol, then a stroke over it, then a fill over both
    expect([...orderLevels([SYMBOL, STROKE, FILL])!]).toEqual([0, 1, 2]);
    // points stay together until something has to go over them
    expect([...orderLevels([FILL, SYMBOL, SYMBOL, STROKE, SYMBOL])!]).toEqual([0, 0, 0, 1, 1]);
  });

  it('gives every polygon with a fill and a stroke its own number', () => {
    // the fill of the second has to cover the stroke of the first
    expect([...orderLevels([FILL | STROKE, FILL | STROKE, FILL | STROKE])!]).toEqual([0, 1, 2]);
  });

  it('leaves features that draw nothing where they are', () => {
    expect([...orderLevels([SYMBOL, 0, FILL])!]).toEqual([0, 0, 1]);
  });

  it('is null with more numbers than are drawn one by one', () => {
    expect(orderLevels(Array.from({length: MAX_LEVELS}, () => FILL | STROKE))).not.toBeNull();
    expect(orderLevels(Array.from({length: MAX_LEVELS + 1}, () => FILL | STROKE))).toBeNull();
  });
});

describe('drawLevels', () => {
  it('finds the parts of every buffer per number', () => {
    // in the source out of order: the buffers are in the order of the numbers
    const {starts, sets} = build([point(0, 2), square(10, 3), line(20, 1, 4), point(30, 1), square(40, 1), line(50, 3, 2), point(60, 3)]);
    expect(starts!.z).toEqual([1, 2, 3]);
    const levels = drawLevels(starts, sets)!;
    expect(levels).toHaveLength(3);
    // a square is 2 triangles of fill and 4 segments of stroke, a line of n vertices n - 1 segments
    expect(levels[0]).toEqual({fill: [0, 6], edge: null, stroke: [0, 3 + 4], symbol: [0, 1]});
    expect(levels[1]).toEqual({fill: null, edge: null, stroke: null, symbol: [1, 1]});
    expect(levels[2]).toEqual({fill: [6, 6], edge: null, stroke: [7, 4 + 1], symbol: [2, 1]});
    // all of every buffer is in one part
    expect(sets.polygons.indices.length).toBe(12);
    expect(sets.lines.instances.length % 12).toBe(0);
  });

  it('finds the parts of the edges of fills', () => {
    const {starts, sets} = build([square(0, 2), square(10, 1), square(20, 2)], true);
    const levels = drawLevels(starts, sets)!;
    expect(levels.map((l) => l.edge)).toEqual([
      [0, 4],
      [4, 8],
    ]);
    expect(levels.map((l) => l.fill)).toEqual([
      [0, 6],
      [6, 12],
    ]);
  });

  it('is null when a buffer does not hold what was counted', () => {
    const {starts, sets} = build([point(0, 2), line(20, 1), point(30, 1)]);
    expect(drawLevels(starts, sets)).not.toBeNull();
    const fewer = {...sets, points: {...sets.points, instances: sets.points.instances.subarray(0, 3)}};
    expect(drawLevels(starts, fewer)).toBeNull();
    expect(drawLevels(null, sets)).toBeNull();
  });
});
