/**
 * WebGL2 backend. Runs ol's ShaderBuilder shaders unchanged (WebGL2 accepts
 * GLSL ES 1.00) with WebGL2-native vertex array objects, instancing and
 * 32-bit indices, on a canvas shared with the layers next to it.
 */
import type {FrameState} from 'ol/Map.js';
import type Layer from 'ol/layer/Layer.js';
import type VectorSource from 'ol/source/Vector.js';
import {create as createTransform} from 'ol/transform.js';
import {type AttributeDesc, type SubPass, stride} from '../render/stylePasses.js';
import {TEXT_OVERLAY_GLSL, type TextImage} from '../render/textOverlay.js';
import {type ResolvedUniform, isTextureSource} from '../render/uniforms.js';
import type {AtlasPage} from '../text/atlas.js';
import {INSTANCE_ATTRIBUTES, INSTANCE_FLOATS, type LabelSet} from '../text/layout.js';
import {LABEL_GLSL, LABEL_UNIFORMS, LABEL_UNIFORM_FLOATS, QUAD, writeLabelUniforms} from '../text/shaders.js';
import type {BufferSet} from '../worker/protocol.js';
import {linkProgram, uploadCanvas} from '../webgl2/program.js';
import {WebGL2Surface} from '../webgl2/surface.js';
import BaseGpuVectorRenderer, {type GpuVectorRendererOptions, type UploadedSet} from './BaseGpuVectorRenderer.js';

interface GLBuffers {
  index: WebGLBuffer;
  vertex: WebGLBuffer;
  instance: WebGLBuffer | null;
  indexCount: number;
  instanceFloats: number;
  /** Bytes allocated for the index, vertex and instance buffer. */
  capacity: [number, number, number];
  /** VAO per program, created lazily. */
  vaos: Map<WebGLProgram, WebGLVertexArrayObject>;
}

/**
 * Glyph atlas textures per context (the atlas is shared by all layers), one
 * per atlas page: after the atlas started over, the layers draw from the
 * page before until their labels are laid out again.
 */
interface AtlasTexture {
  texture: WebGLTexture;
  canvas: HTMLCanvasElement;
  version: number;
  /** When a layer last drew from it. */
  used: number;
}
const atlasTextures = new WeakMap<WebGL2RenderingContext, Map<AtlasPage, AtlasTexture>>();
/** Milliseconds after which the texture of a page no layer draws from is deleted. */
const ATLAS_TEXTURE_IDLE = 2000;

function bindAtlas(gl: WebGL2RenderingContext, page: AtlasPage, set: LabelSet) {
  let pages = atlasTextures.get(gl);
  if (!pages) {
    pages = new Map();
    atlasTextures.set(gl, pages);
  }
  const now = performance.now();
  for (const [other, texture] of pages) {
    if (other !== page && now - texture.used > ATLAS_TEXTURE_IDLE) {
      gl.deleteTexture(texture.texture);
      pages.delete(other);
    }
  }
  let entry = pages.get(page);
  if (!entry) {
    entry = {texture: gl.createTexture()!, canvas: page.canvas, version: -1, used: now};
    pages.set(page, entry);
  }
  entry.used = now;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, entry.texture);
  // cells drawn since for a layout in progress are uploaded when a set needs them
  if (entry.version < set.atlasVersion || entry.canvas !== page.canvas) {
    entry.version = page.version;
    entry.canvas = page.canvas;
    uploadCanvas(gl, page.canvas);
  }
}

/** Deletes the atlas textures of a context whose last layer is leaving. */
function dropAtlasTexture(surface: WebGL2Surface | null) {
  const pages = surface && surface.users <= 1 ? atlasTextures.get(surface.gl) : null;
  if (surface && pages) {
    pages.forEach((entry) => surface.gl.deleteTexture(entry.texture));
    atlasTextures.delete(surface.gl);
  }
}

