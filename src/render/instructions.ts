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

  /** [x0, y0, customAttr0, ..., xN, yN, customAttrN] */
  points(batch: PointBatch, transform: Transform): Float32Array | null {
    if (!this.usable) {
      return null;
    }
    const size = this.customSize;
    const out = new Float32Array((2 + size) * batch.geometriesCount);
    const [a, b, c, d, e, f] = transform;
    let k = 0;
    const entries = Object.values(batch.entries); // in the order of ol's for-in, and much faster
    for (let n = 0, nn = entries.length; n < nn; n++) {
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
    return out;
  }

  /** [customAttr0, ..., customAttrN, numberOfVertices0, x0, y0, m0, ..., xN, yN, mN, ...] */
  lines(batch: LineStringBatch, transform: Transform): Float32Array | null {
    if (!this.usable) {
      return null;
    }
    const size = this.customSize;
    const out = new Float32Array(3 * batch.verticesCount + (1 + size) * batch.geometriesCount);
    const [a, b, c, d, e, f] = transform;
    let k = 0;
    const entries = Object.values(batch.entries); // in the order of ol's for-in, and much faster
    for (let n = 0, nn = entries.length; n < nn; n++) {
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
    return out;
  }

  /** [customAttr0, ..., customAttrN, numberOfRings, numberOfVerticesInRing0, ..., x0, y0, ..., xN, yN, ...] */
  polygons(batch: PolygonBatch, transform: Transform): Float32Array | null {
    if (!this.usable) {
      return null;
    }
    const size = this.customSize;
    const out = new Float32Array(2 * batch.verticesCount + (1 + size) * batch.geometriesCount + batch.ringsCount);
    const [a, b, c, d, e, f] = transform;
    let k = 0;
    const entries = Object.values(batch.entries); // in the order of ol's for-in, and much faster
    for (let n = 0, nn = entries.length; n < nn; n++) {
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
    return out;
  }
}
