/**
 * Shared pipeline for the WebGL2 and WebGPU vector renderers:
 * source events → MixedGeometryBatch → render instructions (ol) → worker
 * (Rust/WASM buffers + hit index) → backend upload → draw per world.
 *
 * The transforms mirror ol's WebGLVectorLayerRenderer (ol 10.11). Features
 * are loaded when ol's layer would load them; the buffers are built less
 * often than ol builds them (see `needsRebuild`).
 */
import type {FeatureLike} from 'ol/Feature.js';
import {getUid} from 'ol/util.js';
import type {FrameState} from 'ol/Map.js';
import ViewHint from 'ol/ViewHint.js';
import {type Coordinate, wrapX} from 'ol/coordinate.js';
import {type EventsKey, listen, unlistenByKey} from 'ol/events.js';
import {buffer as bufferExtent, createEmpty, equals as extentEquals, getWidth} from 'ol/extent.js';
import {asArray, toString as colorToString} from 'ol/color.js';
import {type default as Layer, inView} from 'ol/layer/Layer.js';
import type {Pixel} from 'ol/pixel.js';
import {getTransformFromProjections, getUserProjection, toUserExtent, toUserResolution} from 'ol/proj.js';
import {
  generateLineStringRenderInstructions,
  generatePointRenderInstructions,
  generatePolygonRenderInstructions,
} from 'ol/render/webgl/renderinstructions.js';
import RenderEvent from 'ol/render/Event.js';
import LayerRenderer from 'ol/renderer/Layer.js';
import {getWorldParameters} from 'ol/renderer/webgl/worldUtil.js';
import type VectorSource from 'ol/source/Vector.js';
import VectorEventType from 'ol/source/VectorEventType.js';
import type {FlatStyleLike} from 'ol/style/flat.js';
import {type Transform, apply as applyTransform, create as createTransform, makeInverse, translate} from 'ol/transform.js';
import LabelsArray from 'ol/webgl/LabelsArray.js';
import {toFlatStyleLike} from 'ol/render/webgl/VectorStyleRenderer.js';
import {create as createMat4} from 'ol/vec/mat4.js';
import {FeatureBatch} from '../render/batch.js';
import {InstructionBuilder, InstructionJob, pause} from '../render/instructions.js';
import {Picker} from '../render/picking.js';
import {type TextImage, TextOverlay, overlayMatrix} from '../render/textOverlay.js';
import GpuText, {type LabelFrame, resolveFrameLabels} from '../text/GpuText.js';
import {type StylePasses, buildStylePasses} from '../render/stylePasses.js';
import {type Surface, type SurfaceSpec, acquireSurface, releaseSurface, surfaceSpec, surfaceType} from '../render/surface.js';
import {UniformState, makeProjectionTransform, worldOf} from '../render/uniforms.js';
import {type Core, LARGE_MEMORY_BYTES, loadCore} from '../wasm/core.js';
import {WorkerClient, WorkerFailedError, type WorkerOptions} from '../worker/client.js';
import type {BufferSet, BuildResponse} from '../worker/protocol.js';

export interface GpuVectorRendererOptions extends WorkerOptions {
  style: FlatStyleLike;
  variables: Record<string, any>;
  disableHitDetection?: boolean;
  /** Keep the drawing buffer after compositing (needed for map export); default true like ol. */
  preserveDrawingBuffer?: boolean;
  /**
   * Multisample antialiasing. Default false: ol's WebGL layers draw into an
   * offscreen framebuffer without multisampling, so false matches them
   * pixel for pixel.
   */
  antialias?: boolean;
  /**
   * How `text-*` styles are drawn. 'gpu' (default): glyphs from an atlas,
   * drawn by the layer itself. 'canvas': ol's text worker, as
   * `ol/layer/WebGLVector` does.
   */
  text?: 'gpu' | 'canvas';
  /** Declutter group for GPU text (false: labels may overlap). */
  declutter?: boolean | string | number;
  /**
   * Smooth edges for fills without a stroke: the fill fades out over one
   * pixel outside the polygon, instead of ending in stairs. Default false:
   * as ol's WebGL layers draw them.
   */
  smoothFill?: boolean;
}

/** The sub passes of a style pass and the buffers each draws, in draw order. */
export const KINDS = [
  ['fill', 'polygons'],
  ['edge', 'edges'],
  ['stroke', 'lines'],
  ['symbol', 'points'],
] as const;
export type Kind = (typeof KINDS)[number][0];

/** What a frame draws, the same for both backends. */
export interface FramePlan<B> {
  /** The buffers with something in them, in draw order. */
  draws: Array<{kind: Kind; set: UploadedSet<B>}>;
  /** Draw into the layer's own image first and composite that, instead of straight onto the canvas. */
  offscreen: boolean;
}

export interface UploadedSet<B> {
  /** The data, kept when the backend may have to upload it again (see `keepCpuCopies`). */
  cpu: BufferSet | null;
  indexCount: number;
  gpu: B;
}

export interface Uploaded<B> {
  polygons: UploadedSet<B> | null;
  /** The rings of the polygons as lines, for the soft edge of fills (`smoothFill`). */
  edges: UploadedSet<B> | null;
  lines: UploadedSet<B> | null;
  points: UploadedSet<B> | null;
  invertVerticesTransform: Transform;
  /** Text instructions set in ol's text worker (null: no text to draw). */
  textKey: string | null;
}

