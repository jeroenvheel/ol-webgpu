import type VectorSource from 'ol/source/Vector.js';
import WebGL2VectorRenderer from '../renderer/WebGL2VectorRenderer.js';
import WebGPUVectorRenderer from '../renderer/WebGPUVectorRenderer.js';
import {isWebGPUAvailable} from '../webgpu/device.js';
import BaseGpuVectorLayer from './BaseGpuVectorLayer.js';
import WebGL2VectorLayer from './WebGL2VectorLayer.js';
import type {WebGPUVectorLayerOptions} from './WebGPUVectorLayer.js';
import WebGPUVectorLayer, {prepareWebGPU} from './WebGPUVectorLayer.js';

export interface GpuVectorLayerOptionsWithBackend<S extends VectorSource = VectorSource> extends WebGPUVectorLayerOptions<S> {
  /** 'auto' (default) uses WebGPU when available, else WebGL2. */
  backend?: 'auto' | 'webgpu' | 'webgl2';
}

/**
 * Vector layer that renders with WebGPU where available and WebGL2
 * otherwise. If the WebGPU device cannot be created at runtime (no adapter,
 * blocklisted GPU), it switches to WebGL2 on its own.
 */
export default class GpuVectorLayer<S extends VectorSource = VectorSource> extends BaseGpuVectorLayer<S> {
  private backend: 'webgpu' | 'webgl2';

  constructor(options: GpuVectorLayerOptionsWithBackend<S>) {
    super(options);
    const wanted = options.backend ?? 'auto';
    this.backend = wanted === 'auto' ? (isWebGPUAvailable() ? 'webgpu' : 'webgl2') : wanted;
    if (this.backend === 'webgpu') {
      prepareWebGPU((options as WebGPUVectorLayerOptions<S>).shaderWasmUrl);
    }
  }

  /** The backend currently in use. */
  getBackend(): 'webgpu' | 'webgl2' {
    return this.backend;
  }

  override createRenderer() {
    if (this.backend === 'webgpu') {
      const renderer = new WebGPUVectorRenderer(this as any, {
        ...this.rendererOptions(),
        shaderWasmUrl: (this.gpuOptions as WebGPUVectorLayerOptions<S>).shaderWasmUrl,
      });
      renderer.onInitError = () => {
        console.warn('ol-webgpu: WebGPU unavailable, falling back to WebGL2');
        this.backend = 'webgl2';
        this.clearRenderer();
        this.changed();
      };
      renderer.onTooLarge = (bytes, limit) => {
        if (this.backend !== 'webgpu') {
          return;
        }
        console.warn(
          `ol-webgpu: a buffer of ${Math.round(bytes / 1048576)} MB is larger than the WebGPU device takes (${Math.round(limit / 1048576)} MB), falling back to WebGL2`,
        );
        this.backend = 'webgl2';
        this.clearRenderer();
        this.changed();
      };
      return renderer;
    }
    return new WebGL2VectorRenderer(this as any, this.rendererOptions());
  }
}

/** Creates a WebGPU or WebGL2 layer up front (no runtime switching). */
export function createGpuVectorLayer<S extends VectorSource = VectorSource>(options: GpuVectorLayerOptionsWithBackend<S>) {
  const useWebGPU = options.backend === 'webgpu' || ((options.backend ?? 'auto') === 'auto' && isWebGPUAvailable());
  return useWebGPU ? new WebGPUVectorLayer<S>(options) : new WebGL2VectorLayer<S>(options);
}