/** GL resources for the labels of one layer. */
interface LabelResources {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
  quad: WebGLBuffer;
  instances: WebGLBuffer | null;
  /** Id of the label set in `instances`. */
  set: number;
  opacity: Map<number, {buffer: WebGLBuffer; vao: WebGLVertexArrayObject; version: number; set: number}>;
}

interface UniformInfo {
  location: WebGLUniformLocation;
  type: number;
  unit?: number;
}

interface Program {
  pass: SubPass;
  program: WebGLProgram;
  uniforms: Map<string, UniformInfo>;
}

export default class WebGL2VectorRenderer extends BaseGpuVectorRenderer<GLBuffers, WebGL2Surface> {
  private gl: WebGL2RenderingContext | null = null;
  private programs: Array<{fill?: Program; edge?: Program; stroke?: Program; symbol?: Program}> = [];
  private textures = new Map<string, {texture: WebGLTexture; source: TexImageSource | null}>();
  private labels: LabelResources | null = null;
  private readonly labelUniforms = new Float32Array(LABEL_UNIFORM_FLOATS);
  private contextLost = false;
  private readonly transform = createTransform();
  /** Text compositing program and the texture of the current text image. */
  private text: {program: WebGLProgram; texture: WebGLTexture; version: number; sampler: WebGLUniformLocation; matrix: WebGLUniformLocation} | null = null;
  /**
   * Offscreen image of the layer, for layers composited onto the shared
   * canvas with an opacity below 1 or with a text image (as ol does for
   * every layer); multisampled into a renderbuffer first when antialiasing.
   */
  private offscreen: {
    width: number;
    height: number;
    texture: WebGLTexture;
    framebuffer: WebGLFramebuffer;
    msaa: {renderbuffer: WebGLRenderbuffer; framebuffer: WebGLFramebuffer} | null;
  } | null = null;

  constructor(layer: Layer<VectorSource>, options: GpuVectorRendererOptions) {
    super(layer, options, 'webgl2');
  }

  /** @internal Called by the shared surface. */
  onContextLost() {
    this.contextLost = true;
    if (this.gl) {
      atlasTextures.delete(this.gl); // gone with the context: uploaded again after it is restored
    }
  }

  /** @internal Called by the shared surface. */
  onContextRestored() {
    this.contextLost = false;
    this.forgetGLResources();
    this.applyPasses();
    this.reuploadBuffers();
    this.getLayer()?.changed();
  }

  /** Drops references to resources of a lost or replaced context. */
  private forgetGLResources() {
    this.programs = [];
    this.textures.clear();
    this.text = null;
    this.labels = null;
    this.offscreen = null;
  }

  /** Deletes this layer's resources from its context (other layers keep using the context). */
  private deleteGLResources() {
    const gl = this.gl;
    if (!gl) {
      return;
    }
    this.deletePrograms();
    this.textures.forEach((t) => gl.deleteTexture(t.texture));
    if (this.text) {
      gl.deleteProgram(this.text.program);
      gl.deleteTexture(this.text.texture);
    }
    if (this.labels) {
      const r = this.labels;
      gl.deleteProgram(r.program);
      gl.deleteBuffer(r.quad);
      gl.deleteBuffer(r.instances);
      r.opacity.forEach((o) => {
        gl.deleteBuffer(o.buffer);
        gl.deleteVertexArray(o.vao);
      });
    }
    this.deleteOffscreen();
    this.forgetGLResources();
  }

  private deleteOffscreen() {
    const gl = this.gl;
    const o = this.offscreen;
    if (gl && o) {
      gl.deleteTexture(o.texture);
      gl.deleteFramebuffer(o.framebuffer);
      if (o.msaa) {
        gl.deleteRenderbuffer(o.msaa.renderbuffer);
        gl.deleteFramebuffer(o.msaa.framebuffer);
      }
    }
    this.offscreen = null;
  }