/** Statistics of the last rebuild, exposed for benchmarks and debugging. */
export interface RebuildStats {
  engine: 'wasm' | 'js';
  instructions: number;
  worker: Record<string, number>;
  total: number;
}

/**
 * How far, in pixels of the current view, the view centre may be from where
 * the buffers were built. A 32 bit float places a feature that far away to
 * about 0.05 pixel; it takes hundreds of screens of panning, or zooming in
 * some ten levels next to the centre of the build, to get there.
 */
const MAX_DRIFT_PX = 2 ** 19;
/** Milliseconds the instructions of a build are worked on before the page gets a turn. */
const INSTRUCTION_SLICE = 6;
/** How often a build that failed is made again before the layer waits for other features. */
const MAX_BUILD_RETRIES = 3;

let mainThreadCore: Promise<Core> | null = null;

/**
 * Canvas group keys of a frame's layers (computed once per frame, for all
 * layers). Weak: a frame state leads to its map, layers and features, which
 * must not outlive the map because it was the last one to render.
 */
const groupKeys = new WeakMap<FrameState, Map<unknown, string>>();
/** Background colour per canvas group of a frame (see `surfaceKeys`). */
const groupBackgrounds = new WeakMap<FrameState, Map<string, string>>();

/**
 * The `background` of a layer for a frame, as ol's Canvas layers show it:
 * behind the layer, with the layer's opacity, and only while the layer is
 * visible.
 */
function layerBackground(state: FrameState['layerStatesArray'][number], frameState: FrameState): string | undefined {
  let background = (state.layer as Layer).getBackground() as unknown;
  if (typeof background === 'function') {
    background = background(frameState.viewState.resolution);
  }
  if (!background || typeof background !== 'string' || !inView(state, frameState.viewState)) {
    return undefined;
  }
  try {
    const color = asArray(background);
    return colorToString([color[0], color[1], color[2], color[3] * state.opacity]);
  } catch {
    return undefined; // not a colour: nothing to show
  }
}

/**
 * Same grouping as ol's WebGL layers (renderer/webgl/Layer.js): consecutive
 * layers of one surface type with the same class name share a canvas; any
 * other layer in between starts a new group. Read from the layers
 * (`getSurfaceType`), so no renderers are created for hidden layers.
 *
 * A layer with a `background` is behind everything on its canvas (the
 * background is the canvas element's, as with ol's Canvas layers), so it
 * starts a new group unless the group so far has that background already.
 */
function surfaceKeys(frameState: FrameState): Map<unknown, string> {
  const known = groupKeys.get(frameState);
  if (known) {
    return known;
  }
  const keys = new Map<unknown, string>();
  const backgrounds = new Map<string, string>();
  const groups: Record<string, number> = {};
  let previous: {type: string; className: string; key: string; background: string | undefined} | null = null;
  for (const state of frameState.layerStatesArray) {
    const layer = state.layer as Layer & {getSurfaceType?: () => string};
    const type = layer.getSurfaceType?.();
    if (!type) {
      previous = null;
      continue;
    }
    const className = layer.getClassName();
    const background = layerBackground(state, frameState);
    if (!previous || previous.type !== type || previous.className !== className || (background && background !== previous.background)) {
      groups[type] = (groups[type] ?? -1) + 1;
      const key: string = `${frameState.mapId}/${type}/${groups[type]}`;
      previous = {type, className, key, background};
      if (background) {
        backgrounds.set(key, background);
      }
    }
    keys.set(layer, previous.key);
  }
  groupKeys.set(frameState, keys);
  groupBackgrounds.set(frameState, backgrounds);
  return keys;
}

/** Renderers currently alive (used by tests to wait until everything is drawn). */
export const liveRenderers = new Set<BaseGpuVectorRenderer<unknown>>();

export default abstract class BaseGpuVectorRenderer<B, S extends Surface = Surface> extends LayerRenderer<Layer<VectorSource>> {
  protected style: FlatStyleLike;
  protected variables: Record<string, any>;
  protected passes: StylePasses;
  protected readonly uniformState: UniformState;
  protected buffers: Uploaded<B> | null = null;
  /** Canvas shared with neighbouring layers of the same backend (set in prepareFrame). */
  protected surface: S | null = null;
  protected readonly spec: SurfaceSpec;
  protected readonly preserveDrawingBuffer: boolean;
  protected readonly antialias: boolean;
  private readonly smoothFill: boolean;
  /** Last rebuild statistics. */
  stats: RebuildStats | null = null;
  /** Buffer builds started so far (for tests and benchmarks). */
  builds = 0;
  /** Frames drawn since the last buffers became ready. */
  framesSinceReady = 0;

