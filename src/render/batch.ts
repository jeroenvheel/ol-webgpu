/**
 * ol's MixedGeometryBatch (ol 10.11) with another way to keep the refs.
 *
 * ol keeps two Maps next to the entries: uid → ref and ref → feature. Every
 * feature that is added looks its uid up in the first, and for the big
 * sources this layer is made for that lookup took half the time of adding
 * features. The entries already tell the ref of a feature, and refs are
 * small whole numbers, so here the ref comes from the entries and the
 * features are in an array at their ref. Entries, refs and counts are those
 * ol's batch gives (`test/unit/batch.test.ts`).
 *
 * This overrides methods ol marks private; the supported range of ol is
 * pinned in package.json for that reason.
 */
import type {FeatureLike} from 'ol/Feature.js';
import MixedGeometryBatch from 'ol/render/webgl/MixedGeometryBatch.js';
import {getUid} from 'ol/util.js';

interface Entry {
  feature: FeatureLike;
  ref?: number;
}

// ol's private members are used and overridden below
const Base = MixedGeometryBatch as unknown as new () => any;

class LeanBatch extends Base {
  /** The feature of each ref (refs start at 1). */
  private features: Array<FeatureLike | undefined> = [];

  private entryOf(uid: string): Entry | undefined {
    return this.pointBatch.entries[uid] ?? this.lineStringBatch.entries[uid] ?? this.polygonBatch.entries[uid];
  }

  addRefToEntry_(uid: string, entry: Entry): Entry {
    const known = this.entryOf(uid)?.ref;
    const ref: number = known || this.freeGlobalRef_.pop() || ++this.globalCounter_;
    entry.ref = ref;
    if (!known) {
      this.features[ref] = entry.feature;
    }
    return entry;
  }

  removeRef_(ref: number, uid: string) {
    if (!ref) {
      throw new Error('This feature has no ref: ' + uid);
    }
    this.features[ref] = undefined;
    this.freeGlobalRef_.push(ref);
  }

  changeFeature(feature: FeatureLike, projectionTransform?: unknown) {
    // a feature that is not in the batch is not added, as in ol
    if (!this.entryOf(getUid(feature))) {
      return;
    }
    this.removeFeature(feature);
    this.addFeature(feature, projectionTransform);
  }

  clear() {
    super.clear();
    this.features = [];
  }

  getFeatureFromRef(ref: number): FeatureLike | undefined {
    return this.features[ref];
  }

  filter(): never {
    throw new Error('ol-webgpu: filter() is not supported on this batch');
  }
}

export const FeatureBatch = LeanBatch as unknown as new () => MixedGeometryBatch;
