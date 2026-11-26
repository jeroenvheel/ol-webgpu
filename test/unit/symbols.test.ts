/**
 * Which symbols take part in decluttering, and the space they take
 * (render/symbols.ts).
 */
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import {describe, expect, it} from 'vitest';
import {buildSymbolEvaluator} from '../../src/render/symbols.js';

const feature = (properties: Record<string, unknown> = {}) => new Feature({geometry: new Point([0, 0]), ...properties});
const RED = [255, 0, 0, 1];

describe('buildSymbolEvaluator', () => {
  it('is null when no symbol has a declutter mode', () => {
    expect(buildSymbolEvaluator({'circle-radius': 5, 'circle-fill-color': RED}, {}, () => 0)).toBeNull();
    expect(buildSymbolEvaluator({'circle-radius': 5, 'circle-fill-color': RED, 'circle-declutter-mode': 'none'}, {}, () => 0)).toBeNull();
    // a mode for a symbol the style does not have
    expect(buildSymbolEvaluator({'stroke-width': 2, 'stroke-color': RED, 'circle-declutter-mode': 'declutter'} as any, {}, () => 0)).toBeNull();
  });

  it('gives the box of a circle, with its stroke and its displacement', () => {
    const symbol = buildSymbolEvaluator(
      {
        'circle-radius': ['get', 'size'],
        'circle-fill-color': RED,
        'circle-stroke-width': 2,
        'circle-stroke-color': RED,
        'circle-displacement': [4, -6],
        'circle-declutter-mode': 'declutter',
      },
      {},
      () => 0,
    )!;
    expect({...symbol(feature({size: 9}), 1)}).toEqual({x: 4, y: -6, halfWidth: 10, halfHeight: 10, obstacle: false, rotation: 0, rotateWithView: false, round: true});
    // nothing is drawn without a radius
    expect(symbol(feature(), 1)).toBeNull();
  });

  it('gives an icon its own width and height and how it is turned, not the square around it', () => {
    const symbol = buildSymbolEvaluator(
      {'icon-src': 'data:,', 'icon-width': 40, 'icon-height': 10, 'icon-rotation': ['get', 'angle'], 'icon-rotate-with-view': true, 'icon-declutter-mode': 'declutter'} as any,
      {},
      () => 0,
    )!;
    expect(symbol(feature({angle: Math.PI / 2}), 1)).toMatchObject({halfWidth: 20, halfHeight: 5, rotation: Math.PI / 2, rotateWithView: true, round: false});
  });

  it('tells an obstacle', () => {
    const symbol = buildSymbolEvaluator({'shape-points': 4, 'shape-radius': 8, 'shape-fill-color': RED, 'shape-declutter-mode': 'obstacle'}, {}, () => 0)!;
    expect(symbol(feature(), 1)).toMatchObject({halfWidth: 8, halfHeight: 8, obstacle: true});
  });

  it('takes the first style whose filter the feature passes', () => {
    const style = [
      {filter: ['==', ['get', 'kind'], 'big'], style: {'circle-radius': 20, 'circle-fill-color': RED, 'circle-declutter-mode': 'declutter'}},
      {else: true, style: {'circle-radius': 3, 'circle-fill-color': RED}},
    ];
    const symbol = buildSymbolEvaluator(style as any, {}, () => 0)!;
    expect(symbol(feature({kind: 'big'}), 1)).toMatchObject({halfWidth: 20});
    // the style of the others has no mode: they are not placed
    expect(symbol(feature({kind: 'small'}), 1)).toBeNull();
  });
});