  private readonly batch = new FeatureBatch();
  private sourceKeys: EventsKey[] | null = null;
  /** The source the batch and the listeners are of (the layer may get another one). */
  private boundSource: VectorSource | null = null;
  /** Increases with every change of the batch (a job that makes instructions from it starts over). */
  private batchVersion = 0;
  /** Slices the instructions of the last build that needed more than one were made in (for tests). */
  instructionSlices = 1;
  /** Builds that failed in a row (see `rebuild`). */
  private buildFailures = 0;
  private buildRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private previousExtent = createEmpty();
  private sourceRevision = -1;
  private generation = 0;
  /** What the buffers, or those being built, were made for (null: build them again). */
  private built: {revision: number; center: number[]} | null = null;
  private instructions: InstructionBuilder;
  private readonly hitDetection: boolean;
  private picker: Picker | null = null;
  /** Latest index, kept until the main-thread wasm (and so the picker) is ready. */
  private pendingIndex: {data: Float32Array; center: number[]; resolution: number; frameState: FrameState} | null = null;
  private readonly worker: WorkerClient;
  private lastWorlds: number[] = [0];
  /** ol's text overlay worker client, when the style has text. */
  private textOverlay: TextOverlay | null = null;
  /** Same render-loop guard as ol's WebGLVectorLayerRenderer (`skipNextTextRender_`). */
  private skipNextTextRender = false;
  private layerRevision = -1;
  private readonly textMatrix = createMat4();
  private readonly textMode: 'gpu' | 'canvas';
  private readonly declutter: string | null;
  /** Labels drawn by the layer itself (text mode 'gpu'). */
  gpuText: GpuText | null = null;
  /** The labels to draw in the current frame. */
  protected labelFrame: LabelFrame | null = null;
  /** Images of the style that are still loading (see `awaitImage`). */
  private readonly pendingImages = new Set<HTMLImageElement>();
  /**
   * Whether the uploaded data is also kept in memory, to upload it again
   * at once when the context is lost or the layer moves to another canvas.
   * Without it the buffers are built again then, which takes a moment, and
   * the memory of a second copy of all buffers is saved.
   */
  protected readonly keepCpuCopies: boolean = true;
  // `ready` (what `rendercomplete` waits for) follows from these, see `updateReady`
  /** Buffers are being built for the current view. */
  private building = false;
  /** The buffers have text whose first image from ol's text worker has not arrived. */
  private awaitingText = false;
  /** The backend cannot draw yet (the WebGPU device is being requested). */
  protected backendPending = false;

  constructor(layer: Layer<VectorSource>, options: GpuVectorRendererOptions, backend: SurfaceSpec['backend']) {
    super(layer);
    this.style = options.style;
    this.variables = options.variables;
    this.hitDetection = !options.disableHitDetection;
    this.spec = surfaceSpec(backend, options);
    this.preserveDrawingBuffer = this.spec.preserveDrawingBuffer;
    this.antialias = this.spec.antialias;
    this.smoothFill = !!options.smoothFill;
    this.passes = buildStylePasses(this.style, this.variables, this.smoothFill);
    this.instructions = new InstructionBuilder(this.passes.customAttributes);
    this.uniformState = new UniformState(this.passes.uniforms);
    this.uniformState.onPendingImage = (image) => this.awaitImage(image);
    this.worker = WorkerClient.shared(options);
    this.textMode = options.text ?? 'gpu';
    this.declutter = options.declutter ? String(options.declutter) : null;
    this.updateTextMode();
    // Ready until the first rebuild starts, like ol's renderers: a layer outside its
    // zoom range never prepares a frame and must not hold back `rendercomplete`.
    liveRenderers.add(this as BaseGpuVectorRenderer<unknown>);

    if (this.hitDetection) {
      mainThreadCore ??= loadCore(options.wasmUrl);
      mainThreadCore.then(
        (core) => {
          this.picker = new Picker(core, this.style, this.variables);
          if (this.pendingIndex) {
            const {data, center, resolution, frameState} = this.pendingIndex;
            this.picker.load(data, {center, resolution});
            this.picker.measure(this.batch as any, frameState, this.getLayer().getSource()?.getRevision() ?? 0);
            this.pendingIndex = null;
          }
        },
        (e) => console.warn('ol-webgpu: hit detection unavailable (wasm failed to load)', e),
      );
    }
  }

  /** Prepare backend resources; return false while not ready (e.g. async WebGPU device). */
  protected abstract prepareBackend(frameState: FrameState): boolean;
  /** Compile programs / pipelines for the current `passes`. */
  protected abstract applyPasses(): void;
  /**
   * Uploads the buffers of one geometry kind. `reuse` is the previous
   * upload of that kind, which is no longer drawn: its GPU buffers are
   * written again where they are large enough, and released otherwise.
   * A rebuild then allocates nothing, where new buffers for every rebuild
   * pile up in the GPU process, which gives freed memory back late.
   */
  protected abstract upload(set: BufferSet, reuse?: B): B;
  protected abstract release(gpu: B): void;
  /**
   * Draw all worlds over what earlier layers drew on the shared canvas, with
   * the layer opacity; returns the rendering context for render events.
   */
  protected abstract draw(frameState: FrameState, worlds: number[], worldWidth: number, opacity: number): unknown;
  protected abstract createSurface(key: string, className: string): S;
  /** The renderer moved to another canvas (`previous` is still alive until this returns). */
  protected abstract surfaceChanged(previous: S | null): void;

  /** The canvas this layer draws into (shared with neighbouring layers). */
  get canvas(): HTMLCanvasElement {
    if (!this.surface) {
      throw new Error('ol-webgpu: the layer has not been prepared for a frame yet');
    }
    return this.surface.canvas;
  }

  // --- shared canvas ---------------------------------------------------

  /**
   * Same grouping as ol's WebGL layers (renderer/webgl/Layer.js): consecutive
   * layers of this backend with the same class name share a canvas; any other
   * layer in between starts a new group. Read from the layers
   * (`getSurfaceType`), so no renderers are created for hidden layers.
   */
  private surfaceKey(frameState: FrameState): string {
    return surfaceKeys(frameState).get(this.getLayer()) ?? `${frameState.mapId}/${surfaceType(this.spec)}/${getUid(this)}`;
  }

