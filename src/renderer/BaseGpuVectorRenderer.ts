/**
 * Shared pipeline for the WebGL2 and WebGPU vector renderers:
 * source events → MixedGeometryBatch → render instructions (ol) → worker
 * (Rust/WASM buffers + hit index) → backend upload → draw per world.
 *
 * The rebuild trigger and transforms mirror ol's WebGLVectorLayerRenderer
 * (ol 10.11) so both new layers redraw exactly when ol's layer would.
 */
import type {FeatureLike} from 'ol/Feature.js';
import type {FrameState} from 'ol/Map.js';
import ViewHint from 'ol/ViewHint.js';
import type {Coordinate} from 'ol/coordinate.js';
import {type EventsKey, listen, unlistenByKey} from 'ol/events.js';
import {buffer as bufferExtent, createEmpty, equals as extentEquals} from 'ol/extent.js';
import type Layer from 'ol/layer/Layer.js';
import type {Pixel} from 'ol/pixel.js';
import {getTransformFromProjections, getUserProjection, toUserExtent, toUserResolution} from 'ol/proj.js';
import MixedGeometryBatch from 'ol/render/webgl/MixedGeometryBatch.js';
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
import {Picker} from '../render/picking.js';
import {type TextImage, TextOverlay, overlayMatrix} from '../render/textOverlay.js';
import {type StylePasses, buildStylePasses} from '../render/stylePasses.js';
import {type Surface, acquireSurface, releaseSurface} from '../render/surface.js';
import {UniformState, makeProjectionTransform} from '../render/uniforms.js';
import {type Core, loadCore} from '../wasm/core.js';
import {WorkerClient, type WorkerOptions} from '../worker/client.js';
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
}

export interface UploadedSet<B> {
  cpu: BufferSet;
  gpu: B;
}

export interface Uploaded<B> {
  polygons: UploadedSet<B> | null;
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

let mainThreadCore: Promise<Core> | null = null;

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
  protected readonly preserveDrawingBuffer: boolean;
  protected readonly antialias: boolean;
  /** Last rebuild statistics. */
  stats: RebuildStats | null = null;
  /** Frames drawn since the last buffers became ready. */
  framesSinceReady = 0;

  private readonly batch = new MixedGeometryBatch();
  private sourceKeys: EventsKey[] | null = null;
  private initialFeaturesAdded = false;
  private previousExtent = createEmpty();
  private sourceRevision = -1;
  private generation = 0;
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

