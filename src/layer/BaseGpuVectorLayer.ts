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
}

/**
 * Common API of the ol-webgpu vector layers; mirrors `ol/layer/WebGLVector`.
 * Like WebGLVector, these layers must be disposed when no longer used.
 */
export default abstract class BaseGpuVectorLayer<S extends VectorSource = VectorSource> extends Layer<S, any> {
  protected styleVariables: StyleVariables;
  protected style: FlatStyleLike;
  protected readonly gpuOptions: GpuVectorLayerOptions<S>;
  private renderOrder: ((a: FeatureLike, b: FeatureLike) => number) | null;

  constructor(options: GpuVectorLayerOptions<S>) {
    const {style, variables, disableHitDetection, wasmUrl, preserveDrawingBuffer, antialias, smoothFill, renderOrder, text, declutter, ...base} = options;
    super(base);
    this.renderOrder = renderOrder ?? null;
    this.gpuOptions = options;
    this.style = style;
    this.styleVariables = variables ?? {};
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
    this.mapKeys.forEach(unlistenByKey);
    this.mapKeys = [];
    if (map) {
      const renderer = () => (this.hasRenderer() ? (this.getRenderer() as BaseGpuVectorRenderer<unknown>) : null);
      this.mapKeys.push(
        listen(map, 'postcompose', (e: any) => renderer()?.onPostCompose(e.frameState)),
        listen(map, 'rendercomplete', (e: any) => renderer()?.onRenderComplete(e.frameState)),
      );
    }
  }

  protected override disposeInternal() {
    this.mapKeys.forEach(unlistenByKey);
    this.mapKeys = [];
    super.disposeInternal();
  }
}
