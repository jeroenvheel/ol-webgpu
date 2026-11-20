import type OlMap from 'ol/Map.js';
import {type EventsKey, listen, unlistenByKey} from 'ol/events.js';
import Layer, {type Options as LayerOptions} from 'ol/layer/Layer.js';
import type VectorSource from 'ol/source/Vector.js';
import type {FlatStyleLike, StyleVariables} from 'ol/style/flat.js';
import type BaseGpuVectorRenderer from '../renderer/BaseGpuVectorRenderer.js';

export interface GpuVectorLayerOptions<S extends VectorSource = VectorSource> extends Omit<LayerOptions<S>, 'render'> {
  /** Flat style, same syntax as `ol/layer/WebGLVector`, including `text-*` (drawn by ol's text worker). */
  style: FlatStyleLike;
  /** Style variables, used with `['var', name]`; update with `updateStyleVariables`. */
  variables?: StyleVariables;
  /** Skip building the hit index; `forEachFeatureAtPixel` will throw. */
  disableHitDetection?: boolean;
  /** URL of `ol_gpu_core.wasm` if it is not served next to the module. */
  wasmUrl?: string | URL;
  /**
   * Keep the last frame readable for map export (`drawImage` of the layer
   * canvas, e.g. in a `rendercomplete` listener). Default true. WebGPU keeps
   * a copy of each frame on the GPU for this (one texture copy per frame).
   */
  preserveDrawingBuffer?: boolean;
  /** Multisample antialiasing (default false = pixel parity with ol's WebGL layers). */
  antialias?: boolean;
}

/**
 * Common API of the ol-gpu vector layers; mirrors `ol/layer/WebGLVector`.
 * Like WebGLVector, these layers must be disposed when no longer used.
 */
export default abstract class BaseGpuVectorLayer<S extends VectorSource = VectorSource> extends Layer<S, any> {
  protected styleVariables: StyleVariables;
  protected style: FlatStyleLike;
  protected readonly gpuOptions: GpuVectorLayerOptions<S>;

  constructor(options: GpuVectorLayerOptions<S>) {
    const {style, variables, disableHitDetection, wasmUrl, preserveDrawingBuffer, antialias, ...base} = options;
    super(base);
    this.gpuOptions = options;
    this.style = style;
    this.styleVariables = variables ?? {};
  }

  protected rendererOptions() {
    return {
      style: this.style,
      variables: this.styleVariables,
      disableHitDetection: this.gpuOptions.disableHitDetection,
      wasmUrl: this.gpuOptions.wasmUrl,
      preserveDrawingBuffer: this.gpuOptions.preserveDrawingBuffer,
      antialias: this.gpuOptions.antialias,
    };
  }

  /** Updates style variables and re-renders (no recompilation). */
  updateStyleVariables(variables: StyleVariables) {
    Object.assign(this.styleVariables, variables);
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

  private renderCompleteKey: EventsKey | null = null;

  /**
   * Subscribes to the map's `rendercomplete` as soon as the layer is added,
   * so the renderer runs before export handlers that apps register later.
   */
  override setMapInternal(map: OlMap | null) {
    super.setMapInternal(map);
    if (this.renderCompleteKey) {
      unlistenByKey(this.renderCompleteKey);
      this.renderCompleteKey = null;
    }
    if (map) {
      this.renderCompleteKey = listen(map, 'rendercomplete', (e: any) => {
        if (this.hasRenderer()) {
          (this.getRenderer() as BaseGpuVectorRenderer<unknown>).onRenderComplete(e.frameState);
        }
      });
    }
  }

  protected override disposeInternal() {
    if (this.renderCompleteKey) {
      unlistenByKey(this.renderCompleteKey);
      this.renderCompleteKey = null;
    }
    super.disposeInternal();
  }
}
