/**
 * The rings of polygons as lines for the soft edge of fills (worker/build.ts).
 */
import {describe, expect, it} from 'vitest';
import {edgeInstructions} from '../../src/worker/build.js';

/** Twice the area of a ring of x, y, m triples: positive when counterclockwise. */
function area2(line: number[]): number {
  let sum = 0;
  for (let k = 0, j = line.length - 3; k < line.length; j = k, k += 3) {
    sum += line[j] * line[k + 1] - line[k] * line[j + 1];
  }
  return sum;
}

/** Splits line instructions `[custom.., count, (x, y, m)..]`. */
function lines(instructions: Float32Array, customSize: number): Array<{custom: number[]; vertices: number[]}> {
  const out = [];
  for (let i = 0; i < instructions.length; ) {
    const custom = Array.from(instructions.subarray(i, i + customSize));
    const count = instructions[i + customSize];
    const start = i + customSize + 1;
    out.push({custom, vertices: Array.from(instructions.subarray(start, start + count * 3))});
    i = start + count * 3;
  }
  return out;
}

describe('edgeInstructions', () => {
  // a square with a square hole, both counterclockwise, then a clockwise triangle
  const square = [0, 0, 10, 0, 10, 10, 0, 10, 0, 0];
  const hole = [2, 2, 8, 2, 8, 8, 2, 8, 2, 2];
  const triangle = [20, 0, 20, 10, 30, 0, 20, 0];
  const polygons = Float32Array.from([7, 0.5, 2, 5, 5, ...square, ...hole, 9, 0.25, 1, 4, ...triangle]);

  it('makes a line of every ring, with the attributes of its polygon', () => {
    const out = lines(edgeInstructions(polygons, 2), 2);
    expect(out.map((l) => l.custom)).toEqual([[7, 0.5], [7, 0.5], [9, 0.25]]);
    expect(out.map((l) => l.vertices.length / 3)).toEqual([5, 5, 4]);
    expect(out[0].vertices).toEqual([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 0]);
  });

  it('has the fill on the left of every ring', () => {
    const out = lines(edgeInstructions(polygons, 2), 2);
    // outer rings counterclockwise, holes clockwise
    expect(area2(out[0].vertices)).toBeGreaterThan(0);
    expect(area2(out[1].vertices)).toBeLessThan(0);
    expect(area2(out[2].vertices)).toBeGreaterThan(0);
    // turned around, a ring still starts and ends at the same point
    expect(out[1].vertices.slice(0, 2)).toEqual(out[1].vertices.slice(-3, -1));
    expect(out[2].vertices).toEqual([20, 0, 0, 30, 0, 0, 20, 10, 0, 20, 0, 0]);
  });

  it('stops at input that is cut off', () => {
    expect(edgeInstructions(polygons.subarray(0, 12), 2).length).toBe(0);
    expect(lines(edgeInstructions(polygons.subarray(0, 30), 2), 2).length).toBe(2);
    expect(edgeInstructions(new Float32Array(0), 2).length).toBe(0);
  });
});
