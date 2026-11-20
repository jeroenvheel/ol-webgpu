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
import type {GlyphAtlas} from '../text/atlas.js';
import {INSTANCE_FLOATS} from '../text/layout.js';
import {LABEL_UNIFORM_FLOATS, LABEL_WGSL, QUAD, writeLabelUniforms} from '../text/shaders.js';
import {type ShaderTranslator, type WgslProgram, loadShaderTranslator} from '../wasm/shader.js';
import {flushSubmits, frameEncoder, getDevice, onDeviceLost, preferredFormat} from '../webgpu/device.js';
import {surfaceType} from '../render/surface.js';
import {WebGPUSurface, compositePipeline} from '../webgpu/surface.js';
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
  /** Bind group of the last frame and the resources it was made from. */
  group: GPUBindGroup | null;
  groupResources: unknown[];
}

interface DrawCall {
  pipe: Pipeline;
  set: UploadedSet<GPUBuffers>;
  slot: number;
}

/** Glyph atlas texture, one per device (the atlas is shared by all layers). */
interface AtlasTexture {
  texture: GPUTexture;
  view: GPUTextureView;
  canvas: HTMLCanvasElement;
  version: number;
}
const atlasTextures = new WeakMap<GPUDevice, AtlasTexture>();

function atlasTexture(device: GPUDevice, atlas: GlyphAtlas): AtlasTexture {
  let entry = atlasTextures.get(device);
  const canvas = atlas.canvas;
  if (!entry || entry.canvas !== canvas) {
    if (entry) {
      flushSubmits();
      entry.texture.destroy();
    }
    const texture = device.createTexture({
      size: [canvas.width, canvas.height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      label: 'ol-webgpu glyph atlas',
    });
    entry = {texture, view: texture.createView(), canvas, version: -1};
    atlasTextures.set(device, entry);
  }
  if (entry.version !== atlas.version) {
    entry.version = atlas.version;
    device.queue.copyExternalImageToTexture({source: canvas}, {texture: entry.texture}, [canvas.width, canvas.height]);
  }
  return entry;
}

/** GPU resources for the labels of one layer. */
interface LabelResources {
  layout: GPUBindGroupLayout;
  pipeline: GPURenderPipeline;
  quad: GPUBuffer;
  uniforms: GPUBuffer | null;
  uniformData: Float32Array;
  slotSize: number;
  instances: GPUBuffer | null;
  /** Id of the label set in `instances`. */
  set: number;
  opacity: Map<number, {buffer: GPUBuffer; version: number; set: number}>;
  group: GPUBindGroup | null;
  groupResources: unknown[];
}

function vertexFormat(size: number): GPUVertexFormat {
  return (['float32', 'float32x2', 'float32x3', 'float32x4'] as const)[size - 1];
}

const GLSL_SIZE: Record<string, number> = {float: 1, vec2: 2, vec3: 3, vec4: 4};

export interface WebGPURendererOptions extends GpuVectorRendererOptions {
  /** URL of ol_gpu_shader.wasm, if not served next to the module. */
  shaderWasmUrl?: string | URL;
}

export default class WebGPUVectorRenderer extends BaseGpuVectorRenderer<GPUBuffers, WebGPUSurface> {
  private device: GPUDevice | null = null;
  private format: GPUTextureFormat = 'bgra8unorm';
  private translator: ShaderTranslator | null = null;
  private initializing: Promise<void> | null = null;
  private initError: unknown = null;
  private pipelines: Array<{fill?: Pipeline; stroke?: Pipeline; symbol?: Pipeline}> = [];
  /** Largest uniform block of the current pipelines. */
  private blockSize = 16;
  /**
   * Offscreen image of the layer, for layers composited onto the shared
   * canvas with an opacity below 1 or with labels (as ol does for every layer).
   */
  private offscreen: {
    texture: GPUTexture;
    view: GPUTextureView;
    msaa: {texture: GPUTexture; view: GPUTextureView} | null;
    uniforms: GPUBuffer;
    group: GPUBindGroup;
    opacity: number;
  } | null = null;
  /** Text compositing pipeline and the texture of the current text image. */
  private text: {
    layout: GPUBindGroupLayout;
    pipeline: GPURenderPipeline;
    uniforms: GPUBuffer;
    texture: GPUTexture | null;
    group: GPUBindGroup | null;
    version: number;
  } | null = null;
  private labels: LabelResources | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private uniformStaging = new ArrayBuffer(0);
  private uniformView = new DataView(this.uniformStaging);
  private zeroBuffer: GPUBuffer | null = null;
  private sampler: GPUSampler | null = null;
  private textures = new Map<string, {texture: GPUTexture; view: GPUTextureView; source: TexImageSource | null}>();
  private placeholder: {texture: GPUTexture; view: GPUTextureView} | null = null;
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
    this.offscreen = null;
    this.text = null;
    this.labels = null;
    this.uniformBuffer = null;
    this.zeroBuffer = null;
    this.sampler = null;
    this.textures.clear();
    this.placeholder = null;
  }

  protected surfaceType(): string {
    return surfaceType('webgpu', this.antialias, this.preserveDrawingBuffer);
  }

  protected createSurface(key: string, className: string): WebGPUSurface {
    return new WebGPUSurface(key, className, this.sampleCount, this.preserveDrawingBuffer);
  }

  protected surfaceChanged() {
    // GPU resources belong to the device, not the canvas: nothing to move
  }

  protected prepareBackend(): boolean {
    if (this.device && this.translator) {
      this.surface!.configure(this.device, this.format);
      return true;
    }
    if (this.initError) {
      return false;
    }
    // A layer in view waits for its device before the map reports rendercomplete.
    this.ready = false;
    this.initializing ??= (async () => {
      try {
        const [device, translator] = await Promise.all([
          getDevice(),
          loadShaderTranslator(this.shaderWasmUrl ?? undefined),
        ]);
        this.device = device;
        this.translator = translator;
        this.format = preferredFormat();
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
    this.blockSize = Math.max(16, ...this.pipelines.flatMap((p) => [p.fill, p.stroke, p.symbol]).map((x) => x?.program.uniformBlockSize ?? 0));
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
    return {pass, program, pipeline, layout, zeroSlots: zeros.length, group: null, groupResources: []};
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
    flushSubmits(); // the recorded frame may still use these buffers
    b.index?.destroy();
    b.vertex?.destroy();
    b.instance?.destroy();
  }

  private textureFor(name: string, source: unknown): GPUTextureView {
    const device = this.device!;
    if (!this.placeholder) {
      const texture = device.createTexture({size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
      this.placeholder = {texture, view: texture.createView()};
    }
    if (!isTextureSource(source)) {
      return this.placeholder.view;
    }
    const ready = !(source instanceof HTMLImageElement) || (source.complete && source.naturalWidth > 0);
    if (!ready) {
      return this.placeholder.view;
    }
    let entry = this.textures.get(name);
    if (entry && entry.source === source) {
      return entry.view;
    }
    if (entry) {
      flushSubmits();
      entry.texture.destroy();
    }
    const width = (source as any).naturalWidth || (source as any).width;
    const height = (source as any).naturalHeight || (source as any).height;
    const texture = device.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    // like gl.texImage2D without UNPACK_PREMULTIPLY_ALPHA: straight alpha, no flip
    device.queue.copyExternalImageToTexture({source: source as GPUImageCopyExternalImageSource}, {texture, premultipliedAlpha: false}, [width, height]);
    entry = {texture, view: texture.createView(), source};
    this.textures.set(name, entry);
    return entry.view;
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

  /** The pipeline's bind group, made again only when its uniform buffer or textures change. */
  private bindGroup(pipe: Pipeline, values: Map<string, ResolvedUniform>): GPUBindGroup {
    const resources: unknown[] = [this.uniformBuffer];
    pipe.program.samplers.forEach((name) => resources.push(this.textureFor(name, values.get(name))));
    if (pipe.group && resources.length === pipe.groupResources.length && resources.every((r, i) => r === pipe.groupResources[i])) {
      return pipe.group;
    }
    const entries: GPUBindGroupEntry[] = [{binding: 0, resource: {buffer: this.uniformBuffer!, offset: 0, size: this.blockSize}}];
    pipe.program.samplers.forEach((_name, k) => {
      entries.push({binding: 1 + 2 * k, resource: resources[1 + k] as GPUTextureView});
      entries.push({binding: 2 + 2 * k, resource: this.sampler!});
    });
    pipe.group = this.device!.createBindGroup({layout: pipe.layout, entries});
    pipe.groupResources = resources;
    return pipe.group;
  }

  protected draw(frameState: FrameState, worlds: number[], worldWidth: number, opacity: number): GPUCanvasContext {
    const device = this.device!;
    const surface = this.surface!;
    const context = surface.getContext()!;
    const width = surface.canvas.width;
    const height = surface.canvas.height;
    surface.record({redraw: () => this.draw(frameState, worlds, worldWidth, opacity)});

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

    const text = this.prepareText(frameState);
    const labels = this.prepareLabels(frameState);
    if (!calls.length && !text && !labels) {
      return context; // nothing to draw: the surface clears at the end of the frame if needed
    }

    // uniform buffer: aligned slots, written once per frame
    const align = device.limits.minUniformBufferOffsetAlignment;
    const slotSize = Math.ceil(this.blockSize / align) * align;
    const needed = Math.max(1, slotValues.length) * slotSize;
    if (!this.uniformBuffer || this.uniformBuffer.size < needed) {
      if (this.uniformBuffer) {
        flushSubmits();
        this.uniformBuffer.destroy();
      }
      this.uniformBuffer = device.createBuffer({size: Math.max(needed, 4 * slotSize), usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'ol-webgpu uniforms'});
      this.uniformStaging = new ArrayBuffer(this.uniformBuffer.size);
      this.uniformView = new DataView(this.uniformStaging);
    }
    slotValues.forEach((s, i) => this.pack(s.pipe.program, s.values, this.uniformView, i * slotSize));
    if (slotValues.length) {
      device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformStaging, 0, slotValues.length * slotSize);
    }

    // one bind group per pipeline (textures resolved from the first slot's values), kept across frames
    const groups = new Map<Pipeline, GPUBindGroup>();
    for (const s of slotValues) {
      if (!groups.has(s.pipe)) {
        groups.set(s.pipe, this.bindGroup(s.pipe, s.values));
      }
    }

    // Render passes go into the frame's shared encoder (see device.ts). With
    // full opacity and no labels the layer draws straight onto the shared
    // canvas (blending each feature over the canvas gives the same result as
    // compositing the layer image); otherwise into its own image first.
    const encoder = frameEncoder(device);
    const offscreen = opacity < 1 || text !== null ? this.offscreenTarget(width, height) : null;
    const pass = offscreen
      ? encoder.beginRenderPass({
          colorAttachments: [
            offscreen.msaa
              ? {view: offscreen.msaa.view, resolveTarget: offscreen.view, clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'discard'}
              : {view: offscreen.view, clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store'},
          ],
        })
      : surface.beginPass(encoder);
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
    if (labels) {
      const r = this.labels!;
      const count = this.labelFrame!.set.glyphCount;
      pass.setPipeline(r.pipeline);
      pass.setVertexBuffer(0, r.quad);
      pass.setVertexBuffer(1, r.instances!);
      labels.forEach((opacityBuffer, i) => {
        pass.setBindGroup(0, r.group!, [i * r.slotSize]);
        pass.setVertexBuffer(2, opacityBuffer);
        pass.draw(4, count);
      });
    }
    pass.end();
    if (offscreen) {
      if (offscreen.opacity !== opacity) {
        offscreen.opacity = opacity;
        device.queue.writeBuffer(offscreen.uniforms, 0, new Float32Array([opacity, 0, 0, 0]));
      }
      const composite = surface.beginPass(encoder);
      composite.setPipeline(compositePipeline(device, this.format, this.sampleCount).pipeline);
      composite.setBindGroup(0, offscreen.group);
      composite.draw(3);
      composite.end();
    }
    return context;
  }

  private offscreenTarget(width: number, height: number) {
    let o = this.offscreen;
    if (!o || o.texture.width !== width || o.texture.height !== height) {
      const device = this.device!;
      if (o) {
        flushSubmits();
        o.texture.destroy();
        o.msaa?.texture.destroy();
      }
      const texture = device.createTexture({
        size: [width, height],
        format: this.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        label: 'ol-webgpu layer image',
      });
      const view = texture.createView();
      let msaa = null;
      if (this.sampleCount > 1) {
        const t = device.createTexture({size: [width, height], sampleCount: this.sampleCount, format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT});
        msaa = {texture: t, view: t.createView()};
      }
      const uniforms = o?.uniforms ?? device.createBuffer({size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'ol-webgpu layer opacity'});
      const group = device.createBindGroup({
        layout: compositePipeline(device, this.format, this.sampleCount).layout,
        entries: [
          {binding: 0, resource: {buffer: uniforms}},
          {binding: 1, resource: view},
        ],
      });
      o = this.offscreen = {texture, view, msaa, uniforms, group, opacity: -1};
    }
    return o;
  }

  private labelResources(): LabelResources {
    if (this.labels) {
      return this.labels;
    }
    const device = this.device!;
    const module = device.createShaderModule({code: LABEL_WGSL, label: 'ol-webgpu labels'});
    const layout = device.createBindGroupLayout({
      entries: [
        {binding: 0, visibility: GPUShaderStage.VERTEX, buffer: {type: 'uniform', hasDynamicOffset: true}},
        {binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {sampleType: 'float'}},
        {binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {type: 'filtering'}},
      ],
    });
    const formats: GPUVertexFormat[] = ['float32x2', 'float32x2', 'float32x2', 'float32x2', 'float32x4', 'float32x4', 'float32x3'];
    let offset = 0;
    const attributes: GPUVertexAttribute[] = formats.map((format, i) => {
      const attribute = {shaderLocation: i + 1, offset, format};
      offset += format === 'float32x4' ? 16 : format === 'float32x3' ? 12 : 8;
      return attribute;
    });
    const buffers: GPUVertexBufferLayout[] = [
      {arrayStride: 8, stepMode: 'vertex', attributes: [{shaderLocation: 0, offset: 0, format: 'float32x2'}]},
      {arrayStride: INSTANCE_FLOATS * 4, stepMode: 'instance', attributes},
      {arrayStride: 4, stepMode: 'instance', attributes: [{shaderLocation: 8, offset: 0, format: 'float32'}]},
    ];
    const pipeline = device.createRenderPipeline({
        label: 'ol-webgpu labels',
        layout: device.createPipelineLayout({bindGroupLayouts: [layout]}),
        vertex: {module, entryPoint: 'vs', buffers},
        fragment: {
          module,
          entryPoint: 'fs',
          targets: [
            {
              format: this.format,
              blend: {
                color: {srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add'},
                alpha: {srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add'},
              },
            },
          ],
        },
        primitive: {topology: 'triangle-strip'},
        multisample: {count: this.sampleCount},
      });
    const quad = device.createBuffer({size: QUAD.byteLength, usage: GPUBufferUsage.VERTEX, mappedAtCreation: true, label: 'ol-webgpu label quad'});
    new Float32Array(quad.getMappedRange()).set(QUAD);
    quad.unmap();
    const align = device.limits.minUniformBufferOffsetAlignment;
    this.labels = {
      layout,
      pipeline,
      quad,
      uniforms: null,
      uniformData: new Float32Array(0),
      slotSize: Math.ceil((LABEL_UNIFORM_FLOATS * 4) / align) * align,
      instances: null,
      set: -1,
      opacity: new Map(),
      group: null,
      groupResources: [],
    };
    return this.labels;
  }

  /**
   * Uploads what changed of this frame's labels (see text/GpuText.ts) and
   * returns the opacity buffer per world copy to draw, or null without labels.
   */
  private prepareLabels(frameState: FrameState): GPUBuffer[] | null {
    const frame = this.labelFrame;
    if (!frame) {
      return null;
    }
    const device = this.device!;
    const r = this.labelResources();
    const {set, worlds} = frame;
    const atlas = atlasTexture(device, frame.atlas);
    if (r.set !== set.id || !r.instances) {
      if (r.instances) {
        flushSubmits();
        r.instances.destroy();
      }
      r.instances = device.createBuffer({size: set.instances.byteLength, usage: GPUBufferUsage.VERTEX, mappedAtCreation: true, label: 'ol-webgpu glyphs'});
      new Float32Array(r.instances.getMappedRange()).set(set.instances);
      r.instances.unmap();
      r.set = set.id;
    }
    const opacityBuffers: GPUBuffer[] = [];
    const used = new Set<number>();
    for (const w of worlds) {
      used.add(w.world);
      let o = r.opacity.get(w.world);
      if (!o || o.set !== set.id) {
        if (o) {
          flushSubmits();
          o.buffer.destroy();
        }
        o = {
          buffer: device.createBuffer({size: w.opacity.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST, label: 'ol-webgpu glyph opacity'}),
          version: -1,
          set: set.id,
        };
        r.opacity.set(w.world, o);
      }
      if (o.version !== w.version) {
        o.version = w.version;
        device.queue.writeBuffer(o.buffer, 0, w.opacity);
      }
      opacityBuffers.push(o.buffer);
    }
    for (const [world, o] of r.opacity) {
      if (!used.has(world)) {
        flushSubmits();
        o.buffer.destroy();
        r.opacity.delete(world);
      }
    }
    const floatsPerSlot = r.slotSize / 4;
    if (r.uniformData.length < worlds.length * floatsPerSlot) {
      r.uniformData = new Float32Array(worlds.length * floatsPerSlot);
    }
    if (!r.uniforms || r.uniforms.size < worlds.length * r.slotSize) {
      if (r.uniforms) {
        flushSubmits();
        r.uniforms.destroy();
      }
      r.uniforms = device.createBuffer({size: Math.max(4, worlds.length) * r.slotSize, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'ol-webgpu label uniforms'});
    }
    worlds.forEach((w, i) => {
      // the layer opacity is applied when the layer image is composited
      writeLabelUniforms(r.uniformData, i * floatsPerSlot, frameState, set, w.world * frame.worldWidth, atlas.canvas.width, atlas.canvas.height, 1);
    });
    device.queue.writeBuffer(r.uniforms, 0, r.uniformData, 0, worlds.length * floatsPerSlot);
    if (!r.group || r.groupResources[0] !== r.uniforms || r.groupResources[1] !== atlas.view) {
      r.group = device.createBindGroup({
        layout: r.layout,
        entries: [
          {binding: 0, resource: {buffer: r.uniforms, offset: 0, size: LABEL_UNIFORM_FLOATS * 4}},
          {binding: 1, resource: atlas.view},
          {binding: 2, resource: this.sampler!},
        ],
      });
      r.groupResources = [r.uniforms, atlas.view];
    }
    return opacityBuffers;
  }

  private destroyLabels() {
    const r = this.labels;
    if (r) {
      r.quad.destroy();
      r.uniforms?.destroy();
      r.instances?.destroy();
      r.opacity.forEach((o) => o.buffer.destroy());
    }
    this.labels = null;
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
        if (t.texture) {
          flushSubmits();
          t.texture.destroy();
        }
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

  override onPostCompose(frameState: FrameState | null | undefined) {
    super.onPostCompose(frameState);
    flushSubmits();
  }

  /** Export support: the shared canvas draws its last frame once more (see WebGPUSurface.redraw). */
  override onRenderComplete(frameState: FrameState | null | undefined) {
    this.surface?.redraw(frameState);
  }

  override disposeInternal() {
    flushSubmits();
    super.disposeInternal();
    this.unlistenLost();
    this.offscreen?.texture.destroy();
    this.offscreen?.msaa?.texture.destroy();
    this.offscreen?.uniforms.destroy();
    this.text?.texture?.destroy();
    this.text?.uniforms.destroy();
    this.destroyLabels();
    this.uniformBuffer?.destroy();
    this.zeroBuffer?.destroy();
    this.placeholder?.texture.destroy();
    this.textures.forEach((t) => t.texture.destroy());
    this.resetGpuState();
  }
}