  protected createSurface(key: string, className: string): WebGL2Surface {
    return new WebGL2Surface(key, className, {
      alpha: true,
      premultipliedAlpha: true,
      antialias: this.antialias,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: this.preserveDrawingBuffer,
    });
  }

  protected surfaceChanged(previous: WebGL2Surface | null) {
    if (previous) {
      // move to the new context: free everything in the old one, upload again below
      this.releaseBuffers();
      this.deleteGLResources();
      dropAtlasTexture(previous);
      previous.members.delete(this);
    }
    const surface = this.surface!;
    surface.members.add(this);
    this.gl = surface.gl;
    this.contextLost = surface.gl.isContextLost();
    this.applyPasses();
    this.reuploadBuffers();
  }

  /** The WebGL2 context (null before the first frame). */
  getGL(): WebGL2RenderingContext | null {
    return this.gl;
  }

  protected prepareBackend(): boolean {
    return !!this.gl && !this.contextLost;
  }

  protected applyPasses() {
    const gl = this.gl;
    if (!gl) {
      return;
    }
    this.deletePrograms();
    this.programs = this.passes.passes.map((pass) => ({
      fill: pass.fill && this.compile(pass.fill),
      edge: pass.edge && this.compile(pass.edge),
      stroke: pass.stroke && this.compile(pass.stroke),
      symbol: pass.symbol && this.compile(pass.symbol),
    }));
  }

  private deletePrograms() {
    const gl = this.gl!;
    for (const p of this.programs) {
      for (const prog of [p.fill, p.edge, p.stroke, p.symbol]) {
        if (prog) {
          gl.deleteProgram(prog.program);
        }
      }
    }
    this.programs = [];
  }

