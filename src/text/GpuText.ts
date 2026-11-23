/**
 * Labels of one layer, drawn on the GPU: keeps the current label set, lays
 * out a new one when the view or the data changes (a slice per frame),
 * resolves decluttering and fades, and answers hit detection for labels.
 * The backends only upload and draw what `frame()` returns.
 */
import type {FeatureLike} from 'ol/Feature.js';
import type {FrameState} from 'ol/Map.js';
import ViewHint from 'ol/ViewHint.js';
import {applyTransform, buffer as bufferExtent, containsExtent, getHeight, getWidth} from 'ol/extent.js';
import {inView} from 'ol/layer/Layer.js';
import {getTransformFromProjections, getUserProjection} from 'ol/proj.js';
import {getWorldParameters} from 'ol/renderer/webgl/worldUtil.js';
import type VectorSource from 'ol/source/Vector.js';
import type {FlatStyleLike} from 'ol/style/flat.js';
import {getUid} from 'ol/util.js';
import {type AtlasPage, sharedAtlas} from './atlas.js';
import {Occupancy, selectCandidates} from './declutter.js';
import {LabelBuilder, type LabelSet, type LayoutOptions, MODE_DECLUTTER, MODE_NONE, partBox} from './layout.js';
import {type TextEvaluator, buildTextEvaluator} from './style.js';

/** Milliseconds a label takes to fade in or out when decluttering changes. */
const FADE = 150;
/** Main-thread milliseconds per frame for laying out labels: first layout, view still, view moving. */
const BUDGET_FIRST = 50;
const BUDGET_STILL = 10;
const BUDGET_MOVING = 4;
/** Margin around the view, as a fraction of its larger side, that is laid out too. */
const HEADROOM = 0.25;
/** While the view moves, decluttering that took longer than this runs at most every `RESOLVE_INTERVAL` ms. */
const RESOLVE_SLOW = 3;
const RESOLVE_INTERVAL = 120;

/** Labels of one rendered world copy. */
export interface LabelWorld {
  /** Number of the world copy (0 is the central one). */
  world: number;
  /** Opacity per glyph instance. */
  opacity: Float32Array;
  /** Increases when `opacity` changes. */
  version: number;
  /** Per label: fade state 0..1 and whether it should be shown. */
  alpha: Float32Array;
  target: Uint8Array;
  fading: boolean;
  /** Show the next decluttering result at once (nothing to fade from). */
  snap: boolean;
}

/** What a backend draws for one frame. */
export interface LabelFrame {
  set: LabelSet;
  /** The atlas page with the glyphs of the set: an earlier one while labels are laid out for a new one. */
  page: AtlasPage;
  worlds: LabelWorld[];
  worldWidth: number;
}

/** Numbers of the last layout and decluttering, for benchmarks and debugging. */
export interface LabelStats {
  /** Features whose text style was evaluated. */
  features: number;
  labels: number;
  glyphs: number;
  /** Labels measured; with decluttering only those that can win a place get glyphs. */
  measured: number;
  /** Main-thread milliseconds of the layout, and the frames it was spread over. */
  layout: number;
  frames: number;
  /** Milliseconds of the last decluttering. */
  declutter: number;
}

/** What a layout was made for. */
interface LayoutKey {
  resolution: number;
  rotation: number;
  pixelRatio: number;
  revision: number;
  styleVersion: number;
  variables: string;
  projection: unknown;
  generation: number;
  coverage: number[];
}

function variablesKey(variables: Record<string, any>): string {
  let key = '';
  for (const name in variables) {
    key += name + ':' + String(variables[name]) + ';';
  }
  return key;
}

function viewKey(frameState: FrameState): string {
  const v = frameState.viewState;
  return `${v.center[0]},${v.center[1]},${v.resolution},${v.rotation},${frameState.size[0]},${frameState.size[1]}`;
}

function isMoving(frameState: FrameState): boolean {
  return !!(frameState.viewHints[ViewHint.ANIMATING] || frameState.viewHints[ViewHint.INTERACTING]);
}

