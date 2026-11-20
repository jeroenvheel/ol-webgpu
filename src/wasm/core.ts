/**
 * Typed wrapper around the ol_gpu_core wasm module (plain extern "C" ABI).
 */
import type {Transform} from 'ol/transform.js';

interface CoreExports {
  memory: WebAssembly.Memory;
  olgpu_alloc(len: number): number;
  olgpu_free(ptr: number, len: number): void;
  olgpu_build_points(ptr: number, len: number, custom: number): void;
  olgpu_build_lines(
    ptr: number,
    len: number,
    custom: number,
    t0: number,
    t1: number,
    t2: number,
    t3: number,
    t4: number,
    t5: number,
  ): void;
  olgpu_build_polygons(ptr: number, len: number, custom: number): void;
  olgpu_out_ptr(kind: number): number;
  olgpu_out_len(kind: number): number;
  olgpu_out_reset(): void;
  olgpu_index_build(
    pp: number,
    pl: number,
    lp: number,
    ll: number,
    gp: number,
    gl: number,
    custom: number,
    refOffset: number,
    t0: number,
    t1: number,
    t2: number,
    t3: number,
    t4: number,
    t5: number,
  ): void;
  olgpu_index_load(ptr: number, len: number): number;
  olgpu_index_query(x: number, y: number, radius: number): number;
}

export interface GeneratedBuffers {
  indices: Uint32Array;
  vertices: Float32Array;
  instances: Float32Array;
}

/** One hit from {@link Core.queryIndex}: feature ref, geometry kind, draw sequence, distance. */
export interface IndexHit {
  ref: number;
  kind: number;
  seq: number;
  distance: number;
}

export const HIT_KIND_POLYGON = 0;
export const HIT_KIND_LINE = 1;
export const HIT_KIND_POINT = 2;

export type WasmSource = URL | string | BufferSource | WebAssembly.Module;

export class Core {
  private readonly ex: CoreExports;

  constructor(instance: WebAssembly.Instance) {
    this.ex = instance.exports as unknown as CoreExports;
  }

  /** Copies `data` into wasm memory, runs `fn(ptr, len)`, then frees it. */
  private withInput<T>(data: Float32Array, fn: (ptr: number, len: number) => T): T {
    const bytes = data.byteLength;
    const ptr = bytes ? this.ex.olgpu_alloc(bytes) : 0;
    if (bytes) {
      new Float32Array(this.ex.memory.buffer, ptr, data.length).set(data);
    }
    try {
      return fn(ptr, data.length);
    } finally {
      if (bytes) {
        this.ex.olgpu_free(ptr, bytes);
      }
    }
  }

  private readOutputs(): GeneratedBuffers {
    const ex = this.ex;
    const buf = () => ex.memory.buffer; // re-read: memory may have grown
    const indices = new Uint32Array(buf(), ex.olgpu_out_ptr(0), ex.olgpu_out_len(0)).slice();
    const vertices = new Float32Array(buf(), ex.olgpu_out_ptr(1), ex.olgpu_out_len(1)).slice();
    const instances = new Float32Array(buf(), ex.olgpu_out_ptr(2), ex.olgpu_out_len(2)).slice();
    ex.olgpu_out_reset();
    return {indices, vertices, instances};
  }

  buildPoints(instructions: Float32Array, customSize: number): GeneratedBuffers {
    this.withInput(instructions, (p, l) => this.ex.olgpu_build_points(p, l, customSize));
    return this.readOutputs();
  }

  /** `toWorld` is the inverse of the transform used to create the instructions. */
  buildLines(instructions: Float32Array, customSize: number, toWorld: Transform): GeneratedBuffers {
    const t = toWorld;
    this.withInput(instructions, (p, l) =>
      this.ex.olgpu_build_lines(p, l, customSize, t[0], t[1], t[2], t[3], t[4], t[5]),
    );
    return this.readOutputs();
  }

  buildPolygons(instructions: Float32Array, customSize: number): GeneratedBuffers {
    this.withInput(instructions, (p, l) => this.ex.olgpu_build_polygons(p, l, customSize));
    return this.readOutputs();
  }

  /**
   * Builds the hit index and returns it serialized (transferable to another
   * Core). `transform` maps instruction coordinates to index space.
   */
  buildIndex(
    points: Float32Array | null,
    lines: Float32Array | null,
    polygons: Float32Array | null,
    customSize: number,
    refOffset: number,
    transform: ArrayLike<number> = [1, 0, 0, 1, 0, 0],
  ): Float32Array {
    const empty = new Float32Array(0);
    const t = transform;
    this.withInput(points ?? empty, (pp, pl) =>
      this.withInput(lines ?? empty, (lp, ll) =>
        this.withInput(polygons ?? empty, (gp, gl) =>
          this.ex.olgpu_index_build(pp, pl, lp, ll, gp, gl, customSize, refOffset, t[0], t[1], t[2], t[3], t[4], t[5]),
        ),
      ),
    );
    return new Float32Array(
      this.ex.memory.buffer,
      this.ex.olgpu_out_ptr(4),
      this.ex.olgpu_out_len(4),
    ).slice();
  }

  loadIndex(serialized: Float32Array): boolean {
    return this.withInput(serialized, (p, l) => this.ex.olgpu_index_load(p, l) === 1);
  }

  /**
   * Raw hits within `radius` of (x, y), topmost first, as views on wasm
   * memory: 4 words per hit (ref, kind, seq, distance as f32). Valid until
   * the next call into this Core.
   */
  queryIndexRaw(x: number, y: number, radius: number): {count: number; words: Uint32Array; floats: Float32Array} {
    const count = this.ex.olgpu_index_query(x, y, radius);
    const ptr = this.ex.olgpu_out_ptr(3);
    const words = new Uint32Array(this.ex.memory.buffer, ptr, count * 4);
    const floats = new Float32Array(this.ex.memory.buffer, ptr, count * 4);
    return {count, words, floats};
  }

  /** Hits within `radius` of (x, y) in index space, topmost first. */
  queryIndex(x: number, y: number, radius: number): IndexHit[] {
    const count = this.ex.olgpu_index_query(x, y, radius);
    if (!count) {
      return [];
    }
    const words = new Uint32Array(this.ex.memory.buffer, this.ex.olgpu_out_ptr(3), count * 4);
    const floats = new Float32Array(words.buffer, words.byteOffset, count * 4);
    const hits: IndexHit[] = new Array(count);
    for (let i = 0; i < count; i++) {
      hits[i] = {
        ref: words[i * 4],
        kind: words[i * 4 + 1],
        seq: words[i * 4 + 2],
        distance: floats[i * 4 + 3],
      };
    }
    return hits;
  }
}

/**
 * Default location of the wasm binary, resolved by bundlers (Vite, webpack 5).
 * `?no-inline` keeps it a separate file in the library build (Vite's library
 * mode inlines assets otherwise); the query is not part of the emitted URL.
 */
export function defaultWasmUrl(): URL {
  return new URL('./ol_gpu_core.wasm?no-inline', import.meta.url);
}

export async function loadCore(source: WasmSource = defaultWasmUrl()): Promise<Core> {
  let module: WebAssembly.Module;
  if (source instanceof WebAssembly.Module) {
    module = source;
  } else if (source instanceof URL || typeof source === 'string') {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`ol-gpu: could not load wasm from ${source} (${response.status})`);
    }
    module = await WebAssembly.compile(await response.arrayBuffer());
  } else {
    module = await WebAssembly.compile(source);
  }
  const instance = await WebAssembly.instantiate(module, {});
  return new Core(instance);
}
