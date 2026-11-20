/**
 * WebGPU backend. ol's ShaderBuilder shaders are translated to WGSL with
 * naga (Rust → wasm, see crates/shader) and drawn with the same buffers,
 * uniforms and draw order as the WebGL2 backend.
 */
import type {FrameState} from 'ol/Map.js';
import type Layer from 'ol/layer/Layer.js';
import type VectorSource from 'ol/source/Vector.js';
import {create as createTransform} from 'ol/transform.js';
import {type AttributeDesc, type SubPass, stride} from '../render/stylePasses.js';
import {TEXT_OVERLAY_WGSL} from '../render/textOverlay.js';
import {type ResolvedUniform, isTextureSource} from '../render/uniforms.js';
import {type ShaderTranslator, type WgslProgram, loadShaderTranslator} from '../wasm/shader.js';
import {getDevice, onDeviceLost, preferredFormat} from '../webgpu/device.js';
import type {BufferSet} from '../worker/protocol.js';
import BaseGpuVectorRenderer, {type GpuVectorRendererOptions, type UploadedSet} from './BaseGpuVectorRenderer.js';


interface GPUBuffers {
  index: GPUBuffer | null;
  vertex: GPUBuffer | null;
  instance: GPUBuffer | null;
  indexCount: number;
  instanceFloats: number;
}

interface Pipeline {
  pass: SubPass;
  program: WgslProgram;
  pipeline: GPURenderPipeline;
  layout: GPUBindGroupLayout;
  /** Number of zero-filled attribute slots in vertex buffer 2. */
  zeroSlots: number;
}

interface DrawCall {
  pipe: Pipeline;
  set: UploadedSet<GPUBuffers>;
  slot: number;
}

function vertexFormat(size: number): GPUVertexFormat {
  return (['float32', 'float32x2', 'float32x3', 'float32x4'] as const)[size - 1];
}

const GLSL_SIZE: Record<string, number> = {float: 1, vec2: 2, vec3: 3, vec4: 4};

export interface WebGPURendererOptions extends GpuVectorRendererOptions {
  /** URL of ol_gpu_shader.wasm, if not served next to the module. */
  shaderWasmUrl?: string | URL;
}

export default class WebGPUVectorRenderer extends BaseGpuVectorRenderer<GPUBuffers> {
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private format: GPUTextureFormat = 'bgra8unorm';
  private translator: ShaderTranslator | null = null;
  private initializing: Promise<void> | null = null;
  private initError: unknown = null;
  private pipelines: Array<{fill?: Pipeline; stroke?: Pipeline; symbol?: Pipeline}> = [];
  private msaa: GPUTexture | null = null;
  /** Copy of the last frame (preserveDrawingBuffer), re-presented on rendercomplete. */
  private kept: GPUTexture | null = null;
  private keptFrameIndex = -1;
  /** Text compositing pipeline and the texture of the current text image. */
  private text: {
    layout: GPUBindGroupLayout;
    pipeline: GPURenderPipeline;
    uniforms: GPUBuffer;
    texture: GPUTexture | null;
    group: GPUBindGroup | null;
    version: number;
  } | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private uniformStaging = new ArrayBuffer(0);
  private zeroBuffer: GPUBuffer | null = null;
  private sampler: GPUSampler | null = null;
  private textures = new Map<string, {texture: GPUTexture; source: TexImageSource | null}>();
  private placeholder: GPUTexture | null = null;
  private readonly transform = createTransform();
  private readonly unlistenLost: () => void;
  private readonly shaderWasmUrl?: string | URL;
  /** 4x MSAA when antialiasing is on; 1 (like ol's offscreen framebuffer) otherwise. */
  private readonly sampleCount: number;
  /** Called once if the device or shader translator cannot be initialized. */
  onInitError: ((error: unknown) => void) | null = null;

  constructor(layer: Layer<VectorSource>, options: WebGPURendererOptions) {
    super(layer, options);
    this.shaderWasmUrl = options.shaderWasmUrl;
    this.sampleCount = options.antialias ? 4 : 1;
    this.unlistenLost = onDeviceLost(() => {
      this.device = null;
      this.initializing = null;
      this.resetGpuState();
      this.getLayer()?.changed();
    });
  }