  private compile(pass: SubPass): Program {
    const gl = this.gl!;
    const program = linkProgram(gl, pass.vertexShader, pass.fragmentShader);
    const uniforms = new Map<string, UniformInfo>();
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
    let unit = 0;
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i)!;
      const name = info.name.replace(/\[0\]$/, '');
      const location = gl.getUniformLocation(program, info.name)!;
      uniforms.set(name, {location, type: info.type, unit: info.type === gl.SAMPLER_2D ? unit++ : undefined});
    }
    return {pass, program, uniforms};
  }

  protected upload(set: BufferSet, reuse?: GLBuffers): GLBuffers {
    const gl = this.gl!;
    const capacity: [number, number, number] = [0, 0, 0];
    // writes `data` into the buffer on hand when it fits (and is not much too large), into new storage otherwise
    const fill = (slot: number, target: number, data: ArrayBufferView, buffer: WebGLBuffer | null): WebGLBuffer => {
      const size = data.byteLength;
      const had = buffer && reuse ? reuse.capacity[slot] : 0;
      buffer ??= gl.createBuffer()!;
      gl.bindBuffer(target, buffer);
      if (size <= had && size * 2 >= had) {
        gl.bufferSubData(target, 0, data);
        capacity[slot] = had;
      } else {
        gl.bufferData(target, data, gl.STATIC_DRAW);
        capacity[slot] = size;
      }
      return buffer;
    };
    gl.bindVertexArray(null);
    const instanced = set.instances.length > 0;
    let vaos = reuse?.vaos ?? new Map<WebGLProgram, WebGLVertexArrayObject>();
    if (reuse && !!reuse.instance !== instanced) {
      // the vertex arrays were made for other buffers
      vaos.forEach((vao) => gl.deleteVertexArray(vao));
      vaos = new Map();
      gl.deleteBuffer(reuse.instance);
      reuse.instance = null;
    }
    return {
      index: fill(0, gl.ELEMENT_ARRAY_BUFFER, set.indices, reuse?.index ?? null),
      vertex: fill(1, gl.ARRAY_BUFFER, set.vertices, reuse?.vertex ?? null),
      instance: instanced ? fill(2, gl.ARRAY_BUFFER, set.instances, reuse?.instance ?? null) : null,
      indexCount: set.indices.length,
      instanceFloats: set.instances.length,
      capacity,
      vaos,
    };
  }

  protected release(b: GLBuffers) {
    const gl = this.gl;
    if (!gl) {
      return;
    }
    // the vertex arrays first: a buffer lives on while one still refers to it
    gl.bindVertexArray(null);
    b.vaos.forEach((vao) => gl.deleteVertexArray(vao));
    b.vaos.clear();
    // Emptied before they are deleted: the driver gives the storage of a
    // deleted buffer back late, and with large layers the memory of several
    // rebuilds would pile up in the GPU process.
    const free = (target: number, buffer: WebGLBuffer | null) => {
      if (buffer) {
        gl.bindBuffer(target, buffer);
        gl.bufferData(target, 0, gl.STATIC_DRAW);
        gl.deleteBuffer(buffer);
      }
    };
    free(gl.ELEMENT_ARRAY_BUFFER, b.index);
    free(gl.ARRAY_BUFFER, b.vertex);
    free(gl.ARRAY_BUFFER, b.instance);
  }

  private vao(prog: Program, b: GLBuffers): WebGLVertexArrayObject {
    let vao = b.vaos.get(prog.program);
    if (vao) {
      return vao;
    }
    const gl = this.gl!;
    vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const bind = (buffer: WebGLBuffer, attrs: AttributeDesc[], divisor: number) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      const bytes = stride(attrs) * 4;
      let offset = 0;
      for (const a of attrs) {
        const loc = a.name ? gl.getAttribLocation(prog.program, a.name) : -1;
        if (loc >= 0) {
          gl.enableVertexAttribArray(loc);
          gl.vertexAttribPointer(loc, a.size, gl.FLOAT, false, bytes, offset);
          gl.vertexAttribDivisor(loc, divisor);
        }
        offset += a.size * 4;
      }
    };
    bind(b.vertex, prog.pass.attributes, 0);
    if (b.instance && prog.pass.instanced.length) {
      bind(b.instance, prog.pass.instanced, 1);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.index);
    gl.bindVertexArray(null);
    b.vaos.set(prog.program, vao);
    return vao;
  }

  private texture(name: string, unit: number, source: TexImageSource) {
    const gl = this.gl!;
    let entry = this.textures.get(name);
    if (!entry) {
      entry = {texture: gl.createTexture()!, source: null};
      this.textures.set(name, entry);
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, entry.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    const ready = !(source instanceof HTMLImageElement) || (source.complete && source.naturalWidth > 0);
    if (ready && entry.source !== source) {
      entry.source = source;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }
  }

  private setUniforms(prog: Program, values: Map<string, ResolvedUniform>) {
    const gl = this.gl!;
    for (const [name, info] of prog.uniforms) {
      const v = values.get(name);
      if (v === undefined) {
        continue;
      }
      const loc = info.location;
      switch (info.type) {
        case gl.FLOAT:
          gl.uniform1f(loc, typeof v === 'number' ? v : (v as number[])[0]);
          break;
        case gl.FLOAT_VEC2:
          gl.uniform2fv(loc, v as number[]);
          break;
        case gl.FLOAT_VEC3:
          gl.uniform3fv(loc, v as number[]);
          break;
        case gl.FLOAT_VEC4:
          gl.uniform4fv(loc, v as number[]);
          break;
        case gl.FLOAT_MAT4:
          gl.uniformMatrix4fv(loc, false, v as Float32Array);
          break;
        case gl.INT:
        case gl.BOOL:
          gl.uniform1i(loc, typeof v === 'number' ? v : (v as number[])[0]);
          break;
        case gl.SAMPLER_2D:
          if (isTextureSource(v)) {
            this.texture(name, info.unit!, v);
            gl.uniform1i(loc, info.unit!);
          }
          break;
        default:
          if (typeof v === 'number') {
            gl.uniform1f(loc, v);
          }
      }
    }
  }

  private drawSet(prog: Program | undefined, set: UploadedSet<GLBuffers> | null, values: Map<string, ResolvedUniform>) {
    if (!prog || !set || set.gpu.indexCount === 0) {
      return;
    }
    const gl = this.gl!;
    const b = set.gpu;
    gl.useProgram(prog.program);
    this.setUniforms(prog, values);
    gl.bindVertexArray(this.vao(prog, b));
    if (prog.pass.instanced.length) {
      const instances = b.instanceFloats / stride(prog.pass.instanced);
      if (instances > 0) {
        gl.drawElementsInstanced(gl.TRIANGLES, b.indexCount, gl.UNSIGNED_INT, 0, instances);
      }
    } else {
      gl.drawElements(gl.TRIANGLES, b.indexCount, gl.UNSIGNED_INT, 0);
    }
  }

  protected draw(frameState: FrameState, worlds: number[], worldWidth: number, opacity: number): WebGL2RenderingContext {
    const gl = this.gl!;
    const surface = this.surface!;
    const {width, height} = surface.canvas;
    const text = this.textImage(frameState);
    const labels = this.labelFrame;
    const plan = this.framePlan(opacity, !!text);
    if (!plan) {
      return gl;
    }
    const offscreen = plan.offscreen ? this.offscreenTarget(width, height) : null;
    if (offscreen) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, offscreen.msaa?.framebuffer ?? offscreen.framebuffer);
      gl.viewport(0, 0, width, height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    } else {
      surface.bind();
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);

    if (plan.draws.length) {
      const invert = this.buffers!.invertVerticesTransform;
      for (const world of worlds) {
        this.worldTransform(frameState, world, worldWidth, this.transform);
        const values = this.uniformState.compute(frameState, this.transform, invert, height);
        for (const p of this.programs) {
          for (const {kind, set} of plan.draws) {
            this.drawSet(p[kind], set, values);
          }
        }
      }
    }
    gl.bindVertexArray(null);
    if (text) {
      this.drawText(text);
    }
    if (labels) {
      this.drawLabels(frameState);
    }
    if (offscreen) {
      if (offscreen.msaa) {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, offscreen.msaa.framebuffer);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, offscreen.framebuffer);
        gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      }
      surface.compositeImage(offscreen.texture, opacity);
    }
    return gl;
  }

  private offscreenTarget(width: number, height: number) {
    let o = this.offscreen;
    if (o && o.width === width && o.height === height) {
      return o;
    }
    this.deleteOffscreen();
    const gl = this.gl!;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const framebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    let msaa = null;
    if (this.antialias) {
      const renderbuffer = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(gl.RENDERBUFFER, renderbuffer);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, Math.min(4, gl.getParameter(gl.MAX_SAMPLES)), gl.RGBA8, width, height);
      const msaaFramebuffer = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, msaaFramebuffer);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, renderbuffer);
      msaa = {renderbuffer, framebuffer: msaaFramebuffer};
    }
    o = this.offscreen = {width, height, texture, framebuffer, msaa};
    return o;
  }

  /** Draws this frame's labels (see text/GpuText.ts), uploading what changed. */
  private drawLabels(frameState: FrameState) {
    const gl = this.gl!;
    const frame = this.labelFrame!;
    const {set, worlds} = frame;
    if (!this.labels) {
      const program = linkProgram(gl, LABEL_GLSL.vertex, LABEL_GLSL.fragment);
      const uniforms: Record<string, WebGLUniformLocation | null> = {};
      for (const name of [...LABEL_UNIFORMS.map((u) => u[0]), 'u_atlas']) {
        uniforms[name] = gl.getUniformLocation(program, name);
      }
      const quad = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
      this.labels = {program, uniforms, quad, instances: null, set: -1, opacity: new Map()};
    }
    const r = this.labels;
    gl.bindVertexArray(null);
    if (r.set !== set.id || !r.instances) {
      r.instances ??= gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, r.instances);
      gl.bufferData(gl.ARRAY_BUFFER, set.instances, gl.STATIC_DRAW);
      r.set = set.id;
    }
    gl.useProgram(r.program);
    bindAtlas(gl, frame.page, set);
    gl.uniform1i(r.uniforms.u_atlas, 0);
    const u = this.labelUniforms;
    const used = new Set<number>();
    for (const w of worlds) {
      used.add(w.world);
      let o = r.opacity.get(w.world);
      if (!o) {
        const buffer = gl.createBuffer()!;
        const vao = gl.createVertexArray()!;
        gl.bindVertexArray(vao);
        const attribute = (location: number, size: number, stride: number, offset: number, divisor: number) => {
          gl.enableVertexAttribArray(location);
          gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
          gl.vertexAttribDivisor(location, divisor);
        };
        gl.bindBuffer(gl.ARRAY_BUFFER, r.quad);
        attribute(0, 2, 8, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, r.instances);
        let offset = 0;
        INSTANCE_ATTRIBUTES.forEach((size, i) => {
          attribute(i + 1, size, INSTANCE_FLOATS * 4, offset, 1);
          offset += size * 4;
        });
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        attribute(INSTANCE_ATTRIBUTES.length + 1, 1, 4, 0, 1);
        gl.bindVertexArray(null);
        o = {buffer, vao, version: -1, set: -1};
        r.opacity.set(w.world, o);
      }
      if (o.version !== w.version || o.set !== set.id) {
        o.version = w.version;
        o.set = set.id;
        gl.bindBuffer(gl.ARRAY_BUFFER, o.buffer);
        gl.bufferData(gl.ARRAY_BUFFER, w.opacity, gl.DYNAMIC_DRAW);
      }
      writeLabelUniforms(u, 0, frameState, set, w.world * frame.worldWidth, frame.page.canvas.width, frame.page.canvas.height);
      let at = 0;
      for (const [name, size] of LABEL_UNIFORMS) {
        const location = r.uniforms[name];
        if (size === 4) {
          gl.uniform4f(location, u[at], u[at + 1], u[at + 2], u[at + 3]);
        } else if (size === 2) {
          gl.uniform2f(location, u[at], u[at + 1]);
        } else {
          gl.uniform1f(location, u[at]);
        }
        at += size;
      }
      gl.bindVertexArray(o.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, set.glyphCount);
    }
    gl.bindVertexArray(null);
    for (const [world, o] of r.opacity) {
      if (!used.has(world)) {
        gl.deleteBuffer(o.buffer);
        gl.deleteVertexArray(o.vao);
        r.opacity.delete(world);
      }
    }
  }

  /** Composites the text image over the layer, like ol's text post-process. */
  private drawText(text: {image: TextImage; matrix: Float32Array | number[]}) {
    const gl = this.gl!;
    if (!this.text) {
      const program = linkProgram(gl, TEXT_OVERLAY_GLSL.vertex, TEXT_OVERLAY_GLSL.fragment);
      this.text = {
        program,
        texture: gl.createTexture()!,
        version: -1,
        sampler: gl.getUniformLocation(program, 'u_textOverlay')!,
        matrix: gl.getUniformLocation(program, 'u_textOverlayMatrix')!,
      };
    }
    const t = this.text;
    gl.useProgram(t.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t.texture);
    if (t.version !== text.image.version) {
      t.version = text.image.version;
      uploadCanvas(gl, text.image.canvas);
    }
    gl.uniform1i(t.sampler, 0);
    gl.uniformMatrix4fv(t.matrix, false, text.matrix);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  override disposeInternal() {
    this.deleteGLResources();
    dropAtlasTexture(this.surface);
    this.surface?.members.delete(this);
    super.disposeInternal(); // releases the buffers, then the shared surface
    this.gl = null;
  }

}