const tmp = [0, 0, 0, 0];

export default class GpuText {
  private evaluator: TextEvaluator | null;
  private readonly atlas = sharedAtlas();
  private set: LabelSet | null = null;
  private setKey: LayoutKey | null = null;
  /** Finished layout, shown from the start of the next frame. */
  private next: {set: LabelSet; key: LayoutKey} | null = null;
  private job: {
    builder: LabelBuilder;
    key: LayoutKey;
    /** The builder only measures: the labels that can win a place are laid out after it. */
    measuring: boolean;
    features: number;
    measured: number;
    time: number;
    frames: number;
  } | null = null;
  /** Numbers of the last layout and decluttering. */
  stats: LabelStats = {features: 0, labels: 0, glyphs: 0, measured: 0, layout: 0, frames: 0, declutter: 0};
  private worlds: LabelWorld[] = [];
  private worldWidth = 0;
  private styleVersion = 0;
  private lastFrameTime = 0;
  private wasFading = false;
  private readonly unlistenAtlas: () => void;
  /** Screen boxes of the shown labels, for hit detection. */
  private hitCache: {view: string; version: number; boxes: Float64Array; labels: Uint32Array} | null = null;
  /** Increases when the shown labels change. */
  private shownVersion = 0;

  constructor(
    style: FlatStyleLike,
    private variables: Record<string, any>,
    /** Declutter group, or null when labels may overlap. */
    public declutter: string | null,
    private readonly requestRender: () => void,
  ) {
    this.evaluator = buildTextEvaluator(style, variables);
    this.unlistenAtlas = this.atlas.onReset(() => this.requestRender());
  }

  setStyle(style: FlatStyleLike, variables: Record<string, any>) {
    this.variables = variables;
    this.evaluator = buildTextEvaluator(style, variables);
    this.styleVersion++;
  }

  /** A layout is in progress and there are no labels to draw yet. */
  get pending(): boolean {
    return !!this.job && !this.set && !this.next;
  }

  /** Labels are being laid out or are fading. */
  get busy(): boolean {
    return !!this.job || !!this.next || this.worlds.some((w) => w.fading);
  }

  // --- layout --------------------------------------------------------------

  /** Whether a layout made for `have` can be shown for `want` as it is. */
  private fits(have: LayoutKey | null | undefined, hasLine: boolean, want: LayoutKey, moving: boolean): boolean {
    if (
      !have ||
      have.revision !== want.revision ||
      have.styleVersion !== want.styleVersion ||
      have.variables !== want.variables ||
      have.projection !== want.projection ||
      have.pixelRatio !== want.pixelRatio ||
      have.generation !== want.generation ||
      !containsExtent(have.coverage, want.coverage)
    ) {
      return false;
    }
    if (moving) {
      // resolution and rotation wait until the view settles: labels follow the map meanwhile
      return true;
    }
    // with decluttering, the labels that can win a place were chosen for the rotation too
    return have.resolution === want.resolution && ((!hasLine && !this.declutter) || have.rotation === want.rotation);
  }

