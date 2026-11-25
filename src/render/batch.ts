/**
 * The features of a layer, for making render instructions of them.
 *
 * ol's MixedGeometryBatch (ol 10.11) keeps an entry per feature and
 * geometry kind, with a copy of the coordinates of every line and ring
 * (as x, y, m). For the big sources this layer is made for, those entries
 * were most of the memory the layer itself held: about 290 bytes per point
 * and 600 per line of ten vertices, where the geometries hold the same
 * coordinates already.
 *
 * Here a feature has a ref (a small whole number, as in ol) and a few
 * numbers at that ref in typed arrays: no objects and no copies. The
 * coordinates are read from the geometries when instructions are made
 * (`visitGeometry`), in the order ol's batch has them in: by the uid of the
 * feature, which is the order the features were created in.
 *
 * What ol's batch holds can still be made of it (`toOl`), for ol's own
 * instruction generators: they are used with ol's text worker
 * (`text: 'canvas'`). `test/unit/batch.test.ts` checks that it is what ol's
 * batch holds.
 */
import type {FeatureLike} from 'ol/Feature.js';
import {inflateEnds} from 'ol/geom/flat/orient.js';
import RenderFeature from 'ol/render/Feature.js';
import MixedGeometryBatch from 'ol/render/webgl/MixedGeometryBatch.js';
import {getUid} from 'ol/util.js';

export type BatchKind = 'points' | 'lines' | 'polygons';

/** What is done with the parts of a geometry, in the order ol's batch has them in. */
export interface GeometryVisitor {
  /** A point: x and y at `at` in `flat`. */
  point(flat: ArrayLike<number>, at: number): void;
  /**
   * A line (or a ring of a polygon, as a line): vertices of `stride` numbers
   * from `start` to `end`, with M at `m` in a vertex (-1: none, M is 0).
   */
  line(flat: ArrayLike<number>, start: number, end: number, stride: number, m: number): void;
  /** A polygon: its rings end at `ends[first]` to `ends[last - 1]`, the first one starts at `start`. */
  polygon(flat: ArrayLike<number>, start: number, ends: ArrayLike<number>, first: number, last: number, stride: number): void;
}

/**
 * Walks a geometry as ol's MixedGeometryBatch splits it: collections and
 * multi geometries into their parts, and the rings of polygons also as lines.
 */
export function visitGeometry(geometry: any, visitor: GeometryVisitor) {
  const type: string = geometry.getType();
  switch (type) {
    case 'Point':
      visitor.point(geometry.getFlatCoordinates(), 0);
      break;
    case 'LineString':
    case 'LinearRing': {
      const flat = geometry.getFlatCoordinates();
      const stride: number = geometry.getStride() ?? 2;
      // M is read from XYZM, and from XYM when the geometry says it is that
      visitor.line(flat, 0, flat.length, stride, stride === 4 ? 3 : stride === 3 && geometry.getLayout?.() === 'XYM' ? 2 : -1);
      break;
    }
    case 'Polygon': {
      const flat = geometry.getFlatCoordinates();
      const ends: number[] | null = geometry.getEnds();
      if (!ends) {
        break;
      }
      const stride: number = geometry.getStride() ?? 2;
      if (geometry instanceof RenderFeature) {
        // the rings of a RenderFeature may be those of several polygons
        const endss = inflateEnds(flat as number[], ends);
        if (endss.length > 1) {
          visitPolygons(flat, endss, stride, visitor);
          break;
        }
      }
      visitPolygon(flat, 0, ends, 0, ends.length, stride, visitor);
      break;
    }
    case 'MultiPoint': {
      const flat = geometry.getFlatCoordinates();
      const stride: number = geometry.getStride() ?? 2;
      for (let i = 0, ii = flat.length; i < ii; i += stride) {
        visitor.point(flat, i);
      }
      break;
    }
    case 'MultiLineString': {
      const flat = geometry.getFlatCoordinates();
      const ends: number[] = geometry.getEnds();
      const stride: number = geometry.getStride() ?? 2;
      // without a layout, as ol's batch passes none for these: XYZM has an M, three numbers are XYZ
      const m = stride === 4 ? 3 : -1;
      for (let i = 0, start = 0; i < ends.length; start = ends[i++]) {
        visitor.line(flat, start, ends[i], stride, m);
      }
      break;
    }
    case 'MultiPolygon': {
      const flat = geometry.getFlatCoordinates();
      const endss: number[][] = geometry.getEndss ? geometry.getEndss() : inflateEnds(flat as number[], geometry.getEnds());
      visitPolygons(flat, endss, geometry.getStride() ?? 2, visitor);
      break;
    }
    case 'GeometryCollection':
      for (const part of geometry.getGeometriesArray()) {
        visitGeometry(part, visitor);
      }
      break;
    default:
    // as ol: nothing
  }
}

