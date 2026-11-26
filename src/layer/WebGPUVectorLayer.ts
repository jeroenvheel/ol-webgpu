import type VectorSource from 'ol/source/Vector.js';
import WebGPUVectorRenderer from '../renderer/WebGPUVectorRenderer.js';
import {loadShaderTranslator} from '../wasm/shader.js';
import {prepareDevice} from '../webgpu/device.js';
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
/**
 * Starts what the first frame of a WebGPU layer waits for: the device and
 * the shader translator. The first device of a page takes the browser 150
 * to 200 ms. A layer does this when it is made; a page that makes its
 * layers late (after its data is loaded, say) can call it when it starts.
 * Does nothing where WebGPU is not available.
 * @param shaderWasmUrl as the option of the layer, when that is set
 */
export function prepareWebGPU(shaderWasmUrl?: string | URL): void {
  prepareDevice();
  if (shaderWasmUrl === undefined) {
    // one of another URL is not shared: the renderer loads its own
    loadShaderTranslator().catch(() => {});
  }
}

export default class WebGPUVectorLayer<S extends VectorSource = VectorSource> extends BaseGpuVectorLayer<S> {
  constructor(options: WebGPUVectorLayerOptions<S>) {
    super(options);
    prepareWebGPU(options.shaderWasmUrl);
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