  /**
   * Called for every frame before it is drawn: starts or continues a layout
   * when the labels on hand do not fit the view.
   */
  prepare(frameState: FrameState, source: VectorSource) {
    if (!this.evaluator || !frameState.extent) {
      this.job = null;
      return;
    }
    const moving = isMoving(frameState);
    const viewState = frameState.viewState;
    const want: LayoutKey = {
      resolution: viewState.resolution,
      rotation: viewState.rotation,
      pixelRatio: frameState.pixelRatio,
      revision: source.getRevision(),
      styleVersion: this.styleVersion,
      variables: variablesKey(this.variables),
      projection: viewState.projection,
      generation: this.atlas.generation,
      coverage: frameState.extent,
    };
    const latest = this.next ?? (this.set && this.setKey ? {set: this.set, key: this.setKey} : null);
    if (this.fits(latest?.key, latest?.set.hasLine ?? false, want, moving)) {
      this.job = null;
    } else if (!this.fits(this.job?.key, true, want, moving)) {
      this.job = this.start(frameState, source, want);
    }
    const job = this.job;
    if (!job) {
      return;
    }
    const budget = !this.set && !this.next ? BUDGET_FIRST : moving ? BUDGET_MOVING : BUDGET_STILL;
    const t0 = performance.now();
    let done = job.builder.run(t0 + budget);
    if (done && job.measuring && !job.builder.isStale()) {
      // all labels are measured: lay out the ones that can win a place
      const measured = job.builder.finish();
      const accept = selectCandidates(measured);
      const features = new Set<FeatureLike>();
      for (let i = 0; i < measured.count; i++) {
        if (accept.has(measured.keys[i])) {
          features.add(measured.features[i]);
        }
      }
      job.measuring = false;
      job.measured = measured.count;
      job.builder = new LabelBuilder([...features], this.evaluator, this.atlas, {...job.builder.options, boxesOnly: false, accept});
      done = job.builder.run(t0 + budget);
    }
    job.time += performance.now() - t0;
    job.frames++;
    if (!done) {
      frameState.animate = true;
      return;
    }
    this.job = null;
    if (job.builder.isStale()) {
      frameState.animate = true; // the atlas started over meanwhile: lay out again
      return;
    }
    if (this.atlas.layoutDone(this, job.builder.use)) {
      // some glyphs did not fit and starting over makes room: lay out again
      frameState.animate = true;
      return;
    }
    const t1 = performance.now();
    const set = job.builder.finish();
    this.next = {set, key: job.key};
    this.stats = {
      features: job.features,
      labels: set.count,
      glyphs: set.glyphCount,
      measured: job.measured || set.count,
      layout: job.time + performance.now() - t1,
      frames: job.frames,
      declutter: this.stats.declutter,
    };
    this.requestRender();
  }

  private start(frameState: FrameState, source: VectorSource, want: LayoutKey): NonNullable<GpuText['job']> {
    const t0 = performance.now();
    this.atlas.trim();
    const viewState = frameState.viewState;
    const view = frameState.extent!;
    const margin = HEADROOM * Math.max(getWidth(view), getHeight(view)) + 100 * viewState.resolution;
    const projection = viewState.projection;
    const full = projection.getExtent();
    const coverage = bufferExtent(view, margin, []);
    let extent = coverage.slice();
    const userProjection = getUserProjection();
    const toUser = userProjection ? getTransformFromProjections(projection, userProjection) : null;
    const toView = userProjection ? getTransformFromProjections(userProjection, projection) : null;
    const features = new Set<FeatureLike>();
    const collect = (e: number[]) => {
      source.forEachFeatureInExtent(toUser ? applyTransform(e, toUser) : e, (f) => {
        features.add(f);
      });
    };
    if (source.getWrapX() && projection.canWrapX() && full) {
      const width = getWidth(full);
      if (getWidth(extent) >= width) {
        extent = [full[0], extent[1], full[2], extent[3]];
        coverage[0] = -Infinity;
        coverage[2] = Infinity;
        collect(extent);
      } else {
        // the view's part of each world copy, moved to the central world
        const world = Math.floor((extent[0] - full[0]) / width);
        extent = [extent[0] - world * width, extent[1], extent[2] - world * width, extent[3]];
        collect(extent);
        if (extent[2] > full[2]) {
          collect([full[0], extent[1], extent[2] - width, extent[3]]);
          extent = [full[0], extent[1], full[2], extent[3]];
        }
      }
    } else {
      collect(extent);
    }
    // a stable order, so labels keep their place between layouts
    const list = sortByUid([...features]);
    const measuring = !!this.declutter;
    const options: LayoutOptions = {
      origin: [viewState.center[0], viewState.center[1]],
      resolution: viewState.resolution,
      rotation: viewState.rotation,
      pixelRatio: frameState.pixelRatio,
      extent,
      toView: toView
        ? (geometry: any) => {
            const clone = geometry.clone();
            clone.applyTransform(toView);
            return clone;
          }
        : undefined,
      boxesOnly: measuring,
    };
    const builder = new LabelBuilder(list, this.evaluator!, this.atlas, options);
    return {builder, key: {...want, coverage}, measuring, features: list.length, measured: 0, time: performance.now() - t0, frames: 0};
  }

