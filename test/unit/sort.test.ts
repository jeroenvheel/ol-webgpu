/** Sorting in slices (render/sort.ts). */
import {describe, expect, it} from 'vitest';
import {type Less, Merger, Sorter} from '../../src/render/sort.js';

/** Steps until done; how often it stopped on the way. `deadline` 0 has always passed: a stop at every look at the clock. */
function finish(task: {step(deadline: number): boolean}, deadline = Infinity): number {
  let stops = 0;
  while (!task.step(deadline)) {
    stops++;
    if (stops > 1e7) {
      throw new Error('does not end');
    }
  }
  return stops;
}

const values = (n: number, different: number) => Array.from({length: n}, (_v, i) => (i * 7919 + 13) % different);
const positions = (n: number) => Uint32Array.from({length: n}, (_v, i) => i);
const sortedPositions = (v: number[]) => Array.from(positions(v.length)).sort((a, b) => v[a] - v[b] || a - b);

describe('Sorter', () => {
  it('sorts as Array.sort does with the same total order', () => {
    for (const [n, different] of [
      [0, 1],
      [1, 1],
      [2, 2],
      [3, 2],
      [1000, 7],
      [1000, 100_000],
      [3333, 50],
    ]) {
      const v = values(n, different);
      const less: Less = (a, b) => (v[a] - v[b] || a - b) < 0;
      const items = positions(n);
      finish(new Sorter(items, 0, n, less));
      expect(Array.from(items)).toEqual(sortedPositions(v));
    }
  });

  it('sorts a part and leaves the rest', () => {
    const v = [9, 8, 7, 3, 1, 2, 0, 5, 4];
    const items = positions(v.length);
    finish(new Sorter(items, 3, 7, (a, b) => v[a] < v[b]));
    expect(Array.from(items)).toEqual([0, 1, 2, 6, 4, 5, 3, 7, 8]);
  });

  it('asks one comparison per item for what is in order', () => {
    let asked = 0;
    const items = positions(1000);
    finish(
      new Sorter(items, 0, 1000, (a, b) => {
        asked++;
        return a < b;
      }),
    );
    expect(asked).toBe(999);
    // a long one is taken in parts, which costs one more per part
    asked = 0;
    const long = positions(100_000);
    finish(
      new Sorter(long, 0, 100_000, (a, b) => {
        asked++;
        return a < b;
      }),
    );
    expect(asked).toBeLessThan(100_100);
  });

  it('gives the same result when it stops on the way', () => {
    const v = values(5000, 1000);
    const less: Less = (a, b) => (v[a] - v[b] || a - b) < 0;
    const whole = positions(5000);
    expect(finish(new Sorter(whole, 0, 5000, less))).toBe(0);
    const sliced = positions(5000);
    expect(finish(new Sorter(sliced, 0, 5000, less), 0)).toBeGreaterThan(50);
    expect(Array.from(sliced)).toEqual(Array.from(whole));
    expect(Array.from(whole)).toEqual(sortedPositions(v));
  });
});

describe('Merger', () => {
  const sortedParts = (v: number[], middle: number) => {
    const order = (from: number, to: number) => Array.from({length: to - from}, (_v, i) => from + i).sort((a, b) => v[a] - v[b] || a - b);
    return Uint32Array.from([...order(0, middle), ...order(middle, v.length)]);
  };

  it('puts a few items into a long list with few comparisons', () => {
    const v = values(10_000, 100_000);
    const middle = 9_990;
    let asked = 0;
    const less: Less = (a, b) => {
      asked++;
      return (v[a] - v[b] || a - b) < 0;
    };
    const merger = new Merger(sortedParts(v, middle), middle, less);
    finish(merger);
    expect(Array.from(merger.result)).toEqual(sortedPositions(v));
    expect(asked).toBeLessThan(10 * 15);
  });

  it('looks up the places of a few items in slices too', () => {
    const v = values(20_000, 100_000);
    const middle = 19_900;
    const less: Less = (a, b) => (v[a] - v[b] || a - b) < 0;
    const merger = new Merger(sortedParts(v, middle), middle, less);
    expect(finish(merger, 0)).toBeGreaterThan(3);
    expect(Array.from(merger.result)).toEqual(sortedPositions(v));
  });

  it('merges two long lists, also when it stops on the way', () => {
    const v = values(4000, 300);
    const less: Less = (a, b) => (v[a] - v[b] || a - b) < 0;
    const whole = new Merger(sortedParts(v, 2500), 2500, less);
    finish(whole);
    expect(Array.from(whole.result)).toEqual(sortedPositions(v));
    const sliced = new Merger(sortedParts(v, 2500), 2500, less);
    expect(finish(sliced, 0)).toBeGreaterThan(5);
    expect(Array.from(sliced.result)).toEqual(sortedPositions(v));
  });

  it('returns what it got when one of the parts is empty', () => {
    const items = Uint32Array.from([0, 1, 2]);
    for (const middle of [0, 3]) {
      const merger = new Merger(items, middle, () => false);
      finish(merger);
      expect(merger.result).toBe(items);
    }
  });
});
