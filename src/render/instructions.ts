/**
 * Render instructions for the worker, in the layout of ol's
 * `ol/render/webgl/renderinstructions.js` (ol 10.11) and with the same
 * values, but the custom attributes of a feature are computed once and
 * kept: they follow from the feature and the style, not from the view. A
 * rebuild then only transforms coordinates and copies numbers, where ol
 * calls every attribute callback for every geometry on each rebuild.
 *
 * The values are kept in one array, at the position of the feature's ref in
 * the batch. A ref goes to another feature once its feature is removed, and
 * a changed feature keeps its ref: whoever changes the batch calls `forget`
 * for the feature first (or `reset` when the batch is cleared).
 */
import {UNDEFINED_PROP_VALUE} from 'ol/expr/gpu.js';
import type {Transform} from 'ol/transform.js';
import {getUid} from 'ol/util.js';
import type {AttributeDefinition} from './stylePasses.js';
import {type Less, Merger, Sorter} from './sort.js';

/** An entry of ol's MixedGeometryBatch. */
interface BatchEntry {
  feature: unknown;
  flatCoordss: number[][];
  ref?: number;
  ringsVerticesCounts?: number[][];
}

interface PointBatch {
  entries: Record<string, BatchEntry>;
  geometriesCount: number;
}
interface LineStringBatch extends PointBatch {
  verticesCount: number;
}
interface PolygonBatch extends LineStringBatch {
  ringsCount: number;
}

/** The part of ol's MixedGeometryBatch that tells the ref of a feature. */
interface Batch {
  pointBatch: PointBatch;
  lineStringBatch: PointBatch;
  polygonBatch: PointBatch;
}

export type InstructionKind = 'points' | 'lines' | 'polygons';

/** The order of the features in the instructions, when it is not the order of the batch (see order.ts). */
export interface InstructionOrder {
  /** A number per feature: lower ones come first. */
  key: ((feature: any) => number) | null;
  /** The numbers do not follow from the features alone: they are not kept between builds. */
  volatile: boolean;
  /** Compares two features with the same number (the `renderOrder` of the layer). */
  compare: ((a: any, b: any) => number) | null;
}

/** The entries of a batch being put in order (see `InstructionBuilder.startOrdering`). */
interface Ordering {
  kind: InstructionKind;
  /** As they are in the batch. */
  entries: BatchEntry[];
  /** The number of each entry (null: there are none). */
  z: Float64Array | null;
  /** 0: the numbers, 1: who has a place from the last build, 2: sorting the others, 3: putting them among the first, 4: the result. */
  phase: number;
  /** Where the phase is. */
  i: number;
  others: number;
  index: Uint32Array | null;
  slots: Uint32Array | null;
  sorter: Sorter | null;
  merger: Merger | null;
  /** The entries in order, and their numbers. */
  result: BatchEntry[] | null;
  resultZ: Float64Array | null;
}

/** Instructions of one kind in the making (see `InstructionBuilder.start`). */
export interface InstructionRun {
  kind: InstructionKind;
  transform: Transform;
  /** The entries in the order to draw them in, once `ordering` is done, and the number of each (null: all the same). */
  entries: BatchEntry[];
  z: Float64Array | null;
  /** Puts the entries in order, in slices (see `InstructionBuilder.startOrdering`); null when that is done or not needed. */
  ordering: Ordering | null;
  /** The next entry, and where its instructions go. */
  n: number;
  k: number;
  /** The instructions; null when they cannot be made here (see `usable`). */
  out: Float32Array | null;
  done: boolean;
}

/**
 * The instructions of a build, made in slices: `step` works until a
 * deadline and tells whether everything is made. The batch must not change
 * between the slices (the caller starts over when it does).
 */
export class InstructionJob {
  private readonly runs: InstructionRun[] = [];
  /** Milliseconds worked so far. */
  time = 0;
  /** Slices worked so far. */
  slices = 0;