  // --- frame ---------------------------------------------------------------

  /**
   * Start of a frame: shows a finished layout (labels that were visible
   * keep their fade state) and matches the world copies the frame shows.
   */
  begin(layer: unknown, frameState: FrameState) {
    let carried: Map<number, Map<number, number>> | null = null;
    const next = this.next;
    if (next) {
      this.next = null;
      const previous = this.set;
      carried = new Map();
      if (previous) {
        for (const w of this.worlds) {
          const alphas = new Map<number, number>();
          for (let i = 0; i < previous.count; i++) {
            if (w.alpha[i] > 0) {
              alphas.set(previous.keys[i], w.alpha[i]);
            }
          }
          carried.set(w.world, alphas);
        }
      }
      this.set = next.set;
      this.setKey = next.key;
      this.worlds = [];
      this.shownVersion++;
    }
    const set = this.set;
    if (!set) {
      return;
    }
    const [start, end, worldWidth] = getWorldParameters(frameState, layer);
    this.worldWidth = worldWidth;
    const worlds: LabelWorld[] = [];
    let changed = false;
    for (let world = start; world < Math.max(end, start + 1); world++) {
      let w = this.worlds.find((x) => x.world === world);
      if (!w) {
        changed = true;
        const alpha = new Float32Array(set.count);
        const from = carried?.get(world);
        if (!this.declutter) {
          alpha.fill(1);
        } else if (from) {
          for (let i = 0; i < set.count; i++) {
            alpha[i] = from.get(set.keys[i]) ?? 0;
          }
        }
        w = {
          world,
          opacity: new Float32Array(set.glyphCount),
          version: 0,
          alpha,
          target: new Uint8Array(set.count).fill(this.declutter ? 0 : 1),
          fading: false,
          // the first labels, and a world copy that scrolls into view, do not fade in
          snap: !from,
        };
        this.writeOpacity(w);
      }
      worlds.push(w);
    }
    if (changed || worlds.length !== this.worlds.length) {
      this.worlds = worlds;
      this.shownVersion++;
    }
  }

  /** Changes when the labels to place change (not when the view does). */
  identity(): string {
    return `${this.set?.id ?? 0}:${this.worlds.map((w) => w.world).join('/')}`;
  }

  private writeOpacity(w: LabelWorld) {
    const set = this.set!;
    const {glyphStart, glyphEnd} = set;
    for (let i = 0; i < set.count; i++) {
      const a = w.alpha[i];
      for (let g = glyphStart[i], e = glyphEnd[i]; g < e; g++) {
        w.opacity[g] = a;
      }
    }
    w.version++;
  }