function visitPolygons(flat: ArrayLike<number>, endss: number[][], stride: number, visitor: GeometryVisitor) {
  let start = 0;
  for (const ends of endss) {
    visitPolygon(flat, start, ends, 0, ends.length, stride, visitor);
    start = ends.length ? ends[ends.length - 1] : start;
  }
}

function visitPolygon(flat: ArrayLike<number>, start: number, ends: ArrayLike<number>, first: number, last: number, stride: number, visitor: GeometryVisitor) {
  visitor.polygon(flat, start, ends, first, last, stride);
  const m = stride === 4 ? 3 : -1;
  for (let i = first, from = start; i < last; from = ends[i++]) {
    visitor.line(flat, from, ends[i], stride, m);
  }
}

// what is counted per ref (see `counts`)
const POINTS = 0;
const LINES = 1;
const LINE_VERTICES = 2;
const POLYGONS = 3;
const POLYGON_VERTICES = 4;
const RINGS = 5;
const COUNTS = 6;
/** The count that tells whether a feature has geometries of a kind. */
const OF_KIND: Record<BatchKind, number> = {points: POINTS, lines: LINES, polygons: POLYGONS};
const KINDS: BatchKind[] = ['points', 'lines', 'polygons'];
const BIT: Record<BatchKind, number> = {points: 1, lines: 2, polygons: 4};

/** The refs with geometries of one kind. */
interface KindList {
  refs: Uint32Array;
  n: number;
  /** The first `sortedTo` are in the order of their uids. */
  sortedTo: number;
  lastUid: number;
  /** Some of the refs are no longer of this kind. */
  holes: boolean;
}

/** ol's batch with the refs of a `FeatureBatch` (see `FeatureBatch.toOl`). */
const OlBatch = MixedGeometryBatch as unknown as new () => any;
class OlBatchWithRefs extends OlBatch {
  refOf: (uid: string) => number = () => 0;
  addRefToEntry_(uid: string, entry: {ref?: number}) {
    entry.ref = this.refOf(uid);
    return entry;
  }
}

function grow<T extends Uint8Array | Uint32Array | Float64Array>(array: T, length: number): T {
  if (length <= array.length) {
    return array;
  }
  const grown = new (array.constructor as new (n: number) => T)(Math.max(array.length * 2, length, 1024));
  grown.set(array);
  return grown;
}

export class FeatureBatch {
  /** The feature of each ref (refs start at 1). */
  private features: Array<FeatureLike | undefined> = [undefined];
  /** Its geometry as it is drawn: in the projection of the view. */
  private geometries: unknown[] = [undefined];
  /** Per ref: the uid of its feature, as a number. */
  private uids = new Float64Array(0);
  /** Per uid: the ref of its feature (0: not in the batch). */
  private refs = new Uint32Array(0);
  /** Per ref: `COUNTS` numbers of what its geometry has. */
  private counts = new Uint32Array(0);
  /** Per ref: the kinds whose list it is in (`BIT`). */
  private listed = new Uint8Array(0);
  private counter = 0;
  private free: number[] = [];
  /** Refs of features that were removed: used again once the lists are without them (see `refsOf`). */
  private freed: number[] = [];
  private lists: Record<BatchKind, KindList> = {points: this.emptyList(), lines: this.emptyList(), polygons: this.emptyList()};
  /** The sums of `counts` over all features. */
  private totals = new Float64Array(COUNTS);
  private count = 0;
  private readonly counting = new Uint32Array(COUNTS);
  private readonly counter_: GeometryVisitor;

