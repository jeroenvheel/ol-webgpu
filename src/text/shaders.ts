/**
 * Shaders and uniforms for GPU text, the same maths for both backends. A
 * glyph is an instanced quad: its anchor is projected to the screen, the
 * quad is placed around it in CSS pixels, and the atlas cell gives the
 * coverage (red: halo, green: fill). Background rectangles are quads too,
 * with their edges anti-aliased in the fragment shader. Instances are drawn
 * in order, see `INSTANCE_FLOATS` in layout.ts.
 */
import type {FrameState} from 'ol/Map.js';
import {create as createTransform} from 'ol/transform.js';
import {makeProjectionTransform} from '../render/uniforms.js';
import type {LabelSet} from './layout.js';

/** The uniforms and their sizes, in the order `writeLabelUniforms` writes them. */
export const LABEL_UNIFORMS: ReadonlyArray<readonly [string, number]> = [
  ['u_matrix', 4],
  ['u_translate', 2],
  ['u_viewport', 2],
  ['u_atlasSize', 2],
  ['u_rotation', 1],
  ['u_pixelRatio', 1],
];
/** Floats of the uniform block (48 bytes). */
export const LABEL_UNIFORM_FLOATS = 12;

const projection = createTransform();

/**
 * Uniforms for one world copy: matrix (4), translate (2), viewport in CSS
 * pixels (2), atlas size (2), view rotation, pixel ratio. The layer
 * opacity is not in here: it is applied when the layer image is composited.
 * The anchors are relative to the set's origin; the origin is projected
 * here with double precision, so labels stay exact at any zoom.
 */
export function writeLabelUniforms(
  out: Float32Array,
  at: number,
  frameState: FrameState,
  set: LabelSet,
  worldOffset: number,
  atlasWidth: number,
  atlasHeight: number,
) {
  const p = makeProjectionTransform(frameState, projection);
  const x = set.origin[0] + worldOffset;
  const y = set.origin[1];
  out[at] = p[0];
  out[at + 1] = p[1];
  out[at + 2] = p[2];
  out[at + 3] = p[3];
  out[at + 4] = p[0] * x + p[2] * y + p[4];
  out[at + 5] = p[1] * x + p[3] * y + p[5];
  out[at + 6] = frameState.size[0];
  out[at + 7] = frameState.size[1];
  out[at + 8] = atlasWidth;
  out[at + 9] = atlasHeight;
  out[at + 10] = frameState.viewState.rotation;
  out[at + 11] = frameState.pixelRatio;
}

/** Corners of the unit quad, as a triangle strip. */
export const QUAD = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);

export const LABEL_GLSL = {
  vertex: `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec2 a_anchor;
layout(location = 2) in vec2 a_partOffset;
layout(location = 3) in vec2 a_offset;
layout(location = 4) in vec2 a_size;
layout(location = 5) in vec4 a_cell;
layout(location = 6) in vec4 a_color;
layout(location = 7) in vec3 a_angle;
layout(location = 8) in float a_opacity;
uniform vec4 u_matrix;
uniform vec2 u_translate;
uniform vec2 u_viewport;
uniform vec2 u_atlasSize;
uniform float u_rotation;
uniform float u_pixelRatio;
out vec4 v_color;
out vec2 v_texCoord;
out float v_channel;
// for a rectangle: position in it and its size, device pixels
out vec4 v_rect;

vec2 rotate(vec2 v, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return vec2(c * v.x - s * v.y, s * v.x + c * v.y);
}

void main() {
  float alpha = a_color.a * a_opacity;
  v_channel = a_angle.z;
  if (alpha <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    v_color = vec4(0.0);
    v_texCoord = vec2(0.0);
    v_rect = vec4(0.0);
    return;
  }
  vec2 local = a_corner * a_size;
  if (a_angle.z > 1.5) {
    // a pixel more on each side, for the anti-aliased edge
    local = a_corner * (a_size + 2.0) - 1.0;
  }
  v_rect = vec4(local, a_size) * u_pixelRatio;
  vec2 clip = vec2(u_matrix.x * a_anchor.x + u_matrix.z * a_anchor.y, u_matrix.y * a_anchor.x + u_matrix.w * a_anchor.y) + u_translate;
  // CSS pixels, y down
  vec2 px = vec2(clip.x * 0.5 + 0.5, 0.5 - clip.y * 0.5) * u_viewport;
  float view = a_angle.y * u_rotation;
  // the part: a chunk of a label along a line, or the corner of a label image
  px += rotate(a_partOffset, view);
  if (view + a_angle.x == 0.0) {
    // whole device pixels keep upright text sharp
    px = floor(px * u_pixelRatio + 0.5) / u_pixelRatio;
  }
  px += rotate(local + a_offset, view + a_angle.x);
  gl_Position = vec4(px.x / u_viewport.x * 2.0 - 1.0, 1.0 - px.y / u_viewport.y * 2.0, 0.0, 1.0);
  v_color = vec4(a_color.rgb * alpha, alpha);
  v_texCoord = (a_cell.xy + a_corner * a_cell.zw) / u_atlasSize;
}`,
  fragment: `#version 300 es
precision mediump float;
uniform sampler2D u_atlas;
in vec4 v_color;
in vec2 v_texCoord;
in float v_channel;
in vec4 v_rect;
out vec4 fragColor;
void main() {
  vec4 cell = texture(u_atlas, v_texCoord);
  float coverage = v_channel < 0.5 ? cell.r : cell.g;
  if (v_channel > 1.5) {
    // the part of the pixel inside the rectangle
    vec2 inside = clamp(v_rect.xy + 0.5, 0.0, 1.0) - clamp(v_rect.xy - v_rect.zw + 0.5, 0.0, 1.0);
    coverage = inside.x * inside.y;
  }
  if (coverage < 0.004) {
    discard;
  }
  fragColor = v_color * coverage;
}`,
};

