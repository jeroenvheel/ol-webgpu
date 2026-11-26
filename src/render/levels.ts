/**
 * Drawing by `z-index`: fills, strokes and symbols of one number before
 * those of the next.
 *
 * A layer draws per style all fills, then all strokes, then all symbols,
 * each kind from one buffer. With a `z-index` that is an expression the
 * features are in every buffer in the order of their numbers (order.ts),
 * so the features of one number are one range of each buffer. Drawing the
 * ranges of the first number from all buffers, then those of the second,
 * and so on, puts a fill with a higher number over the stroke and the
 * symbol of a lower one, as ol's Canvas layers do.
 *
 * Where the range of a number starts is counted while the instructions are
 * made (`LevelStarts`): in instances for points and lines (one per point,
 * one per segment), in vertices for polygons. Polygons are drawn by index:
 * the triangles of a polygon point at its own vertices, which lie after
 * those of the polygons before it, so the first index of a range is the
 * first one that points at or after its first vertex.
 *
 * A range per number is a draw call per number, kind, style and world, so
 * it is done for up to `MAX_LEVELS` different numbers; with more the layer
 * draws kind by kind as before.
 */

/** With more different numbers than this, the kinds are not drawn number by number. */
export const MAX_LEVELS = 64;

/** A `renderOrder` is turned into numbers for layers of up to this many features (see `orderLevels`). */
export const MAX_ORDERED = 4096;

/**
 * Numbers for the features of a layer with a `renderOrder` and no
 * `z-index`, so that they are drawn as a Canvas layer draws them: all of a
 * feature before the next one, where kind by kind a symbol is over every
 * stroke and a stroke over every fill.
 *
 * A row of features in the order they are drawn in can share a number as
 * long as kind by kind gives the same picture: until a feature has a kind
 * that comes before a kind of an earlier one in the row (a fill after a
 * stroke, a stroke after a symbol). Then the next number starts.
 *
 * @param kinds per feature, in the order of `renderOrder`: its kinds as bits (1 fill, 2 stroke, 4 symbol)
 * @return the number of each feature, or null when one number would do or
 *   there would be more than `MAX_LEVELS`
 */
export function orderLevels(kinds: ArrayLike<number>): Uint32Array | null {
  const out = new Uint32Array(kinds.length);
  let level = 0;
  // the last kind of the row so far: 0 before anything is in it
  let last = 0;
  for (let i = 0; i < kinds.length; i++) {
    const bits = kinds[i];
    if (bits) {
      const first = bits & -bits;
      if (first < last) {
        level++;
        last = 0;
      }
      const highest = bits & 4 ? 4 : bits & 2 ? 2 : 1;
      last = Math.max(last, highest);
    }
    out[i] = level;
  }
  return level === 0 || level + 1 > MAX_LEVELS ? null : out;
}

/** Where the features of each number start, per kind, as counted with the instructions. */
export interface LevelStarts {
  /** The different numbers, rising. */
  z: number[];
  /** Per kind: the start of each number and, last, the end (null: no such kind). */
  points: Uint32Array | null;
  lines: Uint32Array | null;
  /** In vertices. */
  polygons: Uint32Array | null;
  /** The segments of the rings of the polygons (for the soft edge of fills). */
  edges: Uint32Array | null;
}

/** A part of a buffer: the first index (fills) or instance (the others), and how many. */
export type Range = [first: number, count: number];

/** What is drawn for one number, per kind (null: nothing). */
export interface DrawLevel {
  fill: Range | null;
  edge: Range | null;
  stroke: Range | null;
  symbol: Range | null;
}

interface Buffers {
  indices: Uint32Array;
  vertices: Float32Array;
  instances: Float32Array;
}

