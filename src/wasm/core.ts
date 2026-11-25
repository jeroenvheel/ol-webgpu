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
  olgpu_index_reset(): void;
  olgpu_index_load(ptr: number, len: number): number;
  olgpu_index_free(handle: number): void;
  olgpu_index_query(handle: number, x: number, y: number, radius: number): number;
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
/** Words per hit of `queryIndexRaw` (`HIT_WORDS` of the core). */
export const HIT_WORDS = 6;
export const HIT_KIND_POINT = 2;

export type WasmSource = URL | string | BufferSource | WebAssembly.Module;

/**
 * An instance whose memory grew past this is worth replacing by a new one
 * once it holds nothing: wasm memory only grows, so a large build or index
 * would otherwise be paid for as long as the page lives.
 */
export const LARGE_MEMORY_BYTES = 32 * 1024 * 1024;

export class Core {
  private readonly ex: CoreExports;
  /** Indexes loaded and not freed. */
  indexCount = 0;

  constructor(instance: WebAssembly.Instance) {
    this.ex = instance.exports as unknown as CoreExports;
  }

  /** Size of the instance's memory. It only grows: freed memory is used again, not given back. */
  get memoryBytes(): number {
    return this.ex.memory.buffer.byteLength;
  }

  /** Copies `data` into wasm memory, runs `fn(ptr, len)`, then frees it. */
  private withInput<T>(data: Float32Array | null, fn: (ptr: number, len: number) => T): T {
    const bytes = data?.byteLength ?? 0;
    const ptr = bytes ? this.ex.olgpu_alloc(bytes) : 0;
    if (data && bytes) {
      new Float32Array(this.ex.memory.buffer, ptr, data.length).set(data);
    }
    try {
      return fn(ptr, data?.length ?? 0);
    } finally {
      if (bytes) {
        this.ex.olgpu_free(ptr, bytes);
      }
    }
  }

  /**
   * Everything a rebuild needs from the instructions of a layer, with each
   * array copied into wasm memory once: the hit index (when
   * `indexTransform` is given), then the buffers of lines and polygons.
   * Point instances are the point instructions themselves, so those are
   * not built here (see `buildPointsJs`).
   */
  buildAll(
    points: Float32Array | null,
    lines: Float32Array | null,
    polygons: Float32Array | null,
    customSize: number,
    toWorld: Transform,
    indexTransform: ArrayLike<number> | null,
    refOffset = 0,
    timings: Record<string, number> = {},
  ): {lines: GeneratedBuffers | null; polygons: GeneratedBuffers | null; index: Float32Array | null} {
    const ex = this.ex;
    const time = <T>(name: string, fn: () => T): T => {
      const t0 = performance.now();
      const result = fn();
      timings[name] = performance.now() - t0;
      return result;
    };
    return this.withInput(lines, (lp, ll) =>
      this.withInput(polygons, (gp, gl) => {
        const t = indexTransform;
        const index =
          t &&
          time('index', () =>
            this.withInput(points, (pp, pl) => {
              ex.olgpu_index_build(pp, pl, lp, ll, gp, gl, customSize, refOffset, t[0], t[1], t[2], t[3], t[4], t[5]);
              const serialized = this.readIndex();
              ex.olgpu_index_reset(); // its memory is free for the buffers built next
              return serialized;
            }),
          );
        const w = toWorld;
        return {
          index,
          lines:
            lines &&
            time('lines', () => {
              ex.olgpu_build_lines(lp, ll, customSize, w[0], w[1], w[2], w[3], w[4], w[5]);
              return this.readOutputs();
            }),
          polygons:
            polygons &&
            time('polygons', () => {
              ex.olgpu_build_polygons(gp, gl, customSize);
              return this.readOutputs();
            }),
        };
      }),
    );
  }

  private readIndex(): Float32Array {
    return new Float32Array(this.ex.memory.buffer, this.ex.olgpu_out_ptr(4), this.ex.olgpu_out_len(4)).slice();
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
    const t = transform;
    this.withInput(points, (pp, pl) =>
      this.withInput(lines, (lp, ll) =>
        this.withInput(polygons, (gp, gl) =>
          this.ex.olgpu_index_build(pp, pl, lp, ll, gp, gl, customSize, refOffset, t[0], t[1], t[2], t[3], t[4], t[5]),
        ),
      ),
    );
    return this.readIndex();
  }

  /** Frees the index `buildIndex` made last (after it was read, its memory is of no use here). */
  resetIndex() {
    this.ex.olgpu_index_reset();
  }

  /**
   * Loads a serialized index and returns its handle (0: not a valid index).
   * A Core holds any number of indexes: free each with `freeIndex`.
   */
  loadIndex(serialized: Float32Array): number {
    const handle = this.withInput(serialized, (p, l) => this.ex.olgpu_index_load(p, l));
    if (handle) {
      this.indexCount++;
    }
    return handle;
  }

  freeIndex(handle: number) {
    if (handle) {
      this.ex.olgpu_index_free(handle);
      this.indexCount--;
    }
  }

  /**
   * Raw hits within `radius` of (x, y), topmost first, as views on wasm
   * memory: `HIT_WORDS` words per hit (ref, kind, seq, and as f32 the distance
   * and where the query is: for a point (x, y) relative to it, for a line the
   * distance again, positive to the right of its direction). Valid until the
   * next call into this Core.
   * @param index handle from `loadIndex` (0: the index `buildIndex` made last)
   */
  queryIndexRaw(x: number, y: number, radius: number, index = 0): {count: number; words: Uint32Array; floats: Float32Array} {
    const count = this.ex.olgpu_index_query(index, x, y, radius);
    const ptr = this.ex.olgpu_out_ptr(3);
    const words = new Uint32Array(this.ex.memory.buffer, ptr, count * HIT_WORDS);
    const floats = new Float32Array(this.ex.memory.buffer, ptr, count * HIT_WORDS);
    return {count, words, floats};
  }

  /** Hits within `radius` of (x, y) in index space, topmost first. */
  queryIndex(x: number, y: number, radius: number, index = 0): IndexHit[] {
    const {count, words, floats} = this.queryIndexRaw(x, y, radius, index);
    const hits: IndexHit[] = new Array(count);
    for (let i = 0; i < count; i++) {
      hits[i] = {
        ref: words[i * HIT_WORDS],
        kind: words[i * HIT_WORDS + 1],
        seq: words[i * HIT_WORDS + 2],
        distance: floats[i * HIT_WORDS + 3],
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

/** Fetches (for a URL), compiles and instantiates a wasm module without imports. */
export async function instantiateWasm(source: WasmSource, what = 'wasm'): Promise<WebAssembly.Instance> {
  return WebAssembly.instantiate(await compileWasm(source, what), {});
}

/** Fetches (for a URL) and compiles a wasm module, for `loadCore` to make instances from. */
export async function compileWasm(source: WasmSource, what = 'wasm'): Promise<WebAssembly.Module> {
  if (source instanceof WebAssembly.Module) {
    return source;
  }
  if (source instanceof URL || typeof source === 'string') {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`ol-webgpu: could not load ${what} from ${source} (${response.status})`);
    }
    return WebAssembly.compile(await response.arrayBuffer());
  }
  return WebAssembly.compile(source);
}

export async function loadCore(source: WasmSource = defaultWasmUrl()): Promise<Core> {
  return new Core(await instantiateWasm(source));
}
