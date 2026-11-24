/** Messages between the main thread and the ol-webgpu worker. */
import type {GeneratedBuffers} from '../wasm/core.js';

export interface BuildRequest {
  type: 'build';
  id: number;
  /** Render instructions per geometry kind (null when the style has no such pass). */
  points: ArrayBuffer | null;
  lines: ArrayBuffer | null;
  polygons: ArrayBuffer | null;
  /** Also make the rings of the polygons as lines, for the soft edge of fills (see `buildStylePasses`). */
  edges?: boolean;
  customSize: number;
  refOffset: number;
  /** Inverse of the transform used to create the instructions. */
  invert: number[];
  /** Instruction space → hit index space (isotropic pixels at build time); null = no index. */
  indexTransform: number[] | null;
}

/** The buffers of one geometry kind. */
export type BufferSet = GeneratedBuffers;

export interface BuildResponse {
  type: 'build';
  id: number;
  points: BufferSet | null;
  lines: BufferSet | null;
  polygons: BufferSet | null;
  /** The rings of the polygons as lines (when asked for). */
  edges?: BufferSet | null;
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
