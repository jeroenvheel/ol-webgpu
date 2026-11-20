/**
 * Stand-in for `ol/layer/WebGLVector.js` in the synced upstream cases:
 * `?layer=ol|webgl2|webgpu` picks the implementation, `&text=gpu|canvas`
 * how the ol-webgpu layers draw text (default: the layer's default).
 */
import WebGLVectorLayer from 'ol/layer/WebGLVector.js';
import WebGL2VectorLayer from '../../src/layer/WebGL2VectorLayer.js';
import WebGPUVectorLayer from '../../src/layer/WebGPUVectorLayer.js';

const params = new URLSearchParams(location.search);
const which = params.get('layer') ?? 'webgl2';
const text = params.get('text');
const Base: any = which === 'webgpu' ? WebGPUVectorLayer : WebGL2VectorLayer;

class Layer extends Base {
  constructor(options: any) {
    super(text ? {...options, text} : options);
  }
}

export default (which === 'ol' ? WebGLVectorLayer : Layer) as any;