  /**
   * Decides which labels are shown in this frame. Called from the top layer
   * down for the layers of a declutter group, which share `occupancy`.
   * Returns the milliseconds it took.
   */
  resolve(frameState: FrameState, occupancy: Occupancy): number {
    const set = this.set;
    if (!set || !this.declutter) {
      return 0;
    }
    const t0 = performance.now();
    const rotation = frameState.viewState.rotation;
    const viewCos = Math.cos(rotation);
    const viewSin = Math.sin(rotation);
    const [width, height] = frameState.size;
    const {order, partStart, partEnd, mode} = set;
    const boxes: number[] = [];
    const was = new Uint8Array(set.count);
    for (const w of this.worlds) {
      const worldOffset = w.world * this.worldWidth;
      const target = w.target;
      for (let i = 0; i < set.count; i++) {
        was[i] = w.alpha[i] > 0 || target[i] === 1 ? 1 : 0;
      }
      // labels already shown claim their place first, so labels do not flicker while the view moves
      for (let pass = 1; pass >= 0; pass--) {
        for (let o = 0; o < order.length; o++) {
          const i = order[o];
          if (was[i] !== pass) {
            continue;
          }
          boxes.length = 0;
          let onScreen = false;
          for (let part = partStart[i]; part < partEnd[i]; part++) {
            partBox(set.parts, part, frameState.coordinateToPixelTransform, worldOffset, viewCos, viewSin, tmp);
            if (tmp[2] >= 0 && tmp[0] <= width && tmp[3] >= 0 && tmp[1] <= height) {
              onScreen = true;
            }
            boxes.push(tmp[0], tmp[1], tmp[2], tmp[3]);
          }
          if (!onScreen) {
            // off screen labels take no space; they are placed when they scroll in
            target[i] = 0;
            continue;
          }
          let visible = true;
          if (mode[i] === MODE_DECLUTTER) {
            for (let b = 0; b < boxes.length; b += 4) {
              if (occupancy.collides(boxes[b], boxes[b + 1], boxes[b + 2], boxes[b + 3])) {
                visible = false;
                break;
              }
            }
          }
          target[i] = visible ? 1 : 0;
          if (visible && mode[i] !== MODE_NONE) {
            for (let b = 0; b < boxes.length; b += 4) {
              occupancy.insert(boxes[b], boxes[b + 1], boxes[b + 2], boxes[b + 3]);
            }
          }
        }
      }
      let fading = false;
      for (let i = 0; i < set.count; i++) {
        if (w.snap) {
          w.alpha[i] = target[i];
        } else if (w.alpha[i] !== target[i]) {
          fading = true;
        }
      }
      if (w.snap) {
        w.snap = false;
        this.writeOpacity(w);
      }
      w.fading = fading;
    }
    this.shownVersion++;
    this.stats.declutter = performance.now() - t0;
    return this.stats.declutter;
  }

  /** The labels to draw for this frame (null: none), with fades advanced to the frame time. */
  frame(frameState: FrameState): LabelFrame | null {
    const set = this.set;
    // a set of an earlier atlas generation is drawn from its own page until the new layout is there
    if (!set || !set.glyphCount || !this.worlds.length) {
      return null;
    }
    const now = frameState.time;
    const anyFading = this.worlds.some((w) => w.fading);
    // a fade starts in the frame that finds it: the time since the last drawn frame does not count
    const step = this.wasFading ? Math.min(1, Math.max(0, (now - this.lastFrameTime) / FADE)) : 0;
    this.lastFrameTime = now;
    this.wasFading = anyFading;
    for (const w of this.worlds) {
      if (!w.fading) {
        continue;
      }
      let fading = false;
      if (step > 0) {
        for (let i = 0; i < set.count; i++) {
          const a = w.alpha[i];
          const t = w.target[i];
          if (a !== t) {
            const v = t > a ? Math.min(t, a + step) : Math.max(t, a - step);
            w.alpha[i] = v;
            fading ||= v !== t;
          }
        }
        this.writeOpacity(w);
      } else {
        fading = true;
      }
      w.fading = fading;
      if (fading) {
        frameState.animate = true;
      }
    }
    return {set, page: set.page, worlds: this.worlds, worldWidth: this.worldWidth};
  }

  // --- hit detection -------------------------------------------------------

  /** Features whose shown label is within `tolerance` pixels of `pixel`, topmost first. */
  pick(pixel: number[], frameState: FrameState, tolerance: number): FeatureLike[] {
    const set = this.set;
    if (!set || !this.worlds.length) {
      return [];
    }
    const view = viewKey(frameState);
    let cache = this.hitCache;
    if (!cache || cache.view !== view || cache.version !== this.shownVersion) {
      const rotation = frameState.viewState.rotation;
      const viewCos = Math.cos(rotation);
      const viewSin = Math.sin(rotation);
      const boxes: number[] = [];
      const labels: number[] = [];
      for (const w of this.worlds) {
        const worldOffset = w.world * this.worldWidth;
        for (let i = 0; i < set.count; i++) {
          if (!w.target[i]) {
            continue;
          }
          for (let part = set.partStart[i]; part < set.partEnd[i]; part++) {
            partBox(set.parts, part, frameState.coordinateToPixelTransform, worldOffset, viewCos, viewSin, tmp);
            boxes.push(tmp[0], tmp[1], tmp[2], tmp[3]);
            labels.push(i);
          }
        }
      }
      cache = this.hitCache = {view, version: this.shownVersion, boxes: Float64Array.from(boxes), labels: Uint32Array.from(labels)};
    }
    const [x, y] = pixel;
    const {boxes, labels} = cache;
    const found: FeatureLike[] = [];
    // later labels are drawn on top
    for (let k = labels.length - 1; k >= 0; k--) {
      const b = k * 4;
      if (x >= boxes[b] - tolerance && x <= boxes[b + 2] + tolerance && y >= boxes[b + 1] - tolerance && y <= boxes[b + 3] + tolerance) {
        const feature = set.features[labels[k]];
        if (!found.includes(feature)) {
          found.push(feature);
        }
      }
    }
    return found;
  }

