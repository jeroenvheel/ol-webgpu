import type VectorSource from 'ol/source/Vector.js';
import WebGL2VectorRenderer from '../renderer/WebGL2VectorRenderer.js';
import BaseGpuVectorLayer from './BaseGpuVectorLayer.js';

/**
 * Vector layer rendered with WebGL2. Same options and style syntax as
 * `ol/layer/WebGLVector`; geometry buffers and the hit index are built by
 * the Rust/WebAssembly core in a worker.
 */
export default class WebGL2VectorLayer<S extends VectorSource = VectorSource> extends BaseGpuVectorLayer<S> {
  override createRenderer() {
    return new WebGL2VectorRenderer(this as any, this.rendererOptions());
  }
}
