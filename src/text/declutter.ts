/**
 * Decluttering: labels claim screen space in priority order, and a label
 * whose box collides with one that was placed before is hidden. The same
 * greedy rule as ol's Canvas renderer, on a uniform grid.
 */
import {compose as composeTransform, create as createTransform} from 'ol/transform.js';
import {type LabelSet, MODE_DECLUTTER, MODE_NONE, MODE_OBSTACLE, partBox} from './layout.js';

/** Boxes that are taken, in CSS pixels. */
export class Occupancy {
  private readonly cells = new Map<number, number[]>();
  private readonly boxes: number[] = [];

  collides(minX: number, minY: number, maxX: number, maxY: number): boolean {
    const boxes = this.boxes;
    for (let cx = minX >> 6, ex = maxX >> 6; cx <= ex; cx++) {
      for (let cy = minY >> 6, ey = maxY >> 6; cy <= ey; cy++) {
        const cell = this.cells.get((cx + 32768) * 65536 + (cy + 32768));
        if (!cell) {
          continue;
        }
        for (const b of cell) {
          if (minX < boxes[b + 2] && maxX > boxes[b] && minY < boxes[b + 3] && maxY > boxes[b + 1]) {
            return true;
          }
        }
      }
    }
    return false;
  }

  insert(minX: number, minY: number, maxX: number, maxY: number) {
    const b = this.boxes.length;
    this.boxes.push(minX, minY, maxX, maxY);
    for (let cx = minX >> 6, ex = maxX >> 6; cx <= ex; cx++) {
      for (let cy = minY >> 6, ey = maxY >> 6; cy <= ey; cy++) {
        const key = (cx + 32768) * 65536 + (cy + 32768);
        const cell = this.cells.get(key);
        if (cell) {
          cell.push(b);
        } else {
          this.cells.set(key, [b]);
        }
      }
    }
  }
}

/** Rounds of placement whose winners become candidates. */
const ROUNDS = 2;

const box = [0, 0, 0, 0];

/**
 * The labels of a measured set that can win a place at the resolution and
 * rotation the set was laid out for, as a set of label keys.
 *
 * Only these get glyphs: with dense data most labels never show. Placement
 * runs over the whole laid out area, so the result holds while the view
 * pans. The losers of the first round are placed once more among
 * themselves: they take over where a label of a higher layer of the
 * declutter group, or the edge of the screen, hides a winner.
 */
export function selectCandidates(set: LabelSet): Set<number> {
  const {order, partStart, partEnd, mode, parts, keys} = set;
  const cos = Math.cos(set.rotation);
  const sin = Math.sin(set.rotation);
  const r = set.resolution;
  // coordinate to pixel, as the view's transform but around the set's origin
  const transform = composeTransform(createTransform(), 0, 0, 1 / r, -1 / r, -set.rotation, -set.origin[0], -set.origin[1]);
  const taken = new Uint8Array(set.count);
  const candidates = new Set<number>();
  const boxes: number[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    const occupancy = new Occupancy();
    for (let o = 0; o < order.length; o++) {
      const i = order[o];
      // an obstacle is in the way in every round
      const again = taken[i] === 1 && mode[i] === MODE_OBSTACLE;
      if (taken[i] && !again) {
        continue;
      }
      if (mode[i] !== MODE_NONE) {
        boxes.length = 0;
        let free = true;
        for (let part = partStart[i]; part < partEnd[i]; part++) {
          partBox(parts, part, transform, 0, cos, sin, box);
          if (mode[i] === MODE_DECLUTTER && occupancy.collides(box[0], box[1], box[2], box[3])) {
            free = false;
            break;
          }
          boxes.push(box[0], box[1], box[2], box[3]);
        }
        if (!free) {
          continue;
        }
        for (let b = 0; b < boxes.length; b += 4) {
          occupancy.insert(boxes[b], boxes[b + 1], boxes[b + 2], boxes[b + 3]);
        }
      }
      taken[i] = 1;
      candidates.add(keys[i]);
    }
  }
  return candidates;
}