  private updateSurface(frameState: FrameState) {
    const key = this.surfaceKey(frameState);
    if (this.surface?.key === key) {
      this.surface.setBackground(groupBackgrounds.get(frameState)?.get(key));
      return;
    }
    const previous = this.surface;
    this.surface = acquireSurface(key, () => this.createSurface(key, this.getLayer().getClassName()));
    this.surface.setBackground(groupBackgrounds.get(frameState)?.get(key));
    this.surfaceChanged(previous);
    if (previous) {
      releaseSurface(previous);
    }
  }

  // --- text ------------------------------------------------------------

  /** Creates or drops the text renderer the current style needs. */
  private updateTextMode() {
    const canvas = this.passes.hasText && this.textMode === 'canvas';
    const gpu = this.passes.hasText && this.textMode === 'gpu';
    if (canvas && !this.textOverlay) {
      this.textOverlay = new TextOverlay();
    } else if (!canvas && this.textOverlay) {
      this.textOverlay.terminate();
      this.textOverlay = null;
    }
    if (gpu && !this.gpuText) {
      this.gpuText = new GpuText(this.style, this.variables, this.declutter, () => this.getLayer()?.getMapInternal()?.render());
    } else if (gpu) {
      this.gpuText!.setStyle(this.style, this.variables);
    } else if (this.gpuText) {
      this.gpuText.dispose();
      this.gpuText = null;
      this.labelFrame = null;
    }
  }

  /** Labels are being laid out or are fading (tests wait for this). */
  get labelsBusy(): boolean {
    return !!this.gpuText?.busy;
  }

  // --- style -----------------------------------------------------------

  setStyle(style: FlatStyleLike, variables: Record<string, any>) {
    this.style = style;
    this.variables = variables;
    this.passes = buildStylePasses(style, variables, this.smoothFill);
    this.uniformState.setStyleUniforms(this.passes.uniforms);
    this.pendingImages.clear();
    this.picker?.setStyle(style, variables);
    this.applyPasses();
    this.disposeBuffers();
    this.updateTextMode();
    this.instructions = new InstructionBuilder(this.passes.customAttributes);
    this.invalidate(); // the attribute layout changed
  }

  // --- source ----------------------------------------------------------

  /**
   * Takes the features of the layer's source and follows its changes. With
   * another source than before (`layer.setSource()`), nothing of the one
   * before is kept or shown.
   */
  private bindSource(source: VectorSource | null, frameState: FrameState) {
    this.sourceKeys?.forEach(unlistenByKey);
    this.sourceKeys = null;
    this.batchVersion++;
    if (this.boundSource) {
      this.batch.clear();
      this.instructions.reset();
      this.disposeBuffers();
      this.gpuText?.clear();
      this.labelFrame = null;
      this.buildFailures = 0;
    }
    this.boundSource = source;
    // a revision or an extent of the source before says nothing about this one
    this.sourceRevision = -1;
    this.previousExtent = createEmpty();
    this.invalidate();
    if (!source) {
      return;
    }
    const userProjection = getUserProjection();
    const projectionTransform = userProjection
      ? (getTransformFromProjections(userProjection, frameState.viewState.projection) ?? undefined)
      : undefined;
    this.batch.addFeatures(source.getFeatures(), projectionTransform);
    this.sourceKeys = [
      listen(source, VectorEventType.ADDFEATURE, (e: any) => {
        if (e.feature) {
          this.batchVersion++;
          this.batch.addFeature(e.feature, projectionTransform);
        }
      }),
      listen(source, VectorEventType.CHANGEFEATURE, (e: any) => {
        if (e.feature) {
          this.batchVersion++;
          this.instructions.forget(this.batch, e.feature);
          this.batch.changeFeature(e.feature, projectionTransform);
        }
      }),
      listen(source, VectorEventType.REMOVEFEATURE, (e: any) => {
        if (e.feature) {
          this.batchVersion++;
          this.instructions.forget(this.batch, e.feature);
          this.batch.removeFeature(e.feature);
        }
      }),
      listen(source, VectorEventType.CLEAR, () => {
        this.batchVersion++;
        this.batch.clear();
        this.instructions.reset();
      }),
    ];
  }

  // --- frame -----------------------------------------------------------

  /**
   * An image of the style (an icon, a fill or stroke pattern) is still
   * loading: the layer is drawn without it, is not ready (so
   * `rendercomplete` and a map export wait for it) and is drawn again when
   * the image is there.
   */
  private awaitImage(image: HTMLImageElement) {
    if (this.pendingImages.has(image)) {
      return;
    }
    this.pendingImages.add(image);
    const done = () => {
      image.removeEventListener('load', done);
      image.removeEventListener('error', done);
      // not for the images of a style that was replaced meanwhile
      if (!this.pendingImages.delete(image) || this.disposed) {
        return;
      }
      this.updateReady();
      this.getLayer()?.changed();
    };
    image.addEventListener('load', done);
    image.addEventListener('error', done);
    this.updateReady();
  }

  /** Sets `ready` from the state it follows from; the only place that does. */
  protected updateReady() {
    const ready = !this.building && !this.awaitingText && !this.backendPending && !this.gpuText?.pending && this.pendingImages.size === 0;
    if (ready && !this.ready) {
      this.framesSinceReady = 0;
    }
    this.ready = ready;
  }

