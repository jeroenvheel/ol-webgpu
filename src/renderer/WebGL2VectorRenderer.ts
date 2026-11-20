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
import {TEXT_OVERLAY_GLSL} from '../render/textOverlay.js';
import {type ResolvedUniform, isTextureSource} from '../render/uniforms.js';
import type {BufferSet} from '../worker/protocol.js';
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

export default class WebGL2VectorRenderer extends BaseGpuVectorRenderer<GLBuffers> {
  private gl: WebGL2RenderingContext | null = null;
  private programs: Array<{fill?: Program; stroke?: Program; symbol?: Program}> = [];
  private textures = new Map<string, {texture: WebGLTexture; source: TexImageSource | null}>();
  private contextLost = false;
  private readonly transform = createTransform();
  /** Text compositing program and the texture of the current text image. */
  private text: {program: WebGLProgram; texture: WebGLTexture; version: number; sampler: WebGLUniformLocation; matrix: WebGLUniformLocation} | null = null;

  constructor(layer: Layer<VectorSource>, options: GpuVectorRendererOptions) {
    super(layer, options);
    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored);
  }

  private onContextLost = (e: Event) => {
    e.preventDefault();
    this.contextLost = true;
  };

  private onContextRestored = () => {
    this.contextLost = false;
    this.programs = [];
    this.textures.clear();
    this.text = null;
    this.applyPasses();
    this.reuploadBuffers();
    this.getLayer()?.changed();
  };

  /** The WebGL2 context (null before the first frame). */
  getGL(): WebGL2RenderingContext | null {
    return this.gl;
  }

  protected prepareBackend(): boolean {
    if (this.contextLost) {
      return false;
    }
    if (!this.gl) {
      const gl = this.canvas.getContext('webgl2', {
        alpha: true,
        premultipliedAlpha: true,
        antialias: this.antialias,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: this.preserveDrawingBuffer,
      });
      if (!gl) {
        throw new Error('ol-gpu: WebGL2 is not supported in this browser');
      }
      this.gl = gl;
      this.applyPasses();
    }
    return true;
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
        throw new Error(`ol-gpu: ${type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'} shader compilation failed: ${gl.getShaderInfoLog(s)}`);
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
      throw new Error(`ol-gpu: program link failed: ${gl.getProgramInfoLog(program)}`);
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

  protected draw(frameState: FrameState, worlds: number[], worldWidth: number): WebGL2RenderingContext {
    const gl = this.gl!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);

    const b = this.buffers;
    if (b) {
      for (const world of worlds) {
        this.worldTransform(frameState, world, worldWidth, this.transform);
        const values = this.uniformState.compute(frameState, this.transform, b.invertVerticesTransform, this.canvas.height);
        for (const p of this.programs) {
          this.drawSet(p.fill, b.polygons, values);
          this.drawSet(p.stroke, b.lines, values);
          this.drawSet(p.symbol, b.points, values);
        }
      }
    }
    gl.bindVertexArray(null);
    this.drawText(frameState);
    return gl;
  }

  /** Composites the text image over the layer, like ol's text post-process. */
  private drawText(frameState: FrameState) {
    const text = this.textImage(frameState);
    if (!text) {
      return;
    }
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
    super.disposeInternal();
    const gl = this.gl;
    if (gl) {
      this.programs.forEach((p) => [p.fill, p.stroke, p.symbol].forEach((x) => x && gl.deleteProgram(x.program)));
      this.textures.forEach((t) => gl.deleteTexture(t.texture));
      if (this.text) {
        gl.deleteProgram(this.text.program);
        gl.deleteTexture(this.text.texture);
      }
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    this.gl = null;
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
  }
}
