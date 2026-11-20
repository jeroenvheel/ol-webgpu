/**
 * Wrapper around the ol_gpu_shader wasm module (naga GLSL -> WGSL).
 */
import {toVulkanGlsl, type VulkanShaders} from '../style/glsl.js';
import type {WasmSource} from './core.js';

interface ShaderExports {
  memory: WebAssembly.Memory;
  olgpu_shader_alloc(len: number): number;
  olgpu_shader_free(ptr: number, len: number): void;
  olgpu_shader_translate(ptr: number, len: number, stage: number): void;
  olgpu_shader_out_ptr(): number;
  olgpu_shader_out_len(): number;
}

export interface UniformMember {
  name: string;
  offset: number;
  size: number;
  type: string;
}

interface StageResult {
  ok: boolean;
  error?: string;
  wgsl: string;
  uniformBlockSize: number;
  uniforms: UniformMember[];
  inputs: Array<{name: string; location: number}>;
}

export interface WgslProgram {
  vertex: string;
  fragment: string;
  /** Size in bytes of the shared uniform block (binding 0). */
  uniformBlockSize: number;
  uniforms: Map<string, UniformMember>;
  /** Attribute name → location, for every vertex input the WGSL entry point declares. */
  attributes: Map<string, number>;
  attributeTypes: Map<string, string>;
  samplers: string[];
}

export class ShaderTranslationError extends Error {
  constructor(
    message: string,
    readonly source: string,
  ) {
    super(message);
    this.name = 'ShaderTranslationError';
  }
}

const DIAGNOSTICS = 'diagnostic(off, derivative_uniformity);\n';

export class ShaderTranslator {
  private readonly ex: ShaderExports;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();
  private readonly cache = new Map<string, WgslProgram>();

  constructor(instance: WebAssembly.Instance) {
    this.ex = instance.exports as unknown as ShaderExports;
  }

  private stage(src: string, stage: 0 | 1): StageResult {
    const bytes = this.encoder.encode(src);
    const ptr = this.ex.olgpu_shader_alloc(bytes.length);
    new Uint8Array(this.ex.memory.buffer, ptr, bytes.length).set(bytes);
    try {
      this.ex.olgpu_shader_translate(ptr, bytes.length, stage);
    } finally {
      this.ex.olgpu_shader_free(ptr, bytes.length);
    }
    const out = new Uint8Array(this.ex.memory.buffer, this.ex.olgpu_shader_out_ptr(), this.ex.olgpu_shader_out_len());
    const result = JSON.parse(this.decoder.decode(out)) as StageResult;
    if (!result.ok) {
      throw new ShaderTranslationError(`ol-gpu: ${stage ? 'fragment' : 'vertex'} shader ${result.error}`, src);
    }
    return result;
  }

  /** Translates an ol GLSL ES 1.00 shader pair to WGSL (cached by source). */
  translate(vertexGlsl: string, fragmentGlsl: string): WgslProgram {
    const key = vertexGlsl + '\u0000' + fragmentGlsl;
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }
    const vk: VulkanShaders = toVulkanGlsl(vertexGlsl, fragmentGlsl);
    const v = this.stage(vk.vertex, 0);
    const f = this.stage(vk.fragment, 1);
    const program: WgslProgram = {
      vertex: DIAGNOSTICS + v.wgsl,
      fragment: DIAGNOSTICS + f.wgsl,
      uniformBlockSize: v.uniformBlockSize,
      uniforms: new Map(v.uniforms.map((u) => [u.name, u])),
      attributes: new Map(v.inputs.map((i) => [i.name, i.location])),
      attributeTypes: vk.attributeTypes,
      samplers: vk.samplers,
    };
    this.cache.set(key, program);
    return program;
  }
}

/** See `defaultWasmUrl` in core.ts for `?no-inline`. */
export function defaultShaderWasmUrl(): URL {
  return new URL('./ol_gpu_shader.wasm?no-inline', import.meta.url);
}

let shared: Promise<ShaderTranslator> | null = null;

export function loadShaderTranslator(source: WasmSource = defaultShaderWasmUrl()): Promise<ShaderTranslator> {
  const load = async () => {
    let module: WebAssembly.Module;
    if (source instanceof WebAssembly.Module) {
      module = source;
    } else if (source instanceof URL || typeof source === 'string') {
      const response = await fetch(source);
      if (!response.ok) {
        throw new Error(`ol-gpu: could not load shader wasm from ${source} (${response.status})`);
      }
      module = await WebAssembly.compile(await response.arrayBuffer());
    } else {
      module = await WebAssembly.compile(source);
    }
    return new ShaderTranslator(await WebAssembly.instantiate(module, {}));
  };
  if (source === undefined || (source instanceof URL && source.href === defaultShaderWasmUrl().href)) {
    shared ??= load();
    return shared;
  }
  return load();
}