  constructor(layer: Layer<VectorSource>, options: GpuVectorRendererOptions) {
    super(layer);
    this.style = options.style;
    this.variables = options.variables;
    this.hitDetection = !options.disableHitDetection;
    this.preserveDrawingBuffer = options.preserveDrawingBuffer ?? true;
    this.antialias = options.antialias ?? false;
    this.passes = buildStylePasses(this.style, this.variables);
    this.uniformState = new UniformState(this.passes.uniforms);
    this.worker = WorkerClient.shared(options);
    this.textOverlay = this.passes.hasText ? new TextOverlay() : null;
    // Ready until the first rebuild starts, like ol's renderers: a layer outside its
    // zoom range never prepares a frame and must not hold back `rendercomplete`.
    liveRenderers.add(this as BaseGpuVectorRenderer<unknown>);

    if (this.hitDetection) {
      mainThreadCore ??= loadCore(options.wasmUrl ?? undefined);
      mainThreadCore.then(
        (core) => {
          this.picker = new Picker(core, this.style, this.variables);
          if (this.pendingIndex) {
            const {data, center, resolution, frameState} = this.pendingIndex;
            this.picker.load(data, {center, resolution});
            this.picker.measure(this.batch as any, frameState);
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
  protected abstract upload(set: BufferSet): B;
  protected abstract release(gpu: B): void;
  /**
   * Draw all worlds over what earlier layers drew on the shared canvas, with
   * the layer opacity; returns the rendering context for render events.
   */
  protected abstract draw(frameState: FrameState, worlds: number[], worldWidth: number, opacity: number): unknown;
  /**
   * Layers share a canvas only when this matches: the backend plus every
   * option that is fixed per canvas (context attributes, sample count).
   */
  protected abstract surfaceType(): string;
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
    const type = this.surfaceType();
    const own = this.getLayer();
    let group = -1;
    let newGroup = true;
    let className: string | undefined;
    for (const state of frameState.layerStatesArray) {
      const layer = state.layer as Layer & {getSurfaceType?: () => string};
      if ((layer === own ? type : layer.getSurfaceType?.()) !== type) {
        newGroup = true;
        continue;
      }
      const layerClassName = layer.getClassName();
      if (newGroup || layerClassName !== className) {
        group++;
        newGroup = false;
      }
      className = layerClassName;
      if (layer === own) {
        break;
      }
    }
    return `${frameState.mapId}/${type}/${group}`;
  }

  private updateSurface(frameState: FrameState) {
    const key = this.surfaceKey(frameState);
    if (this.surface?.key === key) {
      return;
    }
    const previous = this.surface;
    this.surface = acquireSurface(key, () => this.createSurface(key, this.getLayer().getClassName()));
    this.surfaceChanged(previous);
    if (previous) {
      releaseSurface(previous);
    }
  }

  // --- style -----------------------------------------------------------

  setStyle(style: FlatStyleLike, variables: Record<string, any>) {
    this.style = style;
    this.variables = variables;
    this.passes = buildStylePasses(style, variables);
    this.uniformState.setStyleUniforms(this.passes.uniforms);
    this.picker?.setStyle(style, variables);
    this.applyPasses();
    this.disposeBuffers();
    if (this.passes.hasText && !this.textOverlay) {
      this.textOverlay = new TextOverlay();
    } else if (!this.passes.hasText && this.textOverlay) {
      this.textOverlay.terminate();
      this.textOverlay = null;
    }
    this.previousExtent = createEmpty(); // force a rebuild: the attribute layout changed
  }

  // --- source ----------------------------------------------------------

  private addInitialFeatures(frameState: FrameState) {
    const source = this.getLayer().getSource();
    if (!source) {
      return;
    }
    const userProjection = getUserProjection();
    const projectionTransform = userProjection
      ? (getTransformFromProjections(userProjection, frameState.viewState.projection) ?? undefined)
      : undefined;
    this.batch.addFeatures(source.getFeatures(), projectionTransform);
    this.sourceKeys = [
      listen(source, VectorEventType.ADDFEATURE, (e: any) => e.feature && this.batch.addFeature(e.feature, projectionTransform)),
      listen(source, VectorEventType.CHANGEFEATURE, (e: any) => e.feature && this.batch.changeFeature(e.feature, projectionTransform)),
      listen(source, VectorEventType.REMOVEFEATURE, (e: any) => e.feature && this.batch.removeFeature(e.feature)),
      listen(source, VectorEventType.CLEAR, () => this.batch.clear()),
    ];
  }

  // --- frame -----------------------------------------------------------

  override prepareFrame(frameState: FrameState): boolean {
    this.updateSurface(frameState);
    if (!this.prepareBackend(frameState)) {
      return false;
    }
    if (!this.initialFeaturesAdded) {
      this.addInitialFeatures(frameState);
      this.initialFeaturesAdded = true;
    }
    const layer = this.getLayer();
    const source = layer.getSource();
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

    if (viewNotMoving && (extentChanged || sourceChanged)) {
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
      this.rebuild(frameState);
      this.previousExtent = frameExtent.slice();
    }
    return true;
  }

  private rebuild(frameState: FrameState) {
    const generation = ++this.generation;
    this.ready = false;
    this.framesSinceReady = 0;
    const t0 = performance.now();
    const transform = makeProjectionTransform(frameState, createTransform(), true);
    const p = this.passes;
    const labels = new LabelsArray();
    const custom = p.customAttributes as any;
    const empty = this.batch.isEmpty();
    // like ol: text needs the instructions of every geometry type
    const text = this.textOverlay;
    const polygons = (p.hasFill || text) && !empty ? generatePolygonRenderInstructions(this.batch.polygonBatch, new Float32Array(0), labels, custom, transform) : null;
    const lines = (p.hasStroke || text) && !empty ? generateLineStringRenderInstructions(this.batch.lineStringBatch, new Float32Array(0), labels, custom, transform) : null;
    const points = (p.hasSymbol || text) && !empty ? generatePointRenderInstructions(this.batch.pointBatch, new Float32Array(0), labels, custom, transform) : null;
    const instructionsTime = performance.now() - t0;
    const invert = makeInverse(createTransform(), transform);
    const size = frameState.size;
    const center = frameState.viewState.center.slice();
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
      customSize: p.customSize,
      refOffset: p.refOffset,
      invert: Array.from(invert),
      // instruction space (clip, unrotated) → pixels at build time: isotropic for picking
      indexTransform: this.hitDetection ? [size[0] / 2, 0, 0, size[1] / 2, 0, 0] : null,
    });

    Promise.all([geometry, textKey])
      .then(([response, key]: [BuildResponse, string | null]) => {
        if (generation !== this.generation || this.disposed) {
          if (key) {
            text?.dispose(key);
          }
          return;
        }
        this.disposeBuffers();
        const up = (set: BufferSet | null) => (set ? {cpu: set, gpu: this.upload(set)} : null);
        this.buffers = {
          polygons: up(response.polygons),
          lines: up(response.lines),
          points: up(response.points),
          invertVerticesTransform: invert,
          textKey: key,
        };
        if (response.index) {
          if (this.picker) {
            this.picker.load(response.index, {center, resolution});
            this.picker.measure(this.batch as any, frameState);
          } else {
            this.pendingIndex = {data: response.index, center, resolution, frameState};
          }
        }
        this.stats = {engine: response.engine, instructions: instructionsTime, worker: response.timings, total: performance.now() - t0};
        // with labels, stay not-ready (no rendercomplete) until the first
        // text image for these instructions has arrived (see requestText)
        this.ready = !key;
        this.getLayer()?.changed();
      })
      .catch((e) => {
        console.error('ol-webgpu: buffer generation failed', e);
        this.ready = true;
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
      const firstImage = !this.ready && generation === this.generation && key !== null && key === this.buffers?.textKey;
      if (firstImage) {
        this.ready = true;
        this.framesSinceReady = 0;
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

    const [startWorld, endWorld, worldWidth] = getWorldParameters(frameState, layer);
    const worlds: number[] = [];
    let world = startWorld;
    do {
      worlds.push(world);
    } while (++world < endWorld);
    this.lastWorlds = worlds.map((w) => w * worldWidth);

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

  private pickFeatures(coordinate: Coordinate, frameState: FrameState, hitTolerance: number): FeatureLike[] {
    if (!this.hitDetection) {
      throw new Error('`forEachFeatureAtCoordinate` cannot be used on an ol-webgpu layer with `disableHitDetection: true`.');
    }
    if (!this.picker) {
      return [];
    }
    return [...this.iteratePicks(coordinate, frameState, hitTolerance)];
  }

  private *iteratePicks(coordinate: Coordinate, frameState: FrameState, hitTolerance: number): Generator<FeatureLike> {
    if (!this.hitDetection) {
      throw new Error('`forEachFeatureAtCoordinate` cannot be used on an ol-webgpu layer with `disableHitDetection: true`.');
    }
    if (this.picker) {
      yield* this.picker.pick(coordinate, frameState, hitTolerance, (ref) => this.batch.getFeatureFromRef(ref), this.lastWorlds);
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
    const coordinate = applyTransform(frameState.pixelToCoordinateTransform, pixel.slice());
    return Promise.resolve(this.pickFeatures(coordinate, frameState, 0));
  }

  // --- cleanup ---------------------------------------------------------

  protected disposeBuffers() {
    const b = this.buffers;
    if (b) {
      for (const set of [b.polygons, b.lines, b.points]) {
        if (set) {
          this.release(set.gpu);
        }
      }
      if (b.textKey) {
        this.textOverlay?.dispose(b.textKey);
      }
    }
    this.buffers = null;
    this.picker?.clear();
  }

  /** Re-uploads all buffers from their CPU copies (after context/device loss). */
  protected reuploadBuffers() {
    const b = this.buffers;
    if (!b) {
      return;
    }
    for (const set of [b.polygons, b.lines, b.points]) {
      if (set) {
        set.gpu = this.upload(set.cpu);
      }
    }
  }

  override disposeInternal() {
    liveRenderers.delete(this as BaseGpuVectorRenderer<unknown>);
    this.disposeBuffers();
    this.textOverlay?.terminate();
    this.textOverlay = null;
    this.sourceKeys?.forEach(unlistenByKey);
    this.sourceKeys = null;
    if (this.surface) {
      releaseSurface(this.surface);
      this.surface = null;
    }
    super.disposeInternal();
  }
}
