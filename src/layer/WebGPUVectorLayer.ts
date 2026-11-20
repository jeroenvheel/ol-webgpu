import type VectorSource from 'ol/source/Vector.js';
import WebGPUVectorRenderer from '../renderer/WebGPUVectorRenderer.js';
import BaseGpuVectorLayer, {type GpuVectorLayerOptions} from './BaseGpuVectorLayer.js';

export interface WebGPUVectorLayerOptions<S extends VectorSource = VectorSource> extends GpuVectorLayerOptions<S> {
  /** URL of `ol_gpu_shader.wasm` (the GLSL → WGSL translator) if not served next to the module. */
  shaderWasmUrl?: string | URL;
}

/**
 * Vector layer rendered with WebGPU. Same options and style syntax as
 * `ol/layer/WebGLVector`; ol's shaders are translated to WGSL with naga
 * (compiled to WebAssembly). Use `GpuVectorLayer` to fall back to WebGL2
 * automatically where WebGPU is unavailable.
 */
export default class WebGPUVectorLayer<S extends VectorSource = VectorSource> extends BaseGpuVectorLayer<S> {
  constructor(options: WebGPUVectorLayerOptions<S>) {
    super(options);
  }

  getBackend(): 'webgpu' {
    return 'webgpu';
  }

  override createRenderer() {
    return new WebGPUVectorRenderer(this as any, {
      ...this.rendererOptions(),
      shaderWasmUrl: (this.gpuOptions as WebGPUVectorLayerOptions<S>).shaderWasmUrl,
    });
  }
}