  dispose() {
    this.unlistenAtlas();
    this.atlas.forget(this);
    this.job = null;
    this.next = null;
    this.set = null;
    this.worlds = [];
  }
}

/** Sorts features by their uid (the order they were created in). */
function sortByUid(features: FeatureLike[]): FeatureLike[] {
  const uids = new Float64Array(features.length);
  const order = new Uint32Array(features.length);
  for (let i = 0; i < features.length; i++) {
    uids[i] = Number(getUid(features[i]));
    order[i] = i;
  }
  order.sort((a, b) => uids[a] - uids[b]);
  const sorted = new Array<FeatureLike>(features.length);
  for (let i = 0; i < features.length; i++) {
    sorted[i] = features[order[i]];
  }
  return sorted;
}

/** Per map: when decluttering last ran and for what, to pace it while the view moves. */
const pacing = new Map<string, {time: number; cost: number; view: string; labels: string}>();
const resolvedFrames = new WeakSet<FrameState>();

/** A layer whose renderer draws labels with `GpuText`. */
interface LabelLayer {
  hasRenderer?(): boolean;
  getRenderer(): {gpuText?: GpuText | null} | null;
}

/**
 * Prepares the labels of all ol-webgpu layers of a frame, once, before the
 * first of them draws: finished layouts are shown, and layers that
 * declutter claim screen space from the top layer down, sharing it within a
 * declutter group, as ol's Canvas layers do.
 */
export function resolveFrameLabels(frameState: FrameState) {
  if (resolvedFrames.has(frameState)) {
    return;
  }
  resolvedFrames.add(frameState);
  const texts: GpuText[] = [];
  for (const state of frameState.layerStatesArray) {
    const layer = state.layer as unknown as LabelLayer;
    if (!inView(state, frameState.viewState) || !layer.hasRenderer?.()) {
      continue;
    }
    const text = layer.getRenderer()?.gpuText;
    if (text) {
      text.begin(layer, frameState);
      texts.push(text);
    }
  }
  if (!texts.some((t) => t.declutter)) {
    return;
  }
  const mapId = String(frameState.mapId);
  const now = performance.now();
  const pace = pacing.get(mapId);
  const view = viewKey(frameState);
  const labels = texts.map((t) => t.identity()).join(',');
  if (pace && pace.labels === labels) {
    if (pace.view === view) {
      return; // nothing moved and nothing changed
    }
    if (isMoving(frameState) && pace.cost > RESOLVE_SLOW && now - pace.time < RESOLVE_INTERVAL) {
      frameState.animate = true; // due once the interval has passed
      return;
    }
  }
  const groups = new Map<string, Occupancy>();
  let cost = 0;
  for (let i = texts.length - 1; i >= 0; i--) {
    const text = texts[i];
    if (!text.declutter) {
      continue;
    }
    let occupancy = groups.get(text.declutter);
    if (!occupancy) {
      occupancy = new Occupancy();
      groups.set(text.declutter, occupancy);
    }
    cost += text.resolve(frameState, occupancy);
  }
  if (pacing.size > 64) {
    pacing.clear(); // maps come and go: the entries of disposed ones are dropped here
  }
  pacing.set(mapId, {time: now, cost, view, labels});
}