  constructor(
    private readonly builder: InstructionBuilder,
    batches: {polygons: PolygonBatch | null; lines: LineStringBatch | null; points: PointBatch | null},
    transform: Transform,
  ) {
    if (batches.polygons) {
      this.runs.push(builder.start('polygons', batches.polygons, transform));
    }
    if (batches.lines) {
      this.runs.push(builder.start('lines', batches.lines, transform));
    }
    if (batches.points) {
      this.runs.push(builder.start('points', batches.points, transform));
    }
  }

  /** Works until `deadline` (`performance.now()`); true when all instructions are made. */
  step(deadline: number): boolean {
    const t0 = performance.now();
    this.slices++;
    let done = true;
    for (const run of this.runs) {
      if (!run.done && !this.builder.step(run, deadline)) {
        done = false;
        break;
      }
    }
    this.time += performance.now() - t0;
    return done;
  }

  /** The instructions of a kind: undefined when not asked for, null when they cannot be made here. */
  result(kind: InstructionKind): Float32Array | null | undefined {
    return this.runs.find((r) => r.kind === kind)?.out;
  }
}

/** How many entries are made between two looks at the clock. */
const CLOCK_EVERY = 256;

export class InstructionBuilder {
  private readonly callbacks: Array<AttributeDefinition['callback']> = [];
  private readonly sizes: number[] = [];
  /** Floats per feature (attribute sizes are 1 to 4, as in ol). */
  private readonly customSize: number;
  private values = new Float32Array(0);
  /** Per ref: 1 when `values` holds the attributes of its feature. */
  private known = new Uint8Array(0);
  /**
   * False once a callback returned a string: ol writes those into the labels
   * array of the rebuild, which cannot be kept. The generators then return
   * null and the caller uses ol's.
   */
  private usable = true;
  private order: InstructionOrder | null = null;
  /** Per ref: the number of `order.key` for its feature, where `keyKnown` is 1. */
  private keys = new Float64Array(0);
  private keyKnown = new Uint8Array(0);
  /** Per kind and ref: the place of its entry in the order of the last build, where `known` is 1. */
  private places: Partial<Record<InstructionKind, {at: Uint32Array; known: Uint8Array; count: number}>> = {};

  /** Sets the order of the features in the instructions (null: as they are in the batch). */
  setOrder(order: InstructionOrder | null) {
    this.order = order && (order.key || order.compare) ? order : null;
    this.keys = new Float64Array(0);
    this.keyKnown = new Uint8Array(0);
    this.places = {};
  }

  /**
   * Puts the entries of a batch in the order to draw them in, in slices:
   * `stepOrdering` until it returns true.
   *
   * With a comparison of the app the order of the last build is kept per
   * kind: entries that are in the batch as they were then are in that order
   * still, and only the others are sorted and put among them.
   */
  private startOrdering(kind: InstructionKind, entries: BatchEntry[]): Ordering | null {
    const order = this.order;
    if (!order || entries.length < 2) {
      return null;
    }
    if (order.key && order.volatile) {
      this.keyKnown.fill(0);
    }
    return {kind, entries, z: order.key ? new Float64Array(entries.length) : null, phase: 0, i: 0, others: 0, index: null, slots: null, sorter: null, merger: null, result: null, resultZ: null};
  }

  /** Works until `deadline`; true when `result` and `resultZ` are there. */
  private stepOrdering(o: Ordering, deadline: number): boolean {
    const order = this.order!;
    if (o.phase === 0) {
      if (order.key && !this.stepKeys(o, order.key, deadline)) {
        return false;
      }
      if (!order.compare) {
        this.orderByNumber(o);
        return true;
      }
      o.phase = 1;
    }
    if (o.phase === 1) {
      if (!this.stepPlaces(o, order, deadline)) {
        return false;
      }
      o.phase = 2;
    }
    if (o.phase === 2) {
      if (!o.sorter!.step(deadline)) {
        return false;
      }
      o.sorter = null;
      o.phase = 3;
    }
    if (o.phase === 3) {
      if (!o.merger!.step(deadline)) {
        return false;
      }
      o.phase = 4;
    }
    return this.stepResult(o, deadline);
  }