  override prepareFrame(frameState: FrameState): boolean {
    this.updateSurface(frameState);
    const prepared = this.prepareBackend(frameState) && this.prepareData(frameState);
    this.updateReady();
    return prepared;
  }

  private prepareData(frameState: FrameState): boolean {
    const layer = this.getLayer();
    const source = layer.getSource();
    if (source !== this.boundSource) {
      this.bindSource(source, frameState);
    }
    const frameExtent = frameState.extent;
    if (!source || !frameExtent) {
      return true;
    }
    const viewNotMoving = !frameState.viewHints[ViewHint.ANIMATING] && !frameState.viewHints[ViewHint.INTERACTING];
    const extentChanged = !extentEquals(this.previousExtent, frameExtent);
    const sourceChanged = this.sourceRevision < source.getRevision();
    const layerChanged = this.layerRevision < layer.getRevision();
    this.sourceRevision = source.getRevision();
    this.layerRevision = layer.getRevision();
    if (layerChanged || extentChanged || sourceChanged) {
      this.skipNextTextRender = false; // as in ol: these changes need a fresh text image
    }

    if (viewNotMoving) {
      if (extentChanged || sourceChanged) {
        const resolution = frameState.viewState.resolution;
        const projection = frameState.viewState.projection;
        const renderBuffer = (layer as any).getRenderBuffer?.() ?? 0;
        const extent = bufferExtent(frameExtent, renderBuffer * resolution);
        const userProjection = getUserProjection();
        if (userProjection) {
          source.loadFeatures(toUserExtent(extent, userProjection), toUserResolution(resolution, projection), userProjection);
        } else {
          source.loadFeatures(extent, resolution, projection);
        }
        this.previousExtent = frameExtent.slice();
      }
    }
    // One build at a time: its result is drawn first, and the frame after
    // that starts the next one when the source changed in the meantime.
    // While the view moves, only other features are a reason to build: a map
    // that follows what it shows would otherwise never show it moving.
    if (!this.building && (viewNotMoving ? this.needsRebuild(frameState, source, extentChanged) : this.featuresChanged(source))) {
      this.rebuild(frameState, source.getRevision());
    }
    this.gpuText?.prepare(frameState, source);
    return true;
  }

  /**
   * The buffers hold every feature of the source and are drawn through the
   * inverse of the transform they were built with, so another extent alone
   * needs no new buffers. They are built again when the features changed,
   * and when the view is so far from where they were built that 32 bit
   * floats no longer place them exactly.
   */
  private needsRebuild(frameState: FrameState, source: VectorSource, extentChanged: boolean): boolean {
    const built = this.built;
    if (!built || built.revision !== source.getRevision()) {
      return true;
    }
    if (this.textOverlay) {
      return extentChanged; // ol's text worker draws the text for the view of the build
    }
    const resolution = frameState.viewState.resolution;
    const center = this.buildCenter(frameState);
    return Math.hypot(center[0] - built.center[0], center[1] - built.center[1]) > MAX_DRIFT_PX * resolution;
  }

  /**
   * The centre that buffers for this frame are built around: the centre of
   * the view, in the world of the projection. The buffers hold 32 bit floats
   * relative to it, and the features are in that world: around a centre some
   * worlds further they would be placed pixels off (16 px five worlds away
   * at a resolution of 1). The world copy under the view is drawn through
   * the transform of the frame, which is computed in doubles.
   */
  private buildCenter(frameState: FrameState): number[] {
    const center = frameState.viewState.center.slice();
    const projection = frameState.viewState.projection;
    // ol's text worker draws the text for the view as it is
    if (!this.textOverlay && this.getLayer().getSource()?.getWrapX()) {
      const world = worldOf(center[0], projection);
      if (world) {
        center[0] -= world * getWidth(projection.getExtent());
      }
    }
    return center;
  }

  /**
   * Whether the buffers were built for other features than the source holds
   * now. With ol's text worker the buffers wait for the view to rest, as in
   * ol: it draws the text for the view of the build.
   */
  private featuresChanged(source: VectorSource): boolean {
    return !this.textOverlay && this.built?.revision !== source.getRevision();
  }

  /** The buffers (also those being built) no longer fit: the next frame builds new ones. */
  private invalidate() {
    this.built = null;
    this.generation++; // the result of a running build is dropped
    this.building = false;
  }

