/**
 * Stand-in for `ol/layer/WebGLVector.js` in the synced upstream cases:
 * `?layer=ol|webgl2|webgpu` picks the implementation.
 */
import WebGLVectorLayer from 'ol/layer/WebGLVector.js';
import WebGL2VectorLayer from '../../src/layer/WebGL2VectorLayer.js';
import WebGPUVectorLayer from '../../src/layer/WebGPUVectorLayer.js';

const which = new URLSearchParams(location.search).get('layer') ?? 'webgl2';
const Layer: any = which === 'ol' ? WebGLVectorLayer : which === 'webgpu' ? WebGPUVectorLayer : WebGL2VectorLayer;

export default Layer;
