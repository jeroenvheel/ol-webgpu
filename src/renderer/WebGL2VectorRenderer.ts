/**
 * WebGL2 backend. Runs ol's ShaderBuilder shaders unchanged (WebGL2 accepts
 * GLSL ES 1.00) with WebGL2-native vertex array objects, instancing and
 * 32-bit indices, on its own canvas.
 */
import type {FrameState} from 'ol/Map.js';
import type Layer from 'ol/layer/Layer.js';
import type VectorSource from 'ol/source/Vector.js';
import {create as createTransform} from 'ol/transform.js';
import {type AttributeDesc, type SubPass, stride} from '../render/stylePasses.js';
import {TEXT_OVERLAY_GLSL, type TextImage} from '../render/textOverlay.js';
import {type ResolvedUniform, isTextureSource} from '../render/uniforms.js';
import type {GlyphAtlas} from '../text/atlas.js';
import {INSTANCE_FLOATS} from '../text/layout.js';
import {LABEL_GLSL, LABEL_UNIFORM_FLOATS, QUAD, writeLabelUniforms} from '../text/shaders.js';
import type {BufferSet} from '../worker/protocol.js';
import {surfaceType} from '../render/surface.js';
import {WebGL2Surface} from '../webgl2/surface.js';
import BaseGpuVectorRenderer, {type GpuVectorRendererOptions, type UploadedSet} from './BaseGpuVectorRenderer.js';

interface GLBuffers {
  index: WebGLBuffer;
  vertex: WebGLBuffer;
  instance: WebGLBuffer | null;
  indexCount: number;
  instanceFloats: number;
  /** VAO per program, created lazily. */
  vaos: Map<WebGLProgram, WebGLVertexArrayObject>;
}

/** Glyph atlas texture, one per context (the atlas is shared by all layers). */
const atlasTextures = new WeakMap<WebGL2RenderingContext, {texture: WebGLTexture; canvas: HTMLCanvasElement; version: number}>();

