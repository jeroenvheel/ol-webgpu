/**
 * Layer factories shared by examples, benchmark and rendering tests, so the
 * same scene can be rendered by ol's WebGLVector and by the ol-gpu layers.
 */
import type BaseLayer from 'ol/layer/Base.js';
import WebGLVectorLayer from 'ol/layer/WebGLVector.js';
import type VectorSource from 'ol/source/Vector.js';
import WebGL2VectorLayer from '../src/layer/WebGL2VectorLayer.js';
import WebGPUVectorLayer from '../src/layer/WebGPUVectorLayer.js';

export interface LayerOptions {
  source: VectorSource;
  style: any;
  variables?: Record<string, any>;
}

export const layerFactories: Record<string, (o: LayerOptions) => BaseLayer> = {
  ol: (o) => new WebGLVectorLayer({source: o.source, style: o.style, variables: o.variables}),
  webgl2: (o) => new WebGL2VectorLayer({source: o.source, style: o.style, variables: o.variables}),
  webgpu: (o) => new WebGPUVectorLayer({source: o.source, style: o.style, variables: o.variables}),
};