  constructor() {
    const c = this.counting;
    this.counter_ = {
      point: () => {
        c[POINTS]++;
      },
      line: (_flat, start, end, stride) => {
        c[LINES]++;
        c[LINE_VERTICES] += (end - start) / stride;
      },
      polygon: (_flat, start, ends, first, last, stride) => {
        c[POLYGONS]++;
        c[RINGS] += last - first;
        c[POLYGON_VERTICES] += last > first ? (ends[last - 1] - start) / stride : 0;
      },
    };
  }

  private emptyList(): KindList {
    return {refs: new Uint32Array(0), n: 0, sortedTo: 0, lastUid: -1, holes: false};
  }

  /** The ref of a feature (0: it is not in the batch). */
  refOf(feature: FeatureLike): number {
    const uid = +getUid(feature);
    return uid < this.refs.length ? this.refs[uid] : 0;
  }

  getFeatureFromRef(ref: number): FeatureLike | undefined {
    return this.features[ref];
  }

  /** The geometry of a ref, as `visitGeometry` reads it. */
  geometryOf(ref: number): unknown {
    return this.geometries[ref];
  }

  isEmpty(): boolean {
    return this.counter === 0;
  }

  /** Points, lines (rings of polygons too) or polygons there are. */
  geometriesCount(kind: BatchKind): number {
    return this.totals[OF_KIND[kind]];
  }

  /** The vertices of all lines, or of all polygons. */
  verticesCount(kind: 'lines' | 'polygons'): number {
    return this.totals[kind === 'lines' ? LINE_VERTICES : POLYGON_VERTICES];
  }

  ringsCount(): number {
    return this.totals[RINGS];
  }

  addFeatures(features: FeatureLike[], projectionTransform?: unknown) {
    for (let i = 0; i < features.length; i++) {
      this.addFeature(features[i], projectionTransform);
    }
  }

  addFeature(feature: FeatureLike, projectionTransform?: unknown) {
    const uid = +getUid(feature);
    if (uid < this.refs.length && this.refs[uid]) {
      this.changeFeature(feature, projectionTransform);
      return;
    }
    const geometry = this.geometryFor(feature, projectionTransform);
    if (!geometry) {
      return; // as in ol: a feature without a geometry is not in the batch
    }
    const ref = this.free.pop() || ++this.counter;
    this.refs = grow(this.refs, uid + 1);
    this.uids = grow(this.uids, ref + 1);
    this.listed = grow(this.listed, ref + 1);
    this.counts = grow(this.counts, (ref + 1) * COUNTS);
    this.refs[uid] = ref;
    this.uids[ref] = uid;
    this.features[ref] = feature;
    this.count++;
    this.setGeometry(ref, geometry);
  }

  private geometryFor(feature: FeatureLike, projectionTransform?: unknown): unknown {
    let geometry: any = feature.getGeometry();
    if (geometry && projectionTransform) {
      geometry = geometry.clone();
      geometry.applyTransform(projectionTransform);
    }
    return geometry;
  }

  /** Counts the geometry of a ref and puts the ref in the lists of its kinds. */
  private setGeometry(ref: number, geometry: unknown) {
    this.geometries[ref] = geometry;
    const c = this.counting.fill(0);
    visitGeometry(geometry, this.counter_);
    const uid = this.uids[ref];
    for (let i = 0; i < COUNTS; i++) {
      this.counts[ref * COUNTS + i] = c[i];
      this.totals[i] += c[i];
    }
    for (const kind of KINDS) {
      if (c[OF_KIND[kind]] && !(this.listed[ref] & BIT[kind])) {
        this.listed[ref] |= BIT[kind];
        const list = this.lists[kind];
        list.refs = grow(list.refs, list.n + 1);
        list.refs[list.n] = ref;
        if (list.sortedTo === list.n && uid > list.lastUid) {
          list.sortedTo++;
          list.lastUid = uid;
        }
        list.n++;
      }
    }
  }

  /** Takes the geometry of a ref out of the counts (its ref stays in the lists until `refsOf`). */
  private unsetGeometry(ref: number) {
    for (let i = 0; i < COUNTS; i++) {
      this.totals[i] -= this.counts[ref * COUNTS + i];
      this.counts[ref * COUNTS + i] = 0;
    }
    for (const kind of KINDS) {
      if (this.listed[ref] & BIT[kind]) {
        this.lists[kind].holes = true;
      }
    }
    this.geometries[ref] = undefined;
  }