function bindAtlas(gl: WebGL2RenderingContext, atlas: GlyphAtlas) {
  let entry = atlasTextures.get(gl);
  if (!entry) {
    entry = {texture: gl.createTexture()!, canvas: atlas.canvas, version: -1};
    atlasTextures.set(gl, entry);
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, entry.texture);
  if (entry.version !== atlas.version || entry.canvas !== atlas.canvas) {
    entry.version = atlas.version;
    entry.canvas = atlas.canvas;
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas.canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
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
  private programs: Array<{fill?: Program; stroke?: Program; symbol?: Program}> = [];
  private textures = new Map<string, {texture: WebGLTexture; source: TexImageSource | null}>();
  private labels: LabelResources | null = null;
  private readonly labelUniforms = new Float32Array(LABEL_UNIFORM_FLOATS);
  private contextLost = false;
  private readonly transform = createTransform();
  /** Text compositing program and the texture of the current text image. */
  private text: {program: WebGLProgram; texture: WebGLTexture; version: number; sampler: WebGLUniformLocation; matrix: WebGLUniformLocation} | null = null;
  /**
   * Offscreen image of the layer, for layers composited onto the shared
   * canvas with an opacity below 1 or with labels (as ol does for every
   * layer); multisampled into a renderbuffer first when antialiasing.
   */
  private offscreen: {
    width: number;
    height: number;
    texture: WebGLTexture;
    framebuffer: WebGLFramebuffer;
    msaa: {renderbuffer: WebGLRenderbuffer; framebuffer: WebGLFramebuffer} | null;
  } | null = null;

  constructor(layer: Layer<VectorSource>, options: GpuVectorRendererOptions) {
    super(layer, options);
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
    this.programs.forEach((p) => [p.fill, p.stroke, p.symbol].forEach((x) => x && gl.deleteProgram(x.program)));
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

  protected surfaceType(): string {
    return surfaceType('webgl2', this.antialias, this.preserveDrawingBuffer);
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
      const b = this.buffers;
      for (const set of b ? [b.polygons, b.lines, b.points] : []) {
        if (set) {
          this.release(set.gpu);
        }
      }
      this.deleteGLResources();
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
    for (const p of this.programs) {
      for (const prog of [p.fill, p.stroke, p.symbol]) {
        if (prog) {
          gl.deleteProgram(prog.program);
        }
      }
    }
    this.programs = this.passes.passes.map((pass) => ({
      fill: pass.fill && this.compile(pass.fill),
      stroke: pass.stroke && this.compile(pass.stroke),
      symbol: pass.symbol && this.compile(pass.symbol),
    }));
  }

  private link(vertexShader: string, fragmentShader: string): WebGLProgram {
    const gl = this.gl!;
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
        throw new Error(`ol-webgpu: ${type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'} shader compilation failed: ${gl.getShaderInfoLog(s)}`);
      }
      return s;
    };
    const vs = shader(gl.VERTEX_SHADER, vertexShader);
    const fs = shader(gl.FRAGMENT_SHADER, fragmentShader);
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new Error(`ol-webgpu: program link failed: ${gl.getProgramInfoLog(program)}`);
    }
    return program;
  }

  private compile(pass: SubPass): Program {
    const gl = this.gl!;
    const program = this.link(pass.vertexShader, pass.fragmentShader);
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

  protected upload(set: BufferSet): GLBuffers {
    const gl = this.gl!;
    const make = (target: number, data: ArrayBufferView) => {
      const b = gl.createBuffer()!;
      gl.bindBuffer(target, b);
      gl.bufferData(target, data, gl.STATIC_DRAW);
      return b;
    };
    gl.bindVertexArray(null);
    return {
      index: make(gl.ELEMENT_ARRAY_BUFFER, set.indices),
      vertex: make(gl.ARRAY_BUFFER, set.vertices),
      instance: set.instances.length ? make(gl.ARRAY_BUFFER, set.instances) : null,
      indexCount: set.indices.length,
      instanceFloats: set.instances.length,
      vaos: new Map(),
    };
  }

  protected release(b: GLBuffers) {
    const gl = this.gl;
    if (!gl) {
      return;
    }
    gl.deleteBuffer(b.index);
    gl.deleteBuffer(b.vertex);
    if (b.instance) {
      gl.deleteBuffer(b.instance);
    }
    b.vaos.forEach((vao) => gl.deleteVertexArray(vao));
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
    }
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const ready = !(source instanceof HTMLImageElement) || source.complete;
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
    const b = this.buffers;
    const text = this.textImage(frameState);
    const labels = this.labelFrame;
    if (!text && !labels && !(b && [b.polygons, b.lines, b.points].some((set) => set && set.gpu.indexCount > 0))) {
      return gl; // nothing to draw: the surface clears at the end of the frame if needed
    }

    // With full opacity and no labels the layer draws straight onto the
    // shared canvas (blending each feature over the canvas gives the same
    // result as compositing the layer image); otherwise into its own image.
    const offscreen = opacity < 1 || text ? this.offscreenTarget(width, height) : null;
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

    if (b) {
      for (const world of worlds) {
        this.worldTransform(frameState, world, worldWidth, this.transform);
        const values = this.uniformState.compute(frameState, this.transform, b.invertVerticesTransform, height);
        for (const p of this.programs) {
          this.drawSet(p.fill, b.polygons, values);
          this.drawSet(p.stroke, b.lines, values);
          this.drawSet(p.symbol, b.points, values);
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
      const program = this.link(LABEL_GLSL.vertex, LABEL_GLSL.fragment);
      const uniforms: Record<string, WebGLUniformLocation | null> = {};
      for (const name of ['u_matrix', 'u_translate', 'u_viewport', 'u_atlasSize', 'u_rotation', 'u_opacity', 'u_pixelRatio', 'u_pass', 'u_atlas']) {
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
    bindAtlas(gl, frame.atlas);
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
        [2, 2, 2, 2, 4, 4, 4, 2].forEach((size, i) => {
          attribute(i + 1, size, INSTANCE_FLOATS * 4, offset, 1);
          offset += size * 4;
        });
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        attribute(9, 1, 4, 0, 1);
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
      // the layer opacity is applied when the layer image is composited
      writeLabelUniforms(u, 0, frameState, set, w.world * frame.worldWidth, frame.atlas.canvas.width, frame.atlas.canvas.height, 1);
      gl.uniform4f(r.uniforms.u_matrix, u[0], u[1], u[2], u[3]);
      gl.uniform2f(r.uniforms.u_translate, u[4], u[5]);
      gl.uniform2f(r.uniforms.u_viewport, u[6], u[7]);
      gl.uniform2f(r.uniforms.u_atlasSize, u[8], u[9]);
      gl.uniform1f(r.uniforms.u_rotation, u[10]);
      gl.uniform1f(r.uniforms.u_opacity, u[11]);
      gl.uniform1f(r.uniforms.u_pixelRatio, u[12]);
      gl.bindVertexArray(o.vao);
      // all halos, then all fills: a halo never covers a neighbouring letter
      gl.uniform1i(r.uniforms.u_pass, 0);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, set.glyphCount);
      gl.uniform1i(r.uniforms.u_pass, 1);
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
      const program = this.link(TEXT_OVERLAY_GLSL.vertex, TEXT_OVERLAY_GLSL.fragment);
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
      // straight alpha, no flip: like ol's texture upload of its overlay canvas
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, text.image.canvas);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    gl.uniform1i(t.sampler, 0);
    gl.uniformMatrix4fv(t.matrix, false, text.matrix);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  override disposeInternal() {
    this.deleteGLResources();
    this.surface?.members.delete(this);
    super.disposeInternal(); // releases the buffers, then the shared surface
    this.gl = null;
  }

}
