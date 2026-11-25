/**
 * Sorting with a comparison of the app (`renderOrder`), in slices.
 *
 * A comparison that reads two features costs a few hundred nanoseconds, and
 * sorting n features takes about n log2 n of them: seconds for half a
 * million. So the sort here can stop at a deadline and go on later, it
 * finds what is in order already (a merge sort of the runs that are there),
 * and `Merger` puts a few new entries into a sorted list without sorting
 * that list again.
 *
 * All of it works on positions (`Uint32Array`) and a comparison of two
 * positions, which has to be a total order. The work is in plain functions
 * that are called once per slice with the state in an object (not in
 * generators: the loops of those are not compiled while they run).
 */

export type Less = (a: number, b: number) => boolean;

/** Comparisons between two looks at the clock. */
const CLOCK_EVERY = 256;
/** Runs that are in order by chance are made this long before runs are merged. */
const MIN_RUN = 32;
/** And a run that is in order is taken up to this length at a time. */
const MAX_RUN = 4096;

/** A merge of two sorted ranges that lie next to each other, in the making. */
interface Merge {
  /** The first range, copied; `a` is the next of it. */
  spare: Uint32Array;
  count: number;
  a: number;
  /** The next of the second range, and its end. */
  b: number;
  to: number;
  /** Where the next item goes. */
  k: number;
}

function startMerge(items: Uint32Array, from: number, middle: number, to: number, less: Less, spare: Uint32Array): Merge | null {
  // what is in place already stays
  if (!less(items[middle], items[middle - 1])) {
    return null;
  }
  const count = middle - from;
  spare.set(items.subarray(from, middle));
  return {spare, count, a: 0, b: middle, to, k: from};
}

/** Works on a merge until the deadline; true when it is done. */
function stepMerge(items: Uint32Array, m: Merge, less: Less, deadline: number): boolean {
  const {spare, count, to} = m;
  let {a, b, k} = m;
  let ticks = 0;
  while (a < count && b < to) {
    // the first range goes first where they are equal (they are not: a total order)
    if (less(items[b], spare[a])) {
      items[k++] = items[b++];
    } else {
      items[k++] = spare[a++];
    }
    if (++ticks % CLOCK_EVERY === 0 && performance.now() >= deadline) {
      m.a = a;
      m.b = b;
      m.k = k;
      return false;
    }
  }
  while (a < count) {
    items[k++] = spare[a++];
  }
  return true;
}

/**
 * Sorts the range [from, to) of `items`, in slices: `step` until it returns
 * true. What is in order already costs one comparison per item.
 *
 * Runs are taken from the items one by one, and two runs next to each other
 * are merged as soon as the later one is not shorter. So items that lie
 * close together are merged first, while what they point at is still in
 * the caches of the processor: a third faster on half a million features
 * than merging the whole range round after round.
 */
export class Sorter {
  /** The starts of the runs made so far, which lie one after the other up to `covered`. */
  private starts: number[] = [];
  private covered: number;
  private merge: Merge | null = null;
  private spare: Uint32Array | null = null;

  constructor(
    private readonly items: Uint32Array,
    from: number,
    private readonly to: number,
    private readonly less: Less,
  ) {
    this.covered = from;
  }

  step(deadline: number): boolean {
    const {items, to, less, starts} = this;
    for (let turns = 1; ; turns++) {
      if (this.merge) {
        if (!stepMerge(items, this.merge, less, deadline)) {
          return false;
        }
        this.merge = null;
        starts.pop();
      }
      const count = starts.length;
      const last = count ? this.covered - starts[count - 1] : 0;
      if (count >= 2 && (this.covered === to || starts[count - 1] - starts[count - 2] <= last)) {
        // the two last runs: the copy is of the first, which is not the longer one unless the items are used up
        this.spare ??= new Uint32Array(to - starts[0]);
        this.merge = startMerge(items, starts[count - 2], starts[count - 1], this.covered, less, this.spare);
        if (!this.merge) {
          starts.pop();
        }
      } else if (this.covered === to) {
        return true;
      } else {
        this.covered = this.run(this.covered);
      }
      if (turns % 16 === 0 && performance.now() >= deadline) {
        return false;
      }
    }
  }

  /** Makes the next run, from `start`; returns its end. */
  private run(start: number): number {
    const {items, to, less} = this;
    // as far as the items are in order
    let end = start + 1;
    const most = Math.min(start + MAX_RUN, to); // not all in one go: the clock is looked at between runs
    while (end < most && !less(items[end], items[end - 1])) {
      end++;
    }
    // a short run takes the items after it, each put in its place (few comparisons,
    // and far fewer merges than with the runs of two or three that are there by chance)
    const least = Math.min(start + MIN_RUN, to);
    for (; end < least; end++) {
      const item = items[end];
      let low = start;
      let high = end;
      while (low < high) {
        const at = (low + high) >> 1;
        if (less(item, items[at])) {
          high = at;
        } else {
          low = at + 1;
        }
      }
      for (let k = end; k > low; k--) {
        items[k] = items[k - 1];
      }
      items[low] = item;
    }
    this.starts.push(start);
    return end;
  }
}

/**
 * The sorted ranges [0, middle) and [middle, length) of `items` as one
 * sorted list, in slices: `step` until it returns true, then `result`. A
 * second range that is small next to the first is put in by looking up the
 * place of each of its items (log2 comparisons each), not by walking the
 * first.
 */
export class Merger {
  result: Uint32Array;
  private merge: Merge | null = null;
  private walking = false;
  /** Looking up: how many of the first range come before each item of the second. */
  private before: Uint32Array | null = null;
  private j = 0;
  private low = 0;

  constructor(
    private readonly items: Uint32Array,
    private readonly middle: number,
    private readonly less: Less,
  ) {
    this.result = items;
    const added = items.length - middle;
    if (!added || !middle) {
      return;
    }
    if (added * (Math.log2(middle) + 1) >= middle) {
      this.walking = true;
    } else {
      this.before = new Uint32Array(added);
    }
  }

  step(deadline: number): boolean {
    const {items, middle, less} = this;
    if (this.walking) {
      this.merge ??= startMerge(items, 0, middle, items.length, less, new Uint32Array(middle));
      if (this.merge && !stepMerge(items, this.merge, less, deadline)) {
        return false;
      }
      this.walking = false;
      return true;
    }
    const before = this.before;
    if (!before) {
      return true;
    }
    const added = before.length;
    let low = this.low; // they are sorted too: the place of one is not before that of the one before
    for (let j = this.j; j < added; j++) {
      const item = items[middle + j];
      let high = middle;
      while (low < high) {
        const at = (low + high) >> 1;
        if (less(item, items[at])) {
          high = at;
        } else {
          low = at + 1;
        }
      }
      before[j] = low;
      if (j % 16 === 15 && performance.now() >= deadline) {
        this.j = j + 1;
        this.low = low;
        return false;
      }
    }
    const out = new Uint32Array(items.length);
    let from = 0;
    let k = 0;
    for (let j = 0; j < added; j++) {
      out.set(items.subarray(from, before[j]), k);
      k += before[j] - from;
      from = before[j];
      out[k++] = items[middle + j];
    }
    out.set(items.subarray(from, middle), k);
    this.result = out;
    this.before = null;
    return true;
  }
}