  private rebuild(frameState: FrameState, revision: number) {
    const generation = ++this.generation;
    this.builds++;
    this.building = true;
    const center = this.buildCenter(frameState);
    this.built = {revision, center};
    this.framesSinceReady = 0;
    this.updateReady();
    const t0 = performance.now();
    const transform = makeProjectionTransform(frameState, createTransform(), true, center);
    const p = this.passes;
    const labels = new LabelsArray();
    const custom = p.customAttributes as any;
    const empty = this.batch.isEmpty();
    // like ol: text needs the instructions of every geometry type
    const text = this.textOverlay;
    // ol's text worker reads the labels array, which only ol's generators fill
    const kept = text ? null : this.instructions;
    const batch = this.batch;
    const wantPolygons = (p.hasFill || !!text) && !empty;
    const wantLines = (p.hasStroke || !!text) && !empty;
    const wantPoints = (p.hasSymbol || !!text) && !empty;
    // Our instructions are made in slices, so a big layer does not hold up the
    // page: `INSTRUCTION_SLICE` ms at a time, with a pause in between.
    const job = kept
      ? new InstructionJob(
          kept,
          {polygons: wantPolygons ? batch.polygonBatch : null, lines: wantLines ? batch.lineStringBatch : null, points: wantPoints ? batch.pointBatch : null},
          transform,
        )
      : null;
    const send = () => {
      // ol's generators make what ours could not (or all of it, for ol's text worker)
      const polygons = wantPolygons
        ? (job?.result('polygons') ?? generatePolygonRenderInstructions(batch.polygonBatch, new Float32Array(0), labels, custom, transform))
        : null;
      const lines = wantLines
        ? (job?.result('lines') ?? generateLineStringRenderInstructions(batch.lineStringBatch, new Float32Array(0), labels, custom, transform))
        : null;
      const points = wantPoints
        ? (job?.result('points') ?? generatePointRenderInstructions(batch.pointBatch, new Float32Array(0), labels, custom, transform))
        : null;
      this.submit(frameState, generation, t0, job ? job.time : performance.now() - t0, transform, center, {polygons, lines, points, labels});
    };
    if (!job || job.step(performance.now() + INSTRUCTION_SLICE)) {
      send();
      return;
    }
    const version = this.batchVersion;
    void (async () => {
      for (;;) {
        await pause();
        if (generation !== this.generation || this.disposed) {
          return;
        }
        if (version !== this.batchVersion) {
          // the features changed under the job: start over with what there is now
          this.invalidate();
          this.updateReady();
          this.getLayer()?.changed();
          return;
        }
        if (job.step(performance.now() + INSTRUCTION_SLICE)) {
          break;
        }
      }
      this.instructionSlices = job.slices;
      send();
    })();
  }

  /** The second half of a build: the instructions go to the worker, and what comes back is uploaded. */
  private submit(
    frameState: FrameState,
    generation: number,
    t0: number,
    instructionsTime: number,
    transform: Transform,
    center: number[],
    made: {polygons: Float32Array | null; lines: Float32Array | null; points: Float32Array | null; labels: LabelsArray},
  ) {
    const {polygons, lines, points, labels} = made;
    const p = this.passes;
    const text = this.textOverlay;
    const empty = this.batch.isEmpty();
    const invert = makeInverse(createTransform(), transform);
    const size = frameState.size;
    const resolution = frameState.viewState.resolution;

    // the text worker gets copies, before the buffers are transferred below
    const textKey =
      text && !empty
        ? text.build({polygons, lines, points, labels: labels.getArray()}, toFlatStyleLike(this.style as any) as FlatStyleLike, p.customAttributes, transform, resolution)
        : Promise.resolve(null);
    const geometry = this.worker.build({
      points: p.hasSymbol ? ((points?.buffer as ArrayBuffer) ?? null) : null,
      lines: p.hasStroke ? ((lines?.buffer as ArrayBuffer) ?? null) : null,
      polygons: p.hasFill ? ((polygons?.buffer as ArrayBuffer) ?? null) : null,
      edges: p.hasEdge,
      customSize: p.customSize,
      refOffset: p.refOffset,
      invert: Array.from(invert),
      // instruction space (clip, unrotated) → pixels at build time: isotropic for picking
      indexTransform: this.hitDetection ? [size[0] / 2, 0, 0, size[1] / 2, 0, 0] : null,
    });

    // without buffers the text image for these instructions is never shown
    geometry.catch(() => textKey.then((key) => key && text?.dispose(key))).catch(() => {});

    Promise.all([geometry, textKey])
      .then(([response, key]: [BuildResponse, string | null]) => {
        if (generation !== this.generation || this.disposed) {
          if (key) {
            text?.dispose(key);
          }
          return;
        }
        // the GPU buffers of the previous build go to the new one (see `upload`)
        const old = this.buffers;
        this.buffers = null;
        this.disposeBuffers();
        if (old?.textKey) {
          this.textOverlay?.dispose(old.textKey);
        }
        const up = (set: BufferSet | null, previous: UploadedSet<B> | null | undefined) => {
          if (!set) {
            if (previous) {
              this.release(previous.gpu);
            }
            return null;
          }
          return {cpu: this.keepCpuCopies ? set : null, indexCount: set.indices.length, gpu: this.upload(set, previous?.gpu)};
        };
        // with text, rendercomplete waits for the first image for these instructions (see requestText)
        this.awaitingText = !!key;
        this.buffers = {
          polygons: up(response.polygons, old?.polygons),
          edges: up(response.edges ?? null, old?.edges),
          lines: up(response.lines, old?.lines),
          points: up(response.points, old?.points),
          invertVerticesTransform: invert,
          textKey: key,
        };
        if (response.index) {
          if (this.picker) {
            this.picker.load(response.index, {center, resolution});
            this.picker.measure(this.batch as any, frameState, this.getLayer().getSource()?.getRevision() ?? 0);
          } else {
            this.pendingIndex = {data: response.index, center, resolution, frameState};
          }
        }
        this.buildFailures = 0;
        this.stats = {engine: response.engine, instructions: instructionsTime, worker: response.timings, total: performance.now() - t0};
        this.building = false;
        this.updateReady();
        this.getLayer()?.changed();
      })
      .catch((e) => {
        const workerFailed = e instanceof WorkerFailedError;
        if (!workerFailed) {
          console.error('ol-webgpu: buffer generation failed', e);
        }
        if (generation !== this.generation || this.disposed) {
          return;
        }
        this.building = false;
        this.awaitingText = false;
        if (workerFailed) {
          // the build was lost with the worker: the next frame builds on the main thread
          this.invalidate();
          this.getLayer()?.changed();
        } else if (++this.buildFailures <= MAX_BUILD_RETRIES) {
          // It may pass (memory that was short, mostly): the same build again after 1, 2
          // and 4 seconds, then not until the features change. The layer is ready
          // meanwhile, with the buffers it had.
          this.buildRetryTimer = setTimeout(() => {
            this.buildRetryTimer = null;
            if (generation === this.generation && !this.disposed) {
              this.invalidate();
              this.getLayer()?.changed();
            }
          }, 1000 * 2 ** (this.buildFailures - 1));
        }
        this.updateReady();
      });
  }