  changeFeature(feature: FeatureLike, projectionTransform?: unknown) {
    const ref = this.refOf(feature);
    if (!ref) {
      return; // a feature that is not in the batch is not added, as in ol
    }
    const geometry = this.geometryFor(feature, projectionTransform);
    if (!geometry) {
      this.removeFeature(feature); // as in ol: without a geometry it is out for good
      return;
    }
    this.unsetGeometry(ref);
    this.setGeometry(ref, geometry);
  }

  removeFeature(feature: FeatureLike) {
    const ref = this.refOf(feature);
    if (!ref) {
      return;
    }
    this.unsetGeometry(ref);
    this.refs[this.uids[ref]] = 0;
    this.features[ref] = undefined;
    this.count--;
    if (this.listed[ref]) {
      this.freed.push(ref); // a list still has it
    } else {
      this.free.push(ref);
    }
  }

  clear() {
    this.features = [undefined];
    this.geometries = [undefined];
    this.uids = new Float64Array(0);
    this.refs = new Uint32Array(0);
    this.counts = new Uint32Array(0);
    this.listed = new Uint8Array(0);
    this.counter = 0;
    this.free = [];
    this.freed = [];
    this.lists = {points: this.emptyList(), lines: this.emptyList(), polygons: this.emptyList()};
    this.totals.fill(0);
    this.count = 0;
  }

  /** Takes the refs that are no longer of their kind out of the lists, and puts the lists in the order of the uids. */
  private settle() {
    const {counts, listed, uids} = this;
    for (const kind of KINDS) {
      const list = this.lists[kind];
      const refs = list.refs;
      if (list.holes) {
        const of = OF_KIND[kind];
        let n = 0;
        let sortedTo = 0;
        for (let i = 0; i < list.n; i++) {
          const ref = refs[i];
          if (counts[ref * COUNTS + of]) {
            if (i < list.sortedTo) {
              sortedTo = n + 1;
            }
            refs[n++] = ref;
          } else {
            listed[ref] &= ~BIT[kind];
          }
        }
        list.n = n;
        list.sortedTo = sortedTo;
        list.holes = false;
      }
      if (list.sortedTo < list.n) {
        // those that came since, in order, and then among the others
        const tail = refs.slice(list.sortedTo, list.n).sort((a, b) => uids[a] - uids[b]);
        const head = list.sortedTo;
        let i = head - 1;
        let j = tail.length - 1;
        for (let k = list.n - 1; j >= 0; k--) {
          refs[k] = i >= 0 && uids[refs[i]] > uids[tail[j]] ? refs[i--] : tail[j--];
        }
        list.sortedTo = list.n;
      }
      list.lastUid = list.n ? uids[refs[list.n - 1]] : -1;
    }
    // no list has the refs of removed features any more: they can be given again
    for (const ref of this.freed) {
      if (this.features[ref] === undefined && !listed[ref]) {
        this.free.push(ref);
      }
    }
    this.freed = [];
  }

  /**
   * The refs of the features with geometries of a kind, in the order they
   * are drawn in (that of ol: by uid). Not to be kept: the array is the
   * batch's own, and changes with it.
   */
  refsOf(kind: BatchKind): Uint32Array {
    this.settle();
    const list = this.lists[kind];
    return list.refs.subarray(0, list.n);
  }

  /** The features with geometries of a kind. */
  featuresOf(kind: BatchKind): FeatureLike[] {
    return Array.from(this.refsOf(kind), (ref) => this.features[ref]!);
  }

  /**
   * What ol's MixedGeometryBatch holds for these features, with the refs of
   * this batch: for ol's instruction generators. It is made new on every
   * call, with the entries and the copies this batch does without.
   */
  toOl(): MixedGeometryBatch {
    const batch = new OlBatchWithRefs();
    batch.refOf = (uid) => this.refs[+uid];
    for (let ref = 1; ref <= this.counter; ref++) {
      const feature = this.features[ref];
      if (feature) {
        batch.addGeometry_(this.geometries[ref], feature);
      }
    }
    return batch as unknown as MixedGeometryBatch;
  }
}
