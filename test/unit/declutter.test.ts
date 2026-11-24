/**
 * Decluttering of GPU text: the collision grid, and the choice of the
 * labels that get glyphs (text/declutter.ts).
 */
import {describe, expect, it} from 'vitest';
import {Occupancy, selectCandidates} from '../../src/text/declutter.js';
import {type LabelSet, MODE_DECLUTTER, MODE_NONE, MODE_OBSTACLE, PART_DOUBLES} from '../../src/text/layout.js';

/** A measured label set of point labels: [x, y, half width, half height, mode?] each, in priority order. */
function labels(list: Array<[number, number, number, number, number?]>, resolution = 1, rotation = 0): LabelSet {
  const count = list.length;
  const parts = new Float64Array(count * PART_DOUBLES);
  list.forEach(([x, y, w, h], i) => parts.set([x, y, 0, 0, 0, 0, -w, -h, w, h, 1, 0], i * PART_DOUBLES));
  const range = (offset: number) => Uint32Array.from(list, (_l, i) => i + offset);
  return {
    id: 1,
    origin: [0, 0],
    resolution,
    rotation,
    generation: 1,
    page: {generation: 1, version: 0, canvas: null!},
    atlasVersion: 0,
    instances: new Float32Array(0),
    glyphCount: 0,
    count,
    features: list.map(() => ({}) as any),
    keys: Float64Array.from(list, (_l, i) => 100 + i),
    content: Float64Array.from(list, (_l, i) => 100 + i),
    glyphMid: new Uint32Array(list.length),
    along: new Float32Array(list.length * 2),
    twoWay: false,
    glyphStart: new Uint32Array(count),
    glyphEnd: new Uint32Array(count),
    partStart: range(0),
    partEnd: range(1),
    mode: Uint8Array.from(list, (l) => l[4] ?? MODE_DECLUTTER),
    parts,
    order: range(0),
    hasLine: false,
  };
}

describe('Occupancy', () => {
  it('finds overlapping boxes, also across grid cells and at negative coordinates', () => {
    const o = new Occupancy();
    o.insert(10, 10, 30, 20);
    o.insert(-500, -40, -300, -20);
    expect(o.collides(25, 15, 60, 40)).toBe(true);
    expect(o.collides(30, 10, 60, 20)).toBe(false); // touching is not overlapping
    expect(o.collides(0, 21, 100, 40)).toBe(false);
    expect(o.collides(-320, -30, -100, 100)).toBe(true);
    expect(o.collides(-299, -30, -100, 100)).toBe(false);
  });
});

describe('selectCandidates', () => {
  it('keeps the winners and the best of the losers', () => {
    // 0 and 1 overlap, 2 overlaps 1 only, 3 overlaps all of them, 4 is free
    const set = labels([
      [0, 0, 20, 5],
      [30, 0, 20, 5],
      [60, 0, 15, 5],
      [30, 2, 60, 5],
      [0, 100, 20, 5],
    ]);
    // round 1: 0, 2 and 4 win; round 2 among 1 and 3: 1 wins
    expect([...selectCandidates(set)].sort()).toEqual([100, 101, 102, 104]);
  });

  it('places at the resolution the labels were laid out for', () => {
    const near = labels(
      [
        [0, 0, 20, 5],
        [100, 0, 20, 5],
      ],
      1,
    );
    expect(selectCandidates(near).size).toBe(2);
    // the same labels 4 times closer together on screen: still both, as the loser is kept
    const far = labels(
      [
        [0, 0, 20, 5],
        [100, 0, 20, 5],
        [200, 0, 20, 5],
        [300, 0, 20, 5],
      ],
      10,
    );
    // on screen they are 10 px apart and 40 px wide: one winner per round
    expect([...selectCandidates(far)].sort()).toEqual([100, 101]);
  });

  it('always keeps labels that do not declutter, and lets obstacles take space', () => {
    const set = labels([
      [0, 0, 20, 5, MODE_OBSTACLE],
      [0, 0, 20, 5, MODE_OBSTACLE],
      [5, 0, 20, 5, MODE_NONE],
      [10, 0, 20, 5, MODE_DECLUTTER],
    ]);
    // the label that declutters is behind an obstacle in both rounds
    expect([...selectCandidates(set)].sort()).toEqual([100, 101, 102]);
  });
});