  /**
   * After each frame, asks ol's text worker for a text image of this frame;
   * when it arrives, the layer re-renders once to composite it. Mirrors
   * ol's WebGLVectorLayerRenderer, including its guard against an endless
   * render loop (`skipNextTextRender`).
   */
  private requestText(frameState: FrameState) {
    const text = this.textOverlay;
    if (!text) {
      return;
    }
    const key = this.buffers?.textKey ?? null;
    const generation = this.generation;
    text.render(frameState, key ? [key] : []).then((updated) => {
      if (!updated || this.disposed || text !== this.textOverlay) {
        return;
      }
      const firstImage = this.awaitingText && generation === this.generation && key !== null && key === this.buffers?.textKey;
      if (firstImage) {
        this.awaitingText = false;
        this.updateReady();
      } else if (this.skipNextTextRender) {
        this.skipNextTextRender = false;
        return;
      }
      this.skipNextTextRender = true;
      this.layerRevision++; // anticipates the revision after changed(), as ol does
      this.getLayer()?.changed();
    });
  }

  /** Latest text image and the matrix that maps it onto this frame (null: none). */
  protected textImage(frameState: FrameState): {image: TextImage; matrix: Float32Array | number[]} | null {
    const image = this.textOverlay?.image;
    if (!image) {
      return null;
    }
    return {image, matrix: overlayMatrix(image, frameState, this.textMatrix)};
  }

  override renderFrame(frameState: FrameState, _target: HTMLElement | null): HTMLElement {
    const layer = this.getLayer();
    const layerState = frameState.layerStatesArray[frameState.layerIndex];
    const surface = this.surface!;
    const pixelRatio = frameState.pixelRatio;
    surface.resize(
      Math.round(frameState.size[0] * pixelRatio),
      Math.round(frameState.size[1] * pixelRatio),
      frameState.size[0],
      frameState.size[1],
    );
    surface.beginFrame(frameState);

    // without a source there is nothing to repeat (and ol reads the source for the worlds)
    const [startWorld, endWorld, worldWidth] = layer.getSource() ? getWorldParameters(frameState, layer) : [0, 1, 0];
    const worlds: number[] = [];
    let world = startWorld;
    do {
      worlds.push(world);
    } while (++world < endWorld);
    this.lastWorlds = worlds.map((w) => w * worldWidth);

    resolveFrameLabels(frameState);
    this.labelFrame = this.gpuText?.frame(frameState) ?? null;

    this.dispatch('prerender', frameState, null);
    // the layer opacity is applied when drawing, as the canvas may be shared
    const context = this.draw(frameState, worlds, worldWidth, layerState.opacity);
    this.requestText(frameState);
    this.dispatch('postrender', frameState, context);
    if (this.ready) {
      this.framesSinceReady++;
    }
    return surface.canvas;
  }

  /**
   * Called on the map's `rendercomplete`, before listeners added later by
   * the app (the layer subscribes when it is added to the map). Lets the
   * WebGPU backend make its last frame readable for map export.
   */
  onRenderComplete(_frameState: FrameState | null | undefined) {}

  /** Called on the map's `postcompose`, after every layer of the frame has rendered. */
  onPostCompose(frameState: FrameState | null | undefined) {
    this.surface?.endFrame(frameState);
  }

  private dispatch(type: 'prerender' | 'postrender', frameState: FrameState, context: unknown) {
    const layer = this.getLayer();
    if (layer.hasListener(type)) {
      layer.dispatchEvent(new RenderEvent(type, undefined, frameState, context as any));
    }
  }

  /** What this frame draws (null: nothing, the surface clears at the end of the frame if needed). */
  protected framePlan(opacity: number, hasTextImage: boolean): FramePlan<B> | null {
    const b = this.buffers;
    const draws: FramePlan<B>['draws'] = [];
    for (const [kind, name] of KINDS) {
      const set = b?.[name];
      if (set && set.indexCount > 0) {
        draws.push({kind, set});
      }
    }
    if (!draws.length && !hasTextImage && !this.labelFrame) {
      return null;
    }
    // With full opacity the layer draws straight onto the shared canvas:
    // blending each feature over the canvas gives the same result as
    // compositing the layer image. A text image is composited as ol does it,
    // which needs the layer's own image.
    return {draws, offscreen: opacity < 1 || hasTextImage};
  }

  /** World → clip transform for one rendered world copy. */
  protected worldTransform(frameState: FrameState, world: number, worldWidth: number, out: Transform): Transform {
    makeProjectionTransform(frameState, out);
    return translate(out, world * worldWidth, 0);
  }

  // --- hit detection ---------------------------------------------------

