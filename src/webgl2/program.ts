/** Compiles and links a program; throws with the info log unless the context is lost. */
export function linkProgram(gl: WebGL2RenderingContext, vertexShader: string, fragmentShader: string): WebGLProgram {
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

/** Uploads a canvas to the bound texture with straight alpha and no flip, as ol uploads its text overlay. */
export function uploadCanvas(gl: WebGL2RenderingContext, canvas: TexImageSource) {
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}
