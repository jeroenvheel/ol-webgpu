/**
 * WebGL2 canvas and context shared by consecutive WebGL2 layers (see
 * render/surface.ts). Each layer keeps its programs and buffers in the
 * shared context; context loss and restore are passed on to all of them.
 */
import {Surface} from '../render/surface.js';

export interface WebGL2SurfaceUser {
  onContextLost(): void;
  onContextRestored(): void;
}

/** Composites a layer's offscreen image onto the canvas with the layer opacity. */
const COMPOSITE_GLSL = {
  vertex: `#version 300 es
precision highp float;
void main() {
  // one triangle covering the viewport
  vec2 p = vec2(float((gl_VertexID & 1) << 2) - 1.0, float((gl_VertexID & 2) << 1) - 1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`,
  fragment: `#version 300 es
precision mediump float;
uniform sampler2D u_image;
uniform float u_opacity;
out vec4 fragColor;
void main() {
  // premultiplied colour, so opacity scales all channels (like a CSS opacity)
  fragColor = texelFetch(u_image, ivec2(gl_FragCoord.xy), 0) * u_opacity;
}`,
};

export class WebGL2Surface extends Surface {
  readonly gl: WebGL2RenderingContext;
  readonly members = new Set<WebGL2SurfaceUser>();
  private composite: {program: WebGLProgram; image: WebGLUniformLocation; opacity: WebGLUniformLocation} | null = null;

  constructor(key: string, className: string, attributes: WebGLContextAttributes) {
    super(key, className);
    const gl = this.canvas.getContext('webgl2', attributes);
    if (!gl) {
      throw new Error('ol-webgpu: WebGL2 is not supported in this browser');
    }
    this.gl = gl;
    this.canvas.addEventListener('webglcontextlost', this.onLost);
    this.canvas.addEventListener('webglcontextrestored', this.onRestored);
  }

  private onLost = (e: Event) => {
    e.preventDefault();
    this.composite = null;
    this.members.forEach((u) => u.onContextLost());
  };

  private onRestored = () => {
    this.blank = true;
    this.members.forEach((u) => u.onContextRestored());
  };

  /** Binds the canvas for drawing over what earlier layers drew in this frame. */
  bind() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    if (this.takeClear()) {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }

  protected clear() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** Draws `texture` (a layer's offscreen image, canvas-sized) over the canvas with `opacity`. */
  compositeImage(texture: WebGLTexture, opacity: number) {
    const gl = this.gl;
    if (!this.composite) {
      const shader = (type: number, src: string) => {
        const s = gl.createShader(type)!;
        gl.shaderSource(s, src);
        gl.compileShader(s);
        return s;
      };
      const program = gl.createProgram()!;
      const vs = shader(gl.VERTEX_SHADER, COMPOSITE_GLSL.vertex);
      const fs = shader(gl.FRAGMENT_SHADER, COMPOSITE_GLSL.fragment);
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
        throw new Error(`ol-webgpu: composite program link failed: ${gl.getProgramInfoLog(program)}`);
      }
      this.composite = {program, image: gl.getUniformLocation(program, 'u_image')!, opacity: gl.getUniformLocation(program, 'u_opacity')!};
    }
    this.bind();
    const c = this.composite;
    gl.useProgram(c.program);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(c.image, 0);
    gl.uniform1f(c.opacity, opacity);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  protected override dispose() {
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    if (this.composite) {
      this.gl.deleteProgram(this.composite.program);
    }
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