/** The first position of `indices` with a value of `vertex` or more (they rise from polygon to polygon). */
function firstIndexAt(indices: Uint32Array, vertex: number): number {
  let low = 0;
  let high = indices.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (indices[middle] < vertex) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/** Ranges of instances; null when the buffer does not hold what was counted. */
function instanceRanges(starts: Uint32Array, set: Buffers | null): Range[] | null {
  const total = starts[starts.length - 1];
  if (!set || !total || set.instances.length % total !== 0 || !set.instances.length) {
    return null;
  }
  const ranges: Range[] = [];
  for (let l = 0; l + 1 < starts.length; l++) {
    ranges.push([starts[l], starts[l + 1] - starts[l]]);
  }
  return ranges;
}

/**
 * The ranges to draw per number, from the starts counted with the
 * instructions and the buffers made of them. Null when there is nothing to
 * gain (one number), too much to do (more than `MAX_LEVELS`), or a buffer
 * does not hold what was counted: the layer then draws kind by kind.
 */
export function drawLevels(
  starts: LevelStarts | null,
  sets: {polygons: Buffers | null; edges: Buffers | null; lines: Buffers | null; points: Buffers | null},
): DrawLevel[] | null {
  const count = starts?.z.length ?? 0;
  if (!starts || count < 2 || count > MAX_LEVELS) {
    return null;
  }
  let fill: Range[] | null = null;
  if (starts.polygons && sets.polygons?.indices.length) {
    const {indices, vertices} = sets.polygons;
    const total = starts.polygons[count];
    if (!total || vertices.length % total !== 0) {
      return null;
    }
    fill = [];
    let from = 0;
    for (let l = 0; l < count; l++) {
      const to = l + 1 < count ? firstIndexAt(indices, starts.polygons[l + 1]) : indices.length;
      fill.push([from, to - from]);
      from = to;
    }
  }
  const kinds = {
    edge: [starts.edges, sets.edges],
    stroke: [starts.lines, sets.lines],
    symbol: [starts.points, sets.points],
  } as const;
  const ranges: Record<'edge' | 'stroke' | 'symbol', Range[] | null> = {edge: null, stroke: null, symbol: null};
  for (const kind of ['edge', 'stroke', 'symbol'] as const) {
    const [kindStarts, set] = kinds[kind];
    if (!set?.instances.length) {
      continue; // nothing of this kind is drawn
    }
    if (!kindStarts) {
      return null;
    }
    ranges[kind] = instanceRanges(kindStarts, set);
    if (!ranges[kind]) {
      return null;
    }
  }
  const levels: DrawLevel[] = [];
  const part = (list: Range[] | null, l: number) => (list && list[l][1] > 0 ? list[l] : null);
  for (let l = 0; l < count; l++) {
    const level = {fill: part(fill, l), edge: part(ranges.edge, l), stroke: part(ranges.stroke, l), symbol: part(ranges.symbol, l)};
    if (level.fill || level.edge || level.stroke || level.symbol) {
      levels.push(level);
    }
  }
  return levels.length > 1 ? levels : null;
}

/**
 * The starts of the numbers of all kinds together: every kind gets a start
 * for every number that any kind has (an empty range where it has none).
 * @param kinds per kind `[z, start, z, start, ...]` as counted (rising z) and the end, or null
 * @param tooMany called with the count when there are more numbers than `MAX_LEVELS`
 */
export function mergeStarts(
  kinds: Record<'points' | 'lines' | 'polygons' | 'edges', {levels: number[]; end: number} | null>,
  tooMany?: (count: number) => void,
): LevelStarts | null {
  const all = new Set<number>();
  for (const kind of Object.values(kinds)) {
    for (let i = 0; kind && i < kind.levels.length; i += 2) {
      all.add(kind.levels[i]);
    }
  }
  if (all.size > MAX_LEVELS) {
    tooMany?.(all.size);
  }
  if (all.size < 2 || all.size > MAX_LEVELS) {
    return null;
  }
  const z = [...all].sort((a, b) => a - b);
  const starts = (kind: {levels: number[]; end: number} | null): Uint32Array | null => {
    if (!kind) {
      return null;
    }
    const out = new Uint32Array(z.length + 1);
    let k = 0;
    for (let l = 0; l < z.length; l++) {
      // the first of its own numbers that is not lower
      while (k < kind.levels.length && kind.levels[k] < z[l]) {
        k += 2;
      }
      out[l] = k < kind.levels.length ? kind.levels[k + 1] : kind.end;
    }
    out[z.length] = kind.end;
    return out;
  };
  return {z, points: starts(kinds.points), lines: starts(kinds.lines), polygons: starts(kinds.polygons), edges: starts(kinds.edges)};
}