export const LABEL_WGSL = `
struct Uniforms {
  matrix: vec4<f32>,
  translate: vec2<f32>,
  viewport: vec2<f32>,
  atlasSize: vec2<f32>,
  rotation: f32,
  pixelRatio: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var atlas: texture_2d<f32>;
@group(0) @binding(2) var atlasSampler: sampler;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) texCoord: vec2<f32>,
  @location(2) channel: f32,
  // for a rectangle: position in it and its size, device pixels
  @location(3) rect: vec4<f32>,
};

fn rotate(v: vec2<f32>, angle: f32) -> vec2<f32> {
  let c = cos(angle);
  let s = sin(angle);
  return vec2<f32>(c * v.x - s * v.y, s * v.x + c * v.y);
}

@vertex
fn vs(
  @location(0) corner: vec2<f32>,
  @location(1) anchor: vec2<f32>,
  @location(2) partOffset: vec2<f32>,
  @location(3) offset: vec2<f32>,
  @location(4) size: vec2<f32>,
  @location(5) cell: vec4<f32>,
  @location(6) color: vec4<f32>,
  @location(7) angle: vec3<f32>,
  @location(8) opacity: f32,
) -> VertexOut {
  var out: VertexOut;
  let alpha = color.a * opacity;
  out.channel = angle.z;
  if (alpha <= 0.0) {
    out.position = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    return out;
  }
  let clip = vec2<f32>(u.matrix.x * anchor.x + u.matrix.z * anchor.y, u.matrix.y * anchor.x + u.matrix.w * anchor.y) + u.translate;
  var local = corner * size;
  if (angle.z > 1.5) {
    // a pixel more on each side, for the anti-aliased edge
    local = corner * (size + 2.0) - 1.0;
  }
  out.rect = vec4<f32>(local, size) * u.pixelRatio;
  // CSS pixels, y down
  var px = vec2<f32>(clip.x * 0.5 + 0.5, 0.5 - clip.y * 0.5) * u.viewport;
  let view = angle.y * u.rotation;
  // the part: a chunk of a label along a line, or the corner of a label image
  px = px + rotate(partOffset, view);
  if (view + angle.x == 0.0) {
    // whole device pixels keep upright text sharp
    px = floor(px * u.pixelRatio + 0.5) / u.pixelRatio;
  }
  px = px + rotate(local + offset, view + angle.x);
  out.position = vec4<f32>(px.x / u.viewport.x * 2.0 - 1.0, 1.0 - px.y / u.viewport.y * 2.0, 0.0, 1.0);
  out.color = vec4<f32>(color.rgb, 1.0) * alpha;
  out.texCoord = (cell.xy + corner * cell.zw) / u.atlasSize;
  return out;
}

@fragment
fn fs(in: VertexOut) -> @location(0) vec4<f32> {
  let cell = textureSampleLevel(atlas, atlasSampler, in.texCoord, 0.0);
  var coverage = select(cell.g, cell.r, in.channel < 0.5);
  if (in.channel > 1.5) {
    // the part of the pixel inside the rectangle
    let inside = clamp(in.rect.xy + 0.5, vec2<f32>(0.0), vec2<f32>(1.0)) - clamp(in.rect.xy - in.rect.zw + 0.5, vec2<f32>(0.0), vec2<f32>(1.0));
    coverage = inside.x * inside.y;
  }
  if (coverage < 0.004) {
    discard;
  }
  return in.color * coverage;
}
`;
