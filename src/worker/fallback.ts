/**
 * Pure JS buffer generation, used when WebAssembly is unavailable and as the
 * reference for golden tests. Mirrors the loops in `ol/worker/webgl.js`
 * (ol 10.11) and reuses ol's `bufferUtil.js` helpers unchanged.
 */
import {
  writeLineSegmentToBuffers,
  writePolygonTrianglesToBuffers,
} from 'ol/render/webgl/bufferUtil.js';
import type {Transform} from 'ol/transform.js';
import type {GeneratedBuffers} from '../wasm/core.js';

const QUAD_INDICES = [0, 1, 3, 1, 2, 3];
const QUAD_VERTICES = [-1, -1, 1, -1, 1, 1, -1, 1];

export function buildPointsJs(instructions: Float32Array, customSize: number): GeneratedBuffers {
  const stride = 2 + customSize;
  const count = Math.floor(instructions.length / stride);
  return {
    indices: Uint32Array.from(QUAD_INDICES),
    vertices: Float32Array.from(QUAD_VERTICES),
    instances: instructions.slice(0, count * stride),
  };
}

export function buildLinesJs(
  instructions: Float32Array,
  customSize: number,
  toWorld: Transform,
): GeneratedBuffers {
  const instanceAttributes: number[] = [];
  const perVertex = 3;
  let index = 0;
  while (index < instructions.length) {
    const customAttributes = Array.from(instructions.slice(index, index + customSize));
    index += customSize;
    const verticesCount = instructions[index++];
    const first = index;
    const last = index + (verticesCount - 1) * perVertex;
    const isLoop =
      instructions[first] === instructions[last] &&
      instructions[first + 1] === instructions[last + 1];
    let currentLength = 0;
    let currentAngleTangentSum = 0;
    for (let i = 0; i < verticesCount - 1; i++) {
      let before: number | null = null;
      if (i > 0) {
        before = index + (i - 1) * perVertex;
      } else if (isLoop) {
        before = last - perVertex;
      }
      let after: number | null = null;
      if (i < verticesCount - 2) {
        after = index + (i + 2) * perVertex;
      } else if (isLoop) {
        after = first + perVertex;
      }
      const measures = writeLineSegmentToBuffers(
        instructions,
        index + i * perVertex,
        index + (i + 1) * perVertex,
        before,
        after,
        instanceAttributes,
        customAttributes,
        toWorld,
        currentLength,
        currentAngleTangentSum,
      );
      currentLength = measures.length;
      currentAngleTangentSum = measures.angle;
    }
    index += verticesCount * perVertex;
  }
  return {
    indices: Uint32Array.from(QUAD_INDICES),
    vertices: Float32Array.from(QUAD_VERTICES),
    instances: Float32Array.from(instanceAttributes),
  };
}

export function buildPolygonsJs(instructions: Float32Array, customSize: number): GeneratedBuffers {
  const vertices: number[] = [];
  const indices: number[] = [];
  let index = 0;
  while (index < instructions.length) {
    index = writePolygonTrianglesToBuffers(instructions, index, vertices, indices, customSize);
  }
  return {
    indices: Uint32Array.from(indices),
    vertices: Float32Array.from(vertices),
    instances: new Float32Array(0),
  };
}