  /** The WebGPU device (null until initialized). */
  getDevice(): GPUDevice | null {
    return this.device;
  }

  private resetGpuState() {
    this.pipelines = [];
    this.msaa = null;
    this.kept = null;
    this.keptFrameIndex = -1;
    this.text = null;
    this.uniformBuffer = null;
    this.zeroBuffer = null;
    this.sampler = null;
    this.textures.clear();
    this.placeholder = null;
  }

  protected prepareBackend(): boolean {
    if (this.device && this.translator && this.context) {
      return true;
    }
    if (this.initError) {
      return false;
    }
    this.initializing ??= (async () => {
      try {
        const [device, translator] = await Promise.all([
          getDevice(),
          loadShaderTranslator(this.shaderWasmUrl ?? undefined),
        ]);
        this.device = device;
        this.translator = translator;
        this.format = preferredFormat();
        this.context = this.canvas.getContext('webgpu');
        if (!this.context) {
          throw new Error('ol-webgpu: could not create a WebGPU canvas context');
        }
        this.context.configure({
          device,
          format: this.format,
          alphaMode: 'premultiplied',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | (this.preserveDrawingBuffer ? GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST : 0),
        });
        this.sampler = device.createSampler({minFilter: 'linear', magFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge'});
        this.zeroBuffer = device.createBuffer({size: 256, usage: GPUBufferUsage.VERTEX, label: 'ol-webgpu zeros'});
        this.applyPasses();
        this.reuploadBuffers();
        this.getLayer()?.changed();
      } catch (e) {
        this.initError = e;
        this.ready = true; // do not block rendercomplete
        this.framesSinceReady = Infinity;
        if (this.onInitError) {
          this.onInitError(e);
        } else {
          console.error(e);
        }
      }
    })();
    return false;
  }

  protected applyPasses() {
    if (!this.device || !this.translator) {
      return;
    }
    this.pipelines = this.passes.passes.map((pass) => ({
      fill: pass.fill && this.createPipeline(pass.fill),
      stroke: pass.stroke && this.createPipeline(pass.stroke),
      symbol: pass.symbol && this.createPipeline(pass.symbol),
    }));
  }

  private createPipeline(pass: SubPass): Pipeline {
    const device = this.device!;
    const program = this.translator!.translate(pass.vertexShader, pass.fragmentShader);
    const provided = new Set<string>();

    const layoutFor = (attrs: AttributeDesc[], stepMode: GPUVertexStepMode): GPUVertexBufferLayout => {
      const attributes: GPUVertexAttribute[] = [];
      let offset = 0;
      for (const a of attrs) {
        const loc = a.name ? program.attributes.get(a.name) : undefined;
        if (loc !== undefined && !provided.has(a.name!)) {
          provided.add(a.name!);
          attributes.push({shaderLocation: loc, offset, format: vertexFormat(a.size)});
        }
        offset += a.size * 4;
      }
      return {arrayStride: stride(attrs) * 4, stepMode, attributes};
    };
    const buffers: GPUVertexBufferLayout[] = [layoutFor(pass.attributes, 'vertex')];
    buffers.push(pass.instanced.length ? layoutFor(pass.instanced, 'instance') : {arrayStride: 0, stepMode: 'instance', attributes: []});

    // inputs declared by ol's shaders but absent from our buffers (e.g. a_hitColor) read zeros
    const zeros: GPUVertexAttribute[] = [];
    for (const [name, loc] of program.attributes) {
      if (!provided.has(name)) {
        const size = GLSL_SIZE[program.attributeTypes.get(name) ?? 'vec4'] ?? 4;
        zeros.push({shaderLocation: loc, offset: zeros.length * 16, format: vertexFormat(size)});
      }
    }
    buffers.push({arrayStride: 0, stepMode: 'instance', attributes: zeros});

    const entries: GPUBindGroupLayoutEntry[] = [
      {binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {type: 'uniform', hasDynamicOffset: true}},
    ];
    program.samplers.forEach((_s, k) => {
      entries.push({binding: 1 + 2 * k, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, texture: {sampleType: 'float'}});
      entries.push({binding: 2 + 2 * k, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, sampler: {type: 'filtering'}});
    });
    const layout = device.createBindGroupLayout({entries});
    const blend: GPUBlendState = {
      color: {srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add'},
      alpha: {srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add'},
    };
    const pipeline = device.createRenderPipeline({
      label: `ol-webgpu ${pass.kind}`,
      layout: device.createPipelineLayout({bindGroupLayouts: [layout]}),
      vertex: {module: device.createShaderModule({code: program.vertex, label: `ol-webgpu ${pass.kind} vs`}), entryPoint: 'main', buffers},
      fragment: {
        module: device.createShaderModule({code: program.fragment, label: `ol-webgpu ${pass.kind} fs`}),
        entryPoint: 'main',
        targets: [{format: this.format, blend}],
      },
      primitive: {topology: 'triangle-list', cullMode: 'none'},
      multisample: {count: this.sampleCount},
    });
    return {pass, program, pipeline, layout, zeroSlots: zeros.length};
  }

  protected upload(set: BufferSet): GPUBuffers {
    const device = this.device;
    if (!device) {
      // device not ready or lost: re-uploaded from the CPU copy later
      return {index: null, vertex: null, instance: null, indexCount: 0, instanceFloats: 0};
    }
    const make = (data: Uint32Array | Float32Array, usage: number) => {
      if (!data.byteLength) {
        return null;
      }
      const buffer = device.createBuffer({size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST, mappedAtCreation: true});
      const Ctor = data instanceof Uint32Array ? Uint32Array : Float32Array;
      new Ctor(buffer.getMappedRange()).set(data);
      buffer.unmap();
      return buffer;
    };
    return {
      index: make(set.indices, GPUBufferUsage.INDEX),
      vertex: make(set.vertices, GPUBufferUsage.VERTEX),
      instance: make(set.instances, GPUBufferUsage.VERTEX),
      indexCount: set.indices.length,
      instanceFloats: set.instances.length,
    };
  }

  protected release(b: GPUBuffers) {
    b.index?.destroy();
    b.vertex?.destroy();
    b.instance?.destroy();
  }

  private textureFor(name: string, source: unknown): GPUTexture {
    const device = this.device!;
    this.placeholder ??= device.createTexture({size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
    if (!isTextureSource(source)) {
      return this.placeholder;
    }
    const ready = !(source instanceof HTMLImageElement) || (source.complete && source.naturalWidth > 0);
    if (!ready) {
      return this.placeholder;
    }
    let entry = this.textures.get(name);
    if (entry && entry.source === source) {
      return entry.texture;
    }
    entry?.texture.destroy();
    const width = (source as any).naturalWidth || (source as any).width;
    const height = (source as any).naturalHeight || (source as any).height;
    const texture = device.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    // like gl.texImage2D without UNPACK_PREMULTIPLY_ALPHA: straight alpha, no flip
    device.queue.copyExternalImageToTexture({source: source as GPUImageCopyExternalImageSource}, {texture, premultipliedAlpha: false}, [width, height]);
    entry = {texture, source};
    this.textures.set(name, entry);
    return texture;
  }

  /** Writes uniform values into `view` at `base` following the program's std140 layout. */
  private pack(program: WgslProgram, values: Map<string, ResolvedUniform>, view: DataView, base: number) {
    for (const [name, member] of program.uniforms) {
      const v = values.get(name);
      if (v === undefined || isTextureSource(v)) {
        continue;
      }
      const at = base + member.offset;
      const t = member.type;
      if (t === 'i32' || t === 'u32' || t === 'bool') {
        view.setInt32(at, typeof v === 'number' ? v : (v as number[])[0], true);
      } else if (t === 'f32') {
        view.setFloat32(at, typeof v === 'number' ? v : (v as number[])[0], true);
      } else {
        const arr = typeof v === 'number' ? [v] : (v as ArrayLike<number>);
        const n = Math.min(arr.length, member.size / 4);
        for (let i = 0; i < n; i++) {
          view.setFloat32(at + i * 4, arr[i], true);
        }
      }
    }
  }

  private ensureMsaa(width: number, height: number) {
    if (!this.msaa || this.msaa.width !== width || this.msaa.height !== height) {
      this.msaa?.destroy();
      this.msaa = this.device!.createTexture({size: [width, height], sampleCount: this.sampleCount, format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT});
    }
    return this.msaa;
  }

  protected draw(frameState: FrameState, worlds: number[], worldWidth: number): GPUCanvasContext {
    const device = this.device!;
    const context = this.context!;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const msaa = this.sampleCount > 1 ? this.ensureMsaa(width, height) : null;

    // collect draw calls; one uniform slot per (world, program)
    const calls: DrawCall[] = [];
    const slotValues: Array<{pipe: Pipeline; values: Map<string, ResolvedUniform>}> = [];
    const b = this.buffers;
    if (b) {
      for (const world of worlds) {
        this.worldTransform(frameState, world, worldWidth, this.transform);
        const values = this.uniformState.compute(frameState, this.transform, b.invertVerticesTransform, height);
        for (const p of this.pipelines) {
          for (const [pipe, set] of [
            [p.fill, b.polygons],
            [p.stroke, b.lines],
            [p.symbol, b.points],
          ] as const) {
            if (pipe && set && set.gpu.indexCount > 0 && set.gpu.vertex && set.gpu.index) {
              calls.push({pipe, set, slot: slotValues.length});
              slotValues.push({pipe, values});
            }
          }
        }
      }
    }

    // uniform buffer: aligned slots, written once per frame
    const align = device.limits.minUniformBufferOffsetAlignment;
    const blockSize = Math.max(16, ...this.pipelines.flatMap((p) => [p.fill, p.stroke, p.symbol]).map((x) => x?.program.uniformBlockSize ?? 0));
    const slotSize = Math.ceil(blockSize / align) * align;
    const needed = Math.max(1, slotValues.length) * slotSize;
    if (!this.uniformBuffer || this.uniformBuffer.size < needed) {
      this.uniformBuffer?.destroy();
      this.uniformBuffer = device.createBuffer({size: Math.max(needed, 4 * slotSize), usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'ol-webgpu uniforms'});
      this.uniformStaging = new ArrayBuffer(this.uniformBuffer.size);
    }
    const view = new DataView(this.uniformStaging);
    slotValues.forEach((s, i) => this.pack(s.pipe.program, s.values, view, i * slotSize));
    if (slotValues.length) {
      device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformStaging, 0, slotValues.length * slotSize);
    }

    // one bind group per pipeline (textures resolved from the first slot's values)
    const groups = new Map<Pipeline, GPUBindGroup>();
    for (const s of slotValues) {
      if (groups.has(s.pipe)) {
        continue;
      }
      const entries: GPUBindGroupEntry[] = [{binding: 0, resource: {buffer: this.uniformBuffer, offset: 0, size: blockSize}}];
      s.pipe.program.samplers.forEach((name, k) => {
        entries.push({binding: 1 + 2 * k, resource: this.textureFor(name, s.values.get(name)).createView()});
        entries.push({binding: 2 + 2 * k, resource: this.sampler!});
      });
      groups.set(s.pipe, device.createBindGroup({layout: s.pipe.layout, entries}));
    }

    const encoder = device.createCommandEncoder({label: 'ol-webgpu frame'});
    const current = context.getCurrentTexture();
    const target = current.createView();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        msaa
          ? {view: msaa.createView(), resolveTarget: target, clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'discard'}
          : {view: target, clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store'},
      ],
    });
    const text = this.prepareText(frameState);
    for (const call of calls) {
      const g = call.set.gpu;
      pass.setPipeline(call.pipe.pipeline);
      pass.setBindGroup(0, groups.get(call.pipe)!, [call.slot * slotSize]);
      pass.setVertexBuffer(0, g.vertex!);
      if (g.instance && call.pipe.pass.instanced.length) {
        pass.setVertexBuffer(1, g.instance);
      } else {
        pass.setVertexBuffer(1, this.zeroBuffer!);
      }
      pass.setVertexBuffer(2, this.zeroBuffer!);
      pass.setIndexBuffer(g.index!, 'uint32');
      const instances = call.pipe.pass.instanced.length ? Math.floor(g.instanceFloats / stride(call.pipe.pass.instanced)) : 1;
      if (instances > 0) {
        pass.drawIndexed(g.indexCount, instances);
      }
    }
    if (text) {
      pass.setPipeline(text.pipeline);
      pass.setBindGroup(0, text.group);
      pass.draw(3);
    }
    pass.end();
    if (this.preserveDrawingBuffer) {
      // A presented WebGPU canvas reads back empty from a later task, so
      // keep a copy to re-present when the app may export (rendercomplete).
      if (!this.kept || this.kept.width !== width || this.kept.height !== height) {
        this.kept?.destroy();
        this.kept = device.createTexture({
          size: [width, height],
          format: this.format,
          usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
          label: 'ol-webgpu kept frame',
        });
      }
      encoder.copyTextureToTexture({texture: current}, {texture: this.kept}, [width, height]);
      this.keptFrameIndex = frameState.index;
    }
    device.queue.submit([encoder.finish()]);
    return context;
  }

  /**
   * Resources to composite the text image (ol's text post-process, see
   * render/textOverlay.ts) at the end of the frame's render pass.
   */
  private prepareText(frameState: FrameState): {pipeline: GPURenderPipeline; group: GPUBindGroup} | null {
    const text = this.textImage(frameState);
    if (!text) {
      return null;
    }
    const device = this.device!;
    if (!this.text) {
      const module = device.createShaderModule({code: TEXT_OVERLAY_WGSL, label: 'ol-webgpu text'});
      const layout = device.createBindGroupLayout({
        entries: [
          {binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: {type: 'uniform'}},
          {binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {sampleType: 'float'}},
          {binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {type: 'filtering'}},
        ],
      });
      this.text = {
        layout,
        pipeline: device.createRenderPipeline({
          label: 'ol-webgpu text',
          layout: device.createPipelineLayout({bindGroupLayouts: [layout]}),
          vertex: {module, entryPoint: 'vs'},
          fragment: {
            module,
            entryPoint: 'fs',
            targets: [
              {
                format: this.format,
                // colour: a * text + (1 - a) * layer; alpha: a * a + (1 - a) * layer.a (as ol)
                blend: {
                  color: {srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add'},
                  alpha: {srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add'},
                },
              },
            ],
          },
          primitive: {topology: 'triangle-list'},
          multisample: {count: this.sampleCount},
        }),
        uniforms: device.createBuffer({size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'ol-webgpu text matrix'}),
        texture: null,
        group: null,
        version: -1,
      };
    }
    const t = this.text;
    const canvas = text.image.canvas;
    if (t.version !== text.image.version || !t.texture || !t.group) {
      t.version = text.image.version;
      if (!t.texture || t.texture.width !== canvas.width || t.texture.height !== canvas.height) {
        t.texture?.destroy();
        t.texture = device.createTexture({
          size: [canvas.width, canvas.height],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
          label: 'ol-webgpu text image',
        });
        t.group = device.createBindGroup({
          layout: t.layout,
          entries: [
            {binding: 0, resource: {buffer: t.uniforms}},
            {binding: 1, resource: t.texture.createView()},
            {binding: 2, resource: this.sampler!},
          ],
        });
      }
      // straight alpha, no flip: like ol's texture upload of its overlay canvas
      device.queue.copyExternalImageToTexture({source: canvas}, {texture: t.texture, premultipliedAlpha: false}, [canvas.width, canvas.height]);
    }
    device.queue.writeBuffer(t.uniforms, 0, new Float32Array(text.matrix));
    return {pipeline: t.pipeline, group: t.group!};
  }

  override onRenderComplete(frameState: FrameState | null | undefined) {
    const kept = this.kept;
    const device = this.device;
    const context = this.context;
    if (!kept || !device || !context || !frameState || frameState.index !== this.keptFrameIndex) {
      return; // this layer was not drawn in that frame
    }
    const current = context.getCurrentTexture();
    if (current.width !== kept.width || current.height !== kept.height) {
      return;
    }
    const encoder = device.createCommandEncoder({label: 'ol-webgpu re-present'});
    encoder.copyTextureToTexture({texture: kept}, {texture: current}, [kept.width, kept.height]);
    device.queue.submit([encoder.finish()]);
  }

  override disposeInternal() {
    super.disposeInternal();
    this.unlistenLost();
    this.msaa?.destroy();
    this.kept?.destroy();
    this.text?.texture?.destroy();
    this.text?.uniforms.destroy();
    this.uniformBuffer?.destroy();
    this.zeroBuffer?.destroy();
    this.placeholder?.destroy();
    this.textures.forEach((t) => t.texture.destroy());
    this.context?.unconfigure();
    this.resetGpuState();
  }
}