  /** The numbers of the entries (`z`), asked once per feature. */
  private stepKeys(o: Ordering, key: (feature: any) => number, deadline: number): boolean {
    const entries = o.entries;
    const z = o.z!;
    for (let i = o.i, n = entries.length; i < n; i++) {
      const ref = entries[i].ref ?? 0;
      if (ref >= this.keyKnown.length) {
        const capacity = Math.max(this.keyKnown.length * 2, ref + 1, 1024);
        const keys = new Float64Array(capacity);
        keys.set(this.keys);
        this.keys = keys;
        const known = new Uint8Array(capacity);
        known.set(this.keyKnown);
        this.keyKnown = known;
      }
      if (this.keyKnown[ref] !== 1) {
        this.keys[ref] = key(entries[i].feature);
        this.keyKnown[ref] = 1;
        z[i] = this.keys[ref];
        if (i % CLOCK_EVERY === 0 && performance.now() >= deadline) {
          o.i = i + 1;
          return false;
        }
      } else {
        z[i] = this.keys[ref];
      }
    }
    return true;
  }

  /** The order by number alone, without a comparison per pair. */
  private orderByNumber(o: Ordering) {
    const entries = o.entries;
    const z = o.z!;
    const n = entries.length;
    // mostly they are in order already (all the same number, or as they came)
    let sorted = true;
    for (let i = 1; i < n && sorted; i++) {
      sorted = z[i] >= z[i - 1];
    }
    if (sorted) {
      o.result = entries;
      o.resultZ = z;
      return;
    }
    // The different numbers in order (the sort of a typed array), the place of every
    // entry among them, and then the entries per number, in their own order.
    const out: BatchEntry[] = new Array(n);
    const zOut = new Float64Array(n);
    const different = z.slice().sort();
    let m = 0;
    for (let i = 0; i < n; i++) {
      if (i === 0 || different[i] !== different[m - 1]) {
        different[m++] = different[i];
      }
    }
    const rank = new Uint32Array(n);
    const starts = new Uint32Array(m + 1);
    for (let i = 0; i < n; i++) {
      const value = z[i];
      let low = 0;
      let high = m - 1;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (different[middle] < value) {
          low = middle + 1;
        } else {
          high = middle;
        }
      }
      rank[i] = low;
      starts[low + 1]++;
    }
    for (let r = 0; r < m; r++) {
      starts[r + 1] += starts[r];
    }
    for (let i = 0; i < n; i++) {
      const at = starts[rank[i]]++;
      out[at] = entries[i];
      zOut[at] = z[i];
    }
    o.result = out;
    o.resultZ = zOut;
  }

  /**
   * With a comparison: the entries that have their place from the last build
   * first, in that order, then the others. True when that is done.
   */
  private stepPlaces(o: Ordering, order: InstructionOrder, deadline: number): boolean {
    const entries = o.entries;
    const n = entries.length;
    const place = (this.places[o.kind] ??= {at: new Uint32Array(0), known: new Uint8Array(0), count: 0});
    if (!o.index) {
      o.index = new Uint32Array(n);
      // numbers that do not follow from the features alone may all be different now
      o.slots = place.count && !(order.key && order.volatile) ? new Uint32Array(place.count) : null;
      o.i = n - 1;
      o.others = n;
    }
    const index = o.index;
    const slots = o.slots; // per place of the last build: the entry, plus one
    let kept = 0;
    if (slots) {
      let others = o.others;
      for (let i = o.i; i >= 0; i--) {
        const ref = entries[i].ref ?? 0;
        if (ref < place.known.length && place.known[ref] === 1 && slots[place.at[ref]] === 0) {
          slots[place.at[ref]] = i + 1;
        } else {
          index[--others] = i; // from the end: the others stay as they are in the batch
        }
        if (i % CLOCK_EVERY === 0 && performance.now() >= deadline) {
          o.i = i - 1;
          o.others = others;
          return false;
        }
      }
      for (let k = 0; k < slots.length; k++) {
        if (slots[k]) {
          index[kept++] = slots[k] - 1;
        }
      }
      o.slots = null;
    } else {
      for (let i = 0; i < n; i++) {
        index[i] = i;
      }
    }
    const z = o.z;
    const compare = order.compare!;
    // a total order: the number, the comparison, the place in the batch
    const less: Less = z
      ? (a, b) => (z[a] - z[b] || compare(entries[a].feature, entries[b].feature) || a - b) < 0
      : (a, b) => (compare(entries[a].feature, entries[b].feature) || a - b) < 0;
    o.sorter = new Sorter(index, kept, n, less);
    o.merger = new Merger(index, kept, less);
    o.i = 0;
    return true;
  }

  /** The entries in their order, and the place of each for the next build. True when that is done. */
  private stepResult(o: Ordering, deadline: number): boolean {
    const entries = o.entries;
    const n = entries.length;
    const z = o.z;
    const index = o.merger!.result;
    const place = this.places[o.kind]!;
    if (!o.result) {
      place.known.fill(0);
      place.count = 0; // until all places are there
      o.result = new Array(n);
      o.resultZ = z ? new Float64Array(n) : null;
      o.i = 0;
    }
    const out = o.result;
    const zOut = o.resultZ;
    for (let i = o.i; i < n; i++) {
      const entry = entries[index[i]];
      out[i] = entry;
      if (zOut) {
        zOut[i] = z![index[i]];
      }
      const ref = entry.ref ?? 0;
      if (ref >= place.at.length) {
        const capacity = Math.max(place.at.length * 2, ref + 1, 1024);
        const at = new Uint32Array(capacity);
        at.set(place.at);
        place.at = at;
        const known = new Uint8Array(capacity);
        known.set(place.known);
        place.known = known;
      }
      place.at[ref] = i;
      place.known[ref] = 1;
      if (i % CLOCK_EVERY === 0 && performance.now() >= deadline) {
        o.i = i + 1;
        return false;
      }
    }
    place.count = n;
    o.merger = null;
    o.index = null;
    return true;
  }

  constructor(customAttributes: Record<string, AttributeDefinition>) {
    let customSize = 0;
    for (const name in customAttributes) {
      const size = customAttributes[name].size || 1;
      this.callbacks.push(customAttributes[name].callback);
      this.sizes.push(size);
      customSize += size;
    }
    this.customSize = customSize;
  }

  /** Forgets all values (the batch was cleared) and frees their memory. */
  reset() {
    this.values = new Float32Array(0);
    this.known = new Uint8Array(0);
    this.keys = new Float64Array(0);
    this.keyKnown = new Uint8Array(0);
    this.places = {};
  }

  /**
   * To call before `feature` is changed in or removed from the batch: its
   * values are computed again when its ref is next used.
   */
  forget(batch: Batch, feature: unknown) {
    const uid = getUid(feature);
    const entry = batch.pointBatch.entries[uid] ?? batch.lineStringBatch.entries[uid] ?? batch.polygonBatch.entries[uid];
    const ref = entry?.ref;
    if (ref !== undefined && ref < this.known.length) {
      this.known[ref] = 0;
    }
    if (ref !== undefined && ref < this.keyKnown.length) {
      this.keyKnown[ref] = 0;
    }
    if (ref !== undefined) {
      for (const kind in this.places) {
        const place = this.places[kind as InstructionKind]!;
        if (ref < place.known.length) {
          place.known[ref] = 0;
        }
      }
    }
  }

  /** Position of the entry's values in `values` (-1: not usable, see `usable`). */
  private slot(entry: BatchEntry): number {
    const size = this.customSize;
    const ref = entry.ref ?? 0;
    const at = ref * size;
    if (this.known[ref] === 1) {
      return at;
    }
    if (ref >= this.known.length) {
      const capacity = Math.max(this.known.length * 2, ref + 1, 1024);
      const values = new Float32Array(capacity * size);
      values.set(this.values);
      this.values = values;
      const known = new Uint8Array(capacity);
      known.set(this.known);
      this.known = known;
    }
    const values = this.values;
    let k = at;
    for (let i = 0, ii = this.callbacks.length; i < ii; i++) {
      // same handling of the value as ol's pushCustomAttributesInRenderInstructions
      const value: unknown = this.callbacks[i].call(entry, entry.feature);
      if (typeof value === 'string') {
        this.usable = false;
        return -1;
      }
      const array = Array.isArray(value) ? value : undefined;
      let first = array ? array[0] : value;
      if (first === UNDEFINED_PROP_VALUE) {
        console.warn('The "has" operator might return false positives.');
      }
      if (first === undefined) {
        first = UNDEFINED_PROP_VALUE;
      } else if (first === null) {
        first = 0;
      }
      values[k++] = first as number;
      for (let j = 1, jj = Math.min(this.sizes[i], 4); j < jj; j++) {
        values[k++] = array?.[j] ?? UNDEFINED_PROP_VALUE;
      }
    }
    this.known[ref] = 1;
    return at;
  }

  /** Starts the instructions of one kind, to make with `step`. */
  start(kind: InstructionKind, batch: PointBatch | LineStringBatch | PolygonBatch, transform: Transform): InstructionRun {
    const size = this.customSize;
    const length =
      kind === 'points'
        ? (2 + size) * batch.geometriesCount
        : kind === 'lines'
          ? 3 * (batch as LineStringBatch).verticesCount + (1 + size) * batch.geometriesCount
          : 2 * (batch as PolygonBatch).verticesCount + (1 + size) * batch.geometriesCount + (batch as PolygonBatch).ringsCount;
    const entries = Object.values(batch.entries) as BatchEntry[];
    return {
      kind,
      transform,
      entries,
      z: null,
      // in the order of ol's for-in (and much faster), unless an order is set
      ordering: this.startOrdering(kind, entries),
      n: 0,
      k: 0,
      out: this.usable ? new Float32Array(length) : null,
      done: !this.usable,
    };
  }

  /** Makes instructions until `deadline` (`performance.now()`); true when the run is done. */
  step(run: InstructionRun, deadline: number): boolean {
    if (run.done) {
      return true;
    }
    if (run.ordering) {
      if (!this.stepOrdering(run.ordering, deadline)) {
        return false;
      }
      run.entries = run.ordering.result!;
      run.z = run.ordering.resultZ;
      run.ordering = null;
    }
    const finished = run.kind === 'points' ? this.stepPoints(run, deadline) : run.kind === 'lines' ? this.stepLines(run, deadline) : this.stepPolygons(run, deadline);
    if (finished === null) {
      run.out = null;
      run.done = true;
    } else {
      run.done = finished;
    }
    return run.done;
  }

  /** [x0, y0, customAttr0, ..., xN, yN, customAttrN] */
  points(batch: PointBatch, transform: Transform): Float32Array | null {
    const run = this.start('points', batch, transform);
    this.step(run, Infinity);
    return run.out;
  }

  /** [customAttr0, ..., customAttrN, numberOfVertices0, x0, y0, m0, ..., xN, yN, mN, ...] */
  lines(batch: LineStringBatch, transform: Transform): Float32Array | null {
    const run = this.start('lines', batch, transform);
    this.step(run, Infinity);
    return run.out;
  }

  /** [customAttr0, ..., customAttrN, numberOfRings, numberOfVerticesInRing0, ..., x0, y0, ..., xN, yN, ...] */
  polygons(batch: PolygonBatch, transform: Transform): Float32Array | null {
    const run = this.start('polygons', batch, transform);
    this.step(run, Infinity);
    return run.out;
  }

  /** True when done, false when the deadline came first, null when a value cannot be kept. */
  private stepPoints(run: InstructionRun, deadline: number): boolean | null {
    const size = this.customSize;
    const out = run.out!;
    const [a, b, c, d, e, f] = run.transform;
    let k = run.k;
    const entries = run.entries;
    for (let n = run.n, nn = entries.length; n < nn; n++) {
      if (n % CLOCK_EVERY === 0 && n > run.n && performance.now() >= deadline) {
        run.n = n;
        run.k = k;
        return false;
      }
      const entry = entries[n];
      const at = this.slot(entry);
      if (at < 0) {
        return null;
      }
      const values = this.values;
      const coordss = entry.flatCoordss;
      for (let i = 0, ii = coordss.length; i < ii; i++) {
        const x = coordss[i][0];
        const y = coordss[i][1];
        out[k++] = a * x + c * y + e;
        out[k++] = b * x + d * y + f;
        for (let j = 0; j < size; j++) {
          out[k++] = values[at + j];
        }
      }
    }
    return true;
  }

  private stepLines(run: InstructionRun, deadline: number): boolean | null {
    const size = this.customSize;
    const out = run.out!;
    const [a, b, c, d, e, f] = run.transform;
    let k = run.k;
    const entries = run.entries;
    for (let n = run.n, nn = entries.length; n < nn; n++) {
      if (n % CLOCK_EVERY === 0 && n > run.n && performance.now() >= deadline) {
        run.n = n;
        run.k = k;
        return false;
      }
      const entry = entries[n];
      const at = this.slot(entry);
      if (at < 0) {
        return null;
      }
      const values = this.values;
      const coordss = entry.flatCoordss;
      for (let i = 0, ii = coordss.length; i < ii; i++) {
        const flat = coordss[i];
        for (let j = 0; j < size; j++) {
          out[k++] = values[at + j];
        }
        out[k++] = flat.length / 3;
        for (let j = 0, jj = flat.length; j < jj; j += 3) {
          const x = flat[j];
          const y = flat[j + 1];
          out[k++] = a * x + c * y + e;
          out[k++] = b * x + d * y + f;
          out[k++] = flat[j + 2];
        }
      }
    }
    return true;
  }

  private stepPolygons(run: InstructionRun, deadline: number): boolean | null {
    const size = this.customSize;
    const out = run.out!;
    const [a, b, c, d, e, f] = run.transform;
    let k = run.k;
    const entries = run.entries;
    for (let n = run.n, nn = entries.length; n < nn; n++) {
      if (n % CLOCK_EVERY === 0 && n > run.n && performance.now() >= deadline) {
        run.n = n;
        run.k = k;
        return false;
      }
      const entry = entries[n];
      const at = this.slot(entry);
      if (at < 0) {
        return null;
      }
      const values = this.values;
      const coordss = entry.flatCoordss;
      for (let i = 0, ii = coordss.length; i < ii; i++) {
        const rings = entry.ringsVerticesCounts?.[i];
        if (!rings) {
          continue;
        }
        const flat = coordss[i];
        for (let j = 0; j < size; j++) {
          out[k++] = values[at + j];
        }
        out[k++] = rings.length;
        for (let j = 0, jj = rings.length; j < jj; j++) {
          out[k++] = rings[j];
        }
        for (let j = 0, jj = flat.length; j < jj; j += 2) {
          const x = flat[j];
          const y = flat[j + 1];
          out[k++] = a * x + c * y + e;
          out[k++] = b * x + d * y + f;
        }
      }
    }
    return true;
  }
}

/**
 * Lets the page do what is waiting (input, a frame) before the work goes on:
 * a message to itself. A timer would wait 4 ms each time, and after
 * `scheduler.yield()` the work goes on before the next frame is drawn, so
 * frames would wait for all of it.
 */
export function pause(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}
