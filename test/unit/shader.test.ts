/**
 * Every shader ol's ShaderBuilder generates for the flat styles below must
 * translate to valid WGSL through naga.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {convertStyleToShaders} from 'ol/render/webgl/VectorStyleRenderer.js';
import {beforeAll, describe, expect, it} from 'vitest';
import {toVulkanGlsl} from '../../src/style/glsl.js';
import {type ShaderTranslator, loadShaderTranslator} from '../../src/wasm/shader.js';
import {root} from './helpers.js';

let translator: ShaderTranslator;
beforeAll(async () => {
  translator = await loadShaderTranslator(readFileSync(join(root, 'src', 'wasm', 'ol_gpu_shader.wasm')));
});

/** Styles exercising each ShaderBuilder feature (no textures: those need a DOM). */
export const styles: Record<string, any> = {
  'fill': {'fill-color': '#ff000080'},
  'fill match': {'fill-color': ['match', ['get', 'kind'], 0, '#1b9e77aa', 1, '#d95f02aa', '#e7298aaa']},
  'fill interpolate zoom': {'fill-color': ['interpolate', ['linear'], ['zoom'], 2, '#ff0000', 10, '#0000ff']},
  'stroke': {'stroke-color': '#0000ff', 'stroke-width': 3},
  'stroke data-driven': {'stroke-color': ['get', 'color'], 'stroke-width': ['get', 'width']},
  'stroke joins caps': {'stroke-color': '#000', 'stroke-width': 8, 'stroke-line-join': 'bevel', 'stroke-line-cap': 'square', 'stroke-miter-limit': 4},
  'stroke dash': {'stroke-color': '#000', 'stroke-width': 2, 'stroke-line-dash': [4, 8, 2, 8], 'stroke-line-dash-offset': 3},
  'stroke offset': {'stroke-color': '#000', 'stroke-width': 2, 'stroke-offset': ['*', ['var', 'k'], 4]},
  'stroke line metric': {'stroke-color': ['interpolate', ['linear'], ['line-metric'], 0, '#f00', 100, '#00f'], 'stroke-width': 4},
  'circle': {'circle-radius': 6, 'circle-fill-color': '#ff0000', 'circle-stroke-color': '#000000', 'circle-stroke-width': 1},
  'circle data-driven': {'circle-radius': ['get', 'size'], 'circle-fill-color': ['get', 'color'], 'circle-rotate-with-view': true, 'circle-displacement': [2, 3], 'circle-scale': [1, 2]},
  'shape': {'shape-points': 5, 'shape-radius': 10, 'shape-radius2': 4, 'shape-angle': 0.3, 'shape-fill-color': '#00ff00', 'shape-stroke-color': '#000000', 'shape-stroke-width': 2, 'shape-rotation': ['*', ['time'], 0.1]},
  'filter + variables': {'filter': ['>', ['get', 'pop'], ['var', 'minPop']], 'fill-color': ['case', ['==', ['get', 'type'], 'a'], '#ff0000', '#00ff00'], 'stroke-color': '#000', 'stroke-width': 1, 'circle-radius': 3, 'circle-fill-color': '#000000'},
  'math operators': {'circle-radius': ['clamp', ['+', ['*', ['get', 'a'], 2], ['/', ['%', ['get', 'b'], 3], 2], ['^', 2, ['abs', ['get', 'c']]], ['sin', ['get', 'd']], ['atan', ['get', 'e'], 1], ['floor', ['round', ['ceil', ['sqrt', ['get', 'f']]]]]], 1, 20], 'circle-fill-color': ['color', ['get', 'r'], 128, 0, 0.5]},
  'logic operators': {'filter': ['all', ['any', ['!', ['has', 'x']], ['between', ['get', 'y'], 1, 5], ['in', ['get', 'z'], [1, 2, 3]]], ['<=', ['resolution'], 1000], ['!=', ['id'], 4], ['==', ['geometry-type'], 'Polygon']], 'fill-color': '#123456'},
};

describe('ol shaders -> WGSL', () => {
  for (const [name, style] of Object.entries(styles)) {
    it(name, () => {
      const shaders = convertStyleToShaders(style, {k: 1, minPop: 0});
      let count = 0;
      for (const s of shaders) {
        const b = s.builder;
        for (const [v, f] of [
          [b.getFillVertexShader(), b.getFillFragmentShader()],
          [b.getStrokeVertexShader(), b.getStrokeFragmentShader()],
          [b.getSymbolVertexShader(), b.getSymbolFragmentShader()],
        ]) {
          if (!v || !f) {
            continue;
          }
          const program = translator.translate(v, f);
          expect(program.vertex).toContain('@vertex');
          expect(program.fragment).toContain('@fragment');
          // every attribute declared in GLSL has a location
          for (const [, loc] of program.attributes) {
            expect(program.vertex).toContain(`@location(${loc})`);
          }
          expect(program.uniforms.get('u_projectionMatrix')?.type).toBe('mat4x4');
          expect(program.uniforms.has('u_ol_fbHeight')).toBe(true);
          count++;
        }
      }
      expect(count).toBeGreaterThan(0);
    });
  }

  it('keeps GLSL mod() semantics for negative values', () => {
    const vk = toVulkanGlsl(
      'attribute vec2 a_p;\nvarying float v_m;\nvoid main(void) { v_m = mod(a_p.x, 3.0); gl_Position = vec4(a_p, 0.0, 1.0); }',
      'varying float v_m;\nvoid main(void) { gl_FragColor = vec4(v_m); }',
    );
    expect(vk.vertex).toContain('layout(location = 0) in vec2 a_p;');
    const program = translator.translate(
      'attribute vec2 a_p;\nvarying float v_m;\nvoid main(void) { v_m = mod(a_p.x, 3.0); gl_Position = vec4(a_p, 0.0, 1.0); }',
      'varying float v_m;\nvoid main(void) { gl_FragColor = vec4(v_m); }',
    );
    // naga lowers GLSL mod to x - y * floor(x / y), never to WGSL's truncating %
    expect(program.vertex).toMatch(/floor/);
  });

  it('splits sampler parameters and uniforms', () => {
    const vk = toVulkanGlsl(
      'attribute vec2 a_p;\nvarying vec2 v_uv;\nvoid main(void) { v_uv = a_p; gl_Position = vec4(a_p, 0.0, 1.0); }',
      `uniform sampler2D u_texture0;
varying vec2 v_uv;
vec4 sample(sampler2D texture, vec2 uv) { return texture2D(texture, uv); }
void main(void) { gl_FragColor = sample(u_texture0, v_uv) + texture2D(u_texture0, v_uv); }`,
    );
    expect(vk.samplers).toEqual(['u_texture0']);
    expect(vk.fragment).toContain('sample(u_texture0_t, u_texture0_s, v_uv)');
    expect(vk.fragment).toContain('texture2D texture_t, sampler texture_s');
    const program = translator.translate(
      'attribute vec2 a_p;\nvarying vec2 v_uv;\nvoid main(void) { v_uv = a_p; gl_Position = vec4(a_p, 0.0, 1.0); }',
      `uniform sampler2D u_texture0;
varying vec2 v_uv;
vec4 sample(sampler2D texture, vec2 uv) { return texture2D(texture, uv); }
void main(void) { gl_FragColor = sample(u_texture0, v_uv) + texture2D(u_texture0, v_uv); }`,
    );
    expect(program.fragment).toContain('textureSampleLevel');
  });
});
