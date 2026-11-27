import type {FeatureLike} from 'ol/Feature.js';
import type OlMap from 'ol/Map.js';
import {type EventsKey, listen, unlistenByKey} from 'ol/events.js';
import Layer, {type Options as LayerOptions} from 'ol/layer/Layer.js';
import type VectorSource from 'ol/source/Vector.js';
import type {FlatStyleLike, StyleVariables} from 'ol/style/flat.js';
import {surfaceSpec, surfaceType} from '../render/surface.js';
import type BaseGpuVectorRenderer from '../renderer/BaseGpuVectorRenderer.js';

export interface GpuVectorLayerOptions<S extends VectorSource = VectorSource> extends Omit<LayerOptions<S>, 'render'> {
  /** Flat style, same syntax as `ol/layer/WebGLVector`, including `text-*` (see `text`). */
  style: FlatStyleLike;
  /** Style variables, used with `['var', name]`; update with `updateStyleVariables`. */
  variables?: StyleVariables;
  /** Skip building the hit index; `forEachFeatureAtPixel` will throw. */
  disableHitDetection?: boolean;
  /** URL of `ol_gpu_core.wasm` if it is not served next to the module. */
  wasmUrl?: string | URL;
  /**
   * Keep the last frame readable for map export (`drawImage` of the layer
   * canvas, e.g. in a `rendercomplete` listener). Default true. WebGPU draws
   * the last frame once more on `rendercomplete` for this.
   */
  preserveDrawingBuffer?: boolean;
  /** Multisample antialiasing (default false = pixel parity with ol's WebGL layers). */
  antialias?: boolean;
  /**
   * Smooth edges for fills without a stroke: the fill fades out over one
   * pixel outside the polygon instead of ending in stairs, without the cost
   * of `antialias`. Default false (pixel parity with ol's WebGL layers).
   */
  smoothFill?: boolean;
  /**
   * WebGL2 only: keep a copy of the layer's buffers in memory, to upload
   * them again at once after a lost context or when the layer moves to
   * another canvas (other layers came between it and its neighbours).
   * By default for layers whose buffers are up to 32 MB together: a larger
   * layer does without (that memory is about a third of what it holds
   * besides its features), and is built again in those cases, which takes
   * as long as the first time and leaves it undrawn meanwhile. True keeps
   * the copy whatever the size, false never.
   */
  keepBuffers?: boolean;
  /**
   * The order of the features: a function that compares two features, as
   * `renderOrder` of ol's Canvas vector layer. Features that come first are
   * drawn first, so below the others of their kind (fills, strokes or
   * symbols). A `z-index` in the style goes before it. Default: the order
   * the features came into the source.
   */
  renderOrder?: ((a: FeatureLike, b: FeatureLike) => number) | null;
  /**
   * How `text-*` styles are drawn. 'gpu' (default): glyphs from an atlas
   * drawn by the layer itself, with the page's fonts, at the device pixel
   * ratio, in every world copy, and hit-detectable. 'canvas': ol's text
   * worker, as `ol/layer/WebGLVector` does (pixel for pixel the same).
   */
  text?: 'gpu' | 'canvas';
  /**
   * Hide labels that would overlap (GPU text only). Layers with the same
   * value share a declutter group, in which higher layers go first.
   * Default false.
   */
  declutter?: boolean | string | number;
  /**
   * Ask the source for the features of the view also while the view is
   * animated (a source with a loading strategy then loads during the
   * animation, not after it). Default false, as in ol's vector layers.
   */
  updateWhileAnimating?: boolean;
  /** As `updateWhileAnimating`, while the user drags or pinches the view. Default false. */
  updateWhileInteracting?: boolean;
}

/**
 * Common API of the ol-webgpu vector layers; mirrors `ol/layer/WebGLVector`.
 *
 * A layer that is taken from its map, or whose map is taken from the page
 * (`map.setTarget(null)`, `map.dispose()`), gives up what the garbage
 * collector cannot free (buffers and textures on the GPU, its part of a
 * shared canvas, its hit index and its listeners on the source), so it does
 * not have to be disposed for that. It builds everything again when it is
 * drawn again.
 */
