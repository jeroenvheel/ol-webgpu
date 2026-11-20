import {existsSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import GeoJSON from 'ol/format/GeoJSON.js';
import MixedGeometryBatch from 'ol/render/webgl/MixedGeometryBatch.js';
import {
  generateLineStringRenderInstructions,
  generatePointRenderInstructions,
  generatePolygonRenderInstructions,
} from 'ol/render/webgl/renderinstructions.js';
import LabelsArray from 'ol/webgl/LabelsArray.js';
import {type Transform, create as createTransform, makeInverse, scale, translate} from 'ol/transform.js';
import {Core, loadCore} from '../../src/wasm/core.js';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const upstream = join(root, '.upstream', 'openlayers', 'test', 'rendering');

export async function loadTestCore(): Promise<Core> {
  const bytes = readFileSync(join(root, 'src', 'wasm', 'ol_gpu_core.wasm'));
  return loadCore(bytes);
}

/** Deterministic PRNG so failures are reproducible. */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export interface Instructions {
  points: Float32Array;
  lines: Float32Array;
  polygons: Float32Array;
  customSize: number;
  transform: Transform;
  invert: Transform;
}

/**
 * Runs real features through ol's own MixedGeometryBatch and render
 * instruction generators, as WebGLVector does. Custom attributes: a ref
 * (size 1) and a size-2 attribute, like hit detection colors.
 */
export function instructionsFromFeatures(features: any[]): Instructions {
  const batch = new MixedGeometryBatch();
  batch.addFeatures(features);
  const customAttributes = {
    ref: {size: 1, callback(this: any) { return this.ref ?? 0; }},
    pair: {size: 2, callback(this: any) { return [(this.ref ?? 0) * 2, 0.5]; }},
  };
  // similar to WebGLHelper.makeProjectionTransform at zoom ~2
  const transform = createTransform();
  scale(transform, 1 / 1e7, 1 / 1e7);
  translate(transform, -1000, 2000);
  const labels = new LabelsArray();
  return {
    points: generatePointRenderInstructions(batch.pointBatch, new Float32Array(0), labels, customAttributes as any, transform),
    lines: generateLineStringRenderInstructions(batch.lineStringBatch, new Float32Array(0), labels, customAttributes as any, transform),
    polygons: generatePolygonRenderInstructions(batch.polygonBatch, new Float32Array(0), labels, customAttributes as any, transform),
    customSize: 3,
    transform,
    invert: makeInverse(createTransform(), transform),
  };
}

export function countriesFeatures(): any[] | null {
  const file = join(upstream, 'data', 'countries.json');
  if (!existsSync(file)) {
    return null;
  }
  return new GeoJSON().readFeatures(readFileSync(file, 'utf8'), {featureProjection: 'EPSG:3857'});
}

export function triangleArea(vertices: Float32Array, indices: Uint32Array, stride: number): number {
  let area = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * stride;
    const b = indices[i + 1] * stride;
    const c = indices[i + 2] * stride;
    area += Math.abs(
      (vertices[b] - vertices[a]) * (vertices[c + 1] - vertices[a + 1]) -
        (vertices[c] - vertices[a]) * (vertices[b + 1] - vertices[a + 1]),
    ) / 2;
  }
  return area;
}