  /**
   * Whether hit detection is fully set up for this view: index loaded and,
   * for data-driven sizes, the max size measured (picks are slower before).
   */
  isPickingReady(frameState: FrameState): boolean {
    return !!this.picker?.loaded && this.picker.isMeasured(frameState);
  }

  /**
   * The features at a coordinate of the map. On a map that shows the world
   * more than once, ol's map renderer asks three times for one pixel: for
   * the coordinate in the world of the projection, and one world to the west
   * and to the east of it (for features that cross the edge of the world).
   * So each call answers for its coordinate alone, or features would be
   * reported up to three times. Labels are placed per world on screen: they
   * are looked for in the call for the world of the projection only, in
   * every world that is drawn.
   */
  private *iteratePicks(coordinate: Coordinate, frameState: FrameState, hitTolerance: number): Generator<FeatureLike> {
    if (!this.hitDetection) {
      throw new Error('`forEachFeatureAtCoordinate` cannot be used on an ol-webgpu layer with `disableHitDetection: true`.');
    }
    // labels are drawn over the geometries
    const labelled: FeatureLike[] = [];
    const projection = frameState.viewState.projection;
    const extent = projection.getExtent();
    if (this.gpuText && (!projection.canWrapX() || !extent || (coordinate[0] >= extent[0] && coordinate[0] < extent[2]))) {
      for (const offset of this.lastWorlds) {
        const pixel = applyTransform(frameState.coordinateToPixelTransform, [coordinate[0] + offset, coordinate[1]]);
        for (const feature of this.gpuText.pick(pixel, frameState, hitTolerance)) {
          if (!labelled.includes(feature)) {
            labelled.push(feature);
            yield feature;
          }
        }
      }
    }
    if (this.picker) {
      for (const feature of this.picker.pick(coordinate, frameState, hitTolerance, (ref) => this.batch.getFeatureFromRef(ref))) {
        if (!labelled.includes(feature)) {
          yield feature;
        }
      }
    }
  }

  override forEachFeatureAtCoordinate<T>(
    coordinate: Coordinate,
    frameState: FrameState,
    hitTolerance: number,
    callback: (feature: FeatureLike, layer: any, geometry: any) => T,
  ): T | undefined {
    for (const feature of this.iteratePicks(coordinate, frameState, hitTolerance)) {
      const result = callback(feature, this.getLayer(), feature.getGeometry());
      if (result) {
        return result;
      }
    }
    return undefined;
  }

  override getFeatures(pixel: Pixel): Promise<FeatureLike[]> {
    const map = this.getLayer().getMapInternal?.();
    const frameState = (map as any)?.frameState_ as FrameState | undefined;
    if (!frameState) {
      return Promise.resolve([]);
    }
    // as ol's map renderer asks: in the world of the projection, and one world to both sides
    const coordinate = applyTransform(frameState.pixelToCoordinateTransform, pixel.slice());
    const projection = frameState.viewState.projection;
    const wraps = projection.canWrapX() && !!projection.getExtent();
    const width = wraps ? getWidth(projection.getExtent()) : 0;
    if (wraps && this.getLayer().getSource()?.getWrapX()) {
      wrapX(coordinate, projection);
    }
    const features: FeatureLike[] = [];
    for (const offset of wraps ? [0, -width, width] : [0]) {
      for (const feature of this.iteratePicks([coordinate[0] + offset, coordinate[1]], frameState, 0)) {
        if (!features.includes(feature)) {
          features.push(feature);
        }
      }
    }
    return Promise.resolve(features);
  }

  // --- cleanup ---------------------------------------------------------

  /** Frees the GPU buffers; the CPU copies stay for `reuploadBuffers`. */
  protected releaseBuffers() {
    for (const [, name] of KINDS) {
      const set = this.buffers?.[name];
      if (set) {
        this.release(set.gpu);
      }
    }
  }

  protected disposeBuffers() {
    this.releaseBuffers();
    if (this.buffers?.textKey) {
      this.textOverlay?.dispose(this.buffers.textKey);
    }
    this.buffers = null;
    this.picker?.clear();
  }

  /**
   * Makes the buffers usable again after their GPU objects are gone
   * (context or device lost, another canvas): uploaded from the CPU copies,
   * or built again when there are none.
   */
  protected reuploadBuffers() {
    if (!this.buffers) {
      return;
    }
    if (!this.keepCpuCopies) {
      this.disposeBuffers();
      this.invalidate();
      return;
    }
    for (const [, name] of KINDS) {
      const set = this.buffers[name];
      if (set?.cpu) {
        set.gpu = this.upload(set.cpu);
      }
    }
  }

  override disposeInternal() {
    liveRenderers.delete(this as BaseGpuVectorRenderer<unknown>);
    if (this.buildRetryTimer !== null) {
      clearTimeout(this.buildRetryTimer);
    }
    this.pendingImages.clear();
    this.disposeBuffers();
    const core = this.picker?.core;
    if (core && core.indexCount === 0 && core.memoryBytes > LARGE_MEMORY_BYTES) {
      // wasm memory only grows: the next layer gets a new, small instance
      mainThreadCore = null;
    }
    this.textOverlay?.terminate();
    this.textOverlay = null;
    this.gpuText?.dispose();
    this.gpuText = null;
    this.labelFrame = null;
    this.sourceKeys?.forEach(unlistenByKey);
    this.sourceKeys = null;
    if (this.surface) {
      releaseSurface(this.surface);
      this.surface = null;
    }
    super.disposeInternal();
  }
}