export default abstract class BaseGpuVectorLayer<S extends VectorSource = VectorSource> extends Layer<S, any> {
  protected styleVariables: StyleVariables;
  protected style: FlatStyleLike;
  protected readonly gpuOptions: GpuVectorLayerOptions<S>;
  private renderOrder: ((a: FeatureLike, b: FeatureLike) => number) | null;
  private readonly updateWhileAnimating: boolean;
  private readonly updateWhileInteracting: boolean;

  constructor(options: GpuVectorLayerOptions<S>) {
    const {
      style,
      variables,
      disableHitDetection,
      wasmUrl,
      preserveDrawingBuffer,
      antialias,
      smoothFill,
      keepBuffers,
      renderOrder,
      text,
      declutter,
      updateWhileAnimating,
      updateWhileInteracting,
      map,
      ...base
    } = options;
    super(base);
    this.updateWhileAnimating = !!updateWhileAnimating;
    this.updateWhileInteracting = !!updateWhileInteracting;
    this.renderOrder = renderOrder ?? null;
    this.gpuOptions = options;
    this.style = style;
    this.styleVariables = variables ?? {};
    if (map) {
      this.setMap(map); // not by ol's constructor: the fields above are not there yet when it runs
    }
  }

  /** Whether the source is asked for features while the view is animated (see the option). */
  getUpdateWhileAnimating(): boolean {
    return this.updateWhileAnimating;
  }

  /** Whether the source is asked for features while the user moves the view (see the option). */
  getUpdateWhileInteracting(): boolean {
    return this.updateWhileInteracting;
  }

  /** The backend the layer renders with (for `GpuVectorLayer`, the one currently in use). */
  abstract getBackend(): 'webgpu' | 'webgl2';

  /**
   * Layers share a canvas only when this matches: the backend plus the
   * options that are fixed per canvas. Known without creating the renderer,
   * so grouping layers does not create renderers for hidden layers.
   * @internal
   */
  getSurfaceType(): string {
    return surfaceType(surfaceSpec(this.getBackend(), this.gpuOptions));
  }

  protected rendererOptions() {
    return {
      style: this.style,
      variables: this.styleVariables,
      disableHitDetection: this.gpuOptions.disableHitDetection,
      wasmUrl: this.gpuOptions.wasmUrl,
      preserveDrawingBuffer: this.gpuOptions.preserveDrawingBuffer,
      antialias: this.gpuOptions.antialias,
      smoothFill: this.gpuOptions.smoothFill,
      keepBuffers: this.gpuOptions.keepBuffers,
      renderOrder: this.renderOrder,
      text: this.gpuOptions.text,
      declutter: this.gpuOptions.declutter,
    };
  }

  /** Updates style variables and re-renders (no recompilation). */
  updateStyleVariables(variables: StyleVariables) {
    Object.assign(this.styleVariables, variables);
    this.changed();
  }

  /** The function that orders the features (see the `renderOrder` option). */
  getRenderOrder(): ((a: FeatureLike, b: FeatureLike) => number) | null {
    return this.renderOrder;
  }

  /** Sets the function that orders the features (null: as they came into the source); the buffers are built again. */
  setRenderOrder(renderOrder: ((a: FeatureLike, b: FeatureLike) => number) | null) {
    this.renderOrder = renderOrder;
    const renderer = this.getRenderer() as BaseGpuVectorRenderer<unknown> | null;
    if (renderer && this.hasRenderer()) {
      renderer.setRenderOrder(renderOrder);
    }
    this.changed();
  }

  /** Replaces the style (shaders are recompiled). */
  setStyle(style: FlatStyleLike) {
    this.style = style;
    const renderer = this.getRenderer() as BaseGpuVectorRenderer<unknown> | null;
    if (renderer && this.hasRenderer()) {
      renderer.setStyle(style, this.styleVariables);
    }
    this.changed();
  }

  getStyle(): FlatStyleLike {
    return this.style;
  }

