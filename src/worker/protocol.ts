/** Messages between the main thread and the ol-webgpu worker. */

export interface BuildRequest {
  type: 'build';
  id: number;
  /** Render instructions per geometry kind (null when the style has no such pass). */
  points: ArrayBuffer | null;
  lines: ArrayBuffer | null;
  polygons: ArrayBuffer | null;
  customSize: number;
  refOffset: number;
  /** Inverse of the transform used to create the instructions. */
  invert: number[];
  /** Instruction space → hit index space (isotropic pixels at build time); null = no index. */
  indexTransform: number[] | null;
  /** Geometry used for the index, which may include kinds without a pass (picking only). */
  indexPoints?: ArrayBuffer | null;
  indexLines?: ArrayBuffer | null;
  indexPolygons?: ArrayBuffer | null;
}

export interface BufferSet {
  indices: Uint32Array;
  vertices: Float32Array;
  instances: Float32Array;
}

export interface BuildResponse {
  type: 'build';
  id: number;
  points: BufferSet | null;
  lines: BufferSet | null;
  polygons: BufferSet | null;
  /** Serialized hit index (see crates/core/src/index.rs). */
  index: Float32Array | null;
  /** 'wasm' or 'js' (fallback). */
  engine: 'wasm' | 'js';
  timings: Record<string, number>;
  error?: string;
}

export interface ReadyMessage {
  type: 'ready';
  engine: 'wasm' | 'js';
  error?: string;
}

export interface InitMessage {
  type: 'init';
  wasmUrl: string;
}