  private mapKeys: EventsKey[] = [];

  /**
   * Subscribes to the map as soon as the layer is added: to `rendercomplete`
   * so the renderer runs before export handlers that apps register later, and
   * to `postcompose` so a frame's GPU work is submitted before anything else
   * in that task reads the canvas.
   */
  override setMapInternal(map: OlMap | null) {
    super.setMapInternal(map);
    this.watchMap();
  }

  /**
   * The map the layer is drawn by: the one it is in the layers of, or the
   * one of `setMap` (which ol does not keep on the layer).
   * @internal
   */
  getRenderingMap(): OlMap | null {
    return this.getMapInternal() ?? this.unmanagedMap;
  }

  private watchMap() {
    this.mapKeys.forEach(unlistenByKey);
    this.mapKeys = [];
    this.watchTarget();
    this.releaseWithoutMap();
    const map = this.getRenderingMap();
    if (map) {
      const renderer = () => (this.hasRenderer() ? (this.getRenderer() as BaseGpuVectorRenderer<unknown>) : null);
      this.mapKeys.push(
        listen(map, 'postcompose', (e: any) => renderer()?.onPostCompose(e.frameState)),
        listen(map, 'rendercomplete', (e: any) => renderer()?.onRenderComplete(e.frameState)),
        // a map without a target draws nothing (and that is how a map is thrown away)
        listen(map, 'change:target', () => {
          this.watchTarget();
          this.releaseWithoutMap();
        }),
      );
    }
  }

  private targetObserver: ResizeObserver | null = null;

  /**
   * Watches the element of the map: an element that is taken from the page
   * gets no size, which is the only thing that tells. (ol watches it too,
   * but keeps the size the map had.)
   */
  private watchTarget() {
    this.targetObserver?.disconnect();
    this.targetObserver = null;
    const element = this.getRenderingMap()?.getTargetElement();
    if (element && typeof ResizeObserver !== 'undefined') {
      this.targetObserver = new ResizeObserver(() => {
        if (!element.isConnected) {
          // An observer with an element keeps both, and through them the layer and
          // its map, from the garbage collector. The layer watches again when it
          // is drawn again (see `render`).
          this.targetObserver?.disconnect();
          this.targetObserver = null;
        }
        this.releaseWithoutMap();
      });
      this.targetObserver.observe(element);
    }
  }

  override render(frameState: any, target: HTMLElement): HTMLElement | null {
    if (!this.targetObserver) {
      this.watchTarget(); // back on a page after its element was taken from one
    }
    return super.render(frameState, target);
  }

  /** The map of a layer that is not in its layers (`setMap`). */
  private unmanagedMap: OlMap | null = null;

  override setMap(map: OlMap | null) {
    super.setMap(map);
    this.unmanagedMap = map;
    this.watchMap();
  }

  private releaseTimer: ReturnType<typeof setTimeout> | null = null;

  /** Whether the layer is of a map that is on a page. */
  private isShown(): boolean {
    const map = this.getRenderingMap();
    // An element that is not in a document shows nothing: that is how a page throws
    // a map away without telling it (the element is removed, the map forgotten).
    return !!map?.getTarget() && map.getTargetElement()?.isConnected !== false;
  }

  /**
   * A layer without a map, or of a map without a target or with one that is
   * not on the page, gives up its renderer, and with it everything that is not freed by the garbage
   * collector (see the class). Not at once: a layer that is taken out to be
   * put back in another place of the layers or in another map, and a map
   * that is moved to another element, keep what was built.
   */
  private releaseWithoutMap() {
    if (this.releaseTimer !== null) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    if (this.isShown() || !this.hasRenderer()) {
      return;
    }
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null;
      if (!this.isShown()) {
        this.clearRenderer();
      }
    }, 0);
  }

  protected override disposeInternal() {
    if (this.releaseTimer !== null) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    this.mapKeys.forEach(unlistenByKey);
    this.mapKeys = [];
    this.targetObserver?.disconnect();
    this.targetObserver = null;
    super.disposeInternal();
  }
}
