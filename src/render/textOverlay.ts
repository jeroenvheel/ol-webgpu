/**
 * Text (`text-*` styles), rendered exactly like ol's WebGLVector (ol 10.11):
 * ol's own text overlay worker (`ol/worker/textOverlay.js`) turns the render
 * instructions into Canvas 2D text batches and, after each frame, draws them
 * into an ImageBitmap for that frame state. The renderer composites that
 * image over the layer with ol's post-process maths (`overlayMatrix` and the
 * blend in the backends), mapped from the frame it was drawn for to the
 * current view so labels follow the map while a new image is on its way.
 *
 * Notes on the worker (behaviour of ol's, kept as is):
 * - it draws at `frameState.size` (CSS pixels, no pixelRatio) and for one
 *   world only;
 * - it can only use fonts registered inside the worker (`self.fonts`), so
 *   web fonts from the page's `@font-face` are not available;
 * - a RENDER request replaces a pending one, which then never answers: the
 *   client resolves the replaced request with null.
 */
import type {FrameState} from 'ol/Map.js';
import type {FlatStyleLike} from 'ol/style/flat.js';
import {TextOverlayWorkerMessageType} from 'ol/render/webgl/constants.js';
import {serializeFrameState} from 'ol/render/webgl/serialize.js';
import type {Transform} from 'ol/transform.js';
import {type Mat4, create as createMat4, reset, rotate, scale, translate} from 'ol/vec/mat4.js';
import type {AttributeDefinition} from './stylePasses.js';

const {BUILD_INSTRUCTIONS, DISPOSE_INSTRUCTIONS, RENDER} = TextOverlayWorkerMessageType;

export interface TextInstructions {
  polygons: Float32Array | null;
  lines: Float32Array | null;
  points: Float32Array | null;
  /** Bytes of the LabelsArray filled while generating the instructions. */
  labels: Uint8Array;
}

/** View state of the frame a text image was drawn for (serialized by ol). */
export interface TextFrame {
  viewState: {center: number[]; resolution: number; rotation: number};
  size: number[];
}

export interface TextImage {
  /** Canvas holding the image (like ol's overlay canvas, uploaded as a texture). */
  canvas: HTMLCanvasElement;
  frame: TextFrame;
  /** Instructions set it was drawn from. */
  key: string;
  /** Increases whenever the canvas content changes. */
  version: number;
}

export class TextOverlay {
  private readonly worker: Promise<Worker>;
  private nextId = 0;
  private readonly pending = new Map<number, (data: any) => void>();
  private renderId: number | null = null;
  private terminated = false;
  private failed = false;
  /** Latest rendered text image. */
  image: TextImage | null = null;

  constructor() {
    // loaded on demand like ol does: the worker bundle is ~125 kB
    this.worker = import('ol/worker/textOverlay.js').then(({create}) => {
      const worker = create();
      worker.addEventListener('message', (e: MessageEvent) => {
        const resolve = this.pending.get(e.data?.id);
        if (resolve) {
          this.pending.delete(e.data.id);
          resolve(e.data);
        } else {
          // Answer to a render that was replaced after the worker had drawn it:
          // free the full-viewport bitmap now. Left to the garbage collector,
          // one per frame forces full collections of the whole JS heap.
          (e.data?.imageData as ImageBitmap | undefined)?.close?.();
        }
      });
      if (this.terminated) {
        worker.terminate();
      }
      return worker;
    });
    this.worker.catch((e) => {
      // labels are lost, but the layer must still render its geometries
      console.warn('ol-webgpu: text worker unavailable, labels are not drawn', e);
      this.failed = true;
      this.pending.forEach((resolve) => resolve({}));
      this.pending.clear();
    });
  }

  private send(message: Record<string, unknown>, transfer: Transferable[] = []): {id: number; done: Promise<any>} {
    const id = this.nextId++;
    if (this.failed || this.terminated) {
      return {id, done: Promise.resolve({})};
    }
    const done = new Promise<any>((resolve) => this.pending.set(id, resolve));
    this.worker.then(
      (w) => !this.terminated && w.postMessage({...message, id}, transfer),
      () => {},
    );
    return {id, done};
  }

  /**
   * Builds text batches; resolves to the key of the instructions set, or null
   * when there is nothing to draw. Copies the instructions (the caller may
   * transfer its arrays elsewhere afterwards).
   */
  build(
    instructions: TextInstructions,
    style: FlatStyleLike,
    customAttributes: Record<string, AttributeDefinition>,
    transform: Transform,
    resolution: number,
  ): Promise<string | null> {
    const copy = (a: Float32Array | null) => (a ? new Float32Array(a).buffer : undefined);
    const polygons = copy(instructions.polygons);
    const lines = copy(instructions.lines);
    const points = copy(instructions.points);
    const labels = new Uint8Array(instructions.labels);
    const customAttributesSizes: Record<string, number> = {};
    for (const name of Object.keys(customAttributes)) {
      customAttributesSizes[name] = customAttributes[name].size || 1;
    }
    const transfer = [polygons, lines, points, labels.buffer].filter(Boolean) as Transferable[];
    return this.send(
      {
        type: BUILD_INSTRUCTIONS,
        polygonRenderInstructions: polygons,
        lineStringRenderInstructions: lines,
        pointRenderInstructions: points,
        labelsArray: labels,
        style, // cloned by postMessage; the worker strips non-text properties from its copy
        customAttributesSizes,
        renderInstructionsTransform: Array.from(transform),
        resolution,
      },
      transfer,
    ).done.then((data) => data.instructionsSetKey ?? null);
  }

  /**
   * Draws the given instruction sets for `frameState`. Resolves to true when
   * `image` was updated, false when the request was replaced by a newer one
   * or nothing was drawn (e.g. the set is not built yet).
   */
  render(frameState: FrameState, keys: string[]): Promise<boolean> {
    if (this.renderId !== null) {
      // the worker drops a pending render when a new one arrives
      const resolve = this.pending.get(this.renderId);
      this.pending.delete(this.renderId);
      resolve?.({});
    }
    const {id, done} = this.send({type: RENDER, frameState: serializeFrameState(frameState), batchesToRender: new Set(keys)});
    const key = keys[0] ?? '';
    this.renderId = id;
    return done.then((data) => {
      if (this.renderId === id) {
        this.renderId = null;
      }
      const bitmap: ImageBitmap | undefined = data.imageData;
      if (!bitmap || this.terminated) {
        bitmap?.close();
        return false;
      }
      // like ol: copy into a 2D canvas, which is then uploaded as a texture
      const image = this.image ?? {canvas: document.createElement('canvas'), frame: data.frameState, key, version: 0};
      const canvas = image.canvas;
      const ctx = canvas.getContext('2d')!;
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      image.frame = data.frameState;
      image.key = key;
      image.version++;
      this.image = image;
      return true;
    });
  }

  dispose(key: string) {
    this.worker.then((w) => !this.terminated && w.postMessage({type: DISPOSE_INSTRUCTIONS, instructionsSetKey: key}));
  }

  terminate() {
    this.terminated = true;
    this.pending.forEach((resolve) => resolve({}));
    this.pending.clear();
    this.worker.then((w) => w.terminate(), () => {});
  }
}

/**
 * Maps the current frame's clip space to the text image's clip space; same
 * as the `u_textOverlayMatrix` uniform of ol's text post-process
 * (`createPostProcessDefinition` in ol/render/webgl/textUtil.js).
 */
export function overlayMatrix(image: TextImage, frameState: FrameState, out: Mat4 = createMat4()): Mat4 {
  const rendered = image.frame.viewState;
  const viewState = frameState.viewState;
  const size = frameState.size;
  reset(out);
  scale(out, 1 / rendered.resolution / (image.canvas.width / 2), 1 / rendered.resolution / (image.canvas.height / 2), 1, out);
  rotate(out, rendered.rotation, out);
  translate(out, viewState.center[0] - rendered.center[0], viewState.center[1] - rendered.center[1], 0, out);
  rotate(out, -viewState.rotation, out);
  scale(out, (viewState.resolution * size[0]) / 2, (viewState.resolution * size[1]) / 2, 1, out);
  return out;
}

/**
 * Fragment logic of ol's text post-process. ol computes
 * `text.a * text + (1 - text.a) * layer` in a shader over the layer image;
 * the backends draw a full-screen pass that outputs `(a * text.rgb, a)` with
 * blending rgb: (ONE, ONE_MINUS_SRC_ALPHA), alpha: (SRC_ALPHA,
 * ONE_MINUS_SRC_ALPHA), which gives the same colour and the same alpha
 * (`a * a + (1 - a) * layer.a`).
 */
export const TEXT_OVERLAY_GLSL = {
  vertex: `#version 300 es
precision highp float;
out vec2 v_texCoord;
void main() {
  // one triangle covering the viewport
  vec2 p = vec2(float((gl_VertexID & 1) << 2) - 1.0, float((gl_VertexID & 2) << 1) - 1.0);
  v_texCoord = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`,
  fragment: `#version 300 es
precision mediump float;
uniform sampler2D u_textOverlay;
uniform mat4 u_textOverlayMatrix;
in vec2 v_texCoord;
out vec4 fragColor;
void main() {
  vec2 coords = v_texCoord * 2. - vec2(1.);
  coords = (u_textOverlayMatrix * vec4(coords.xy, 0., 1.)).xy;
  coords = coords * 0.5 + vec2(0.5);
  float outOfBounds = clamp(step(1., coords.x) + step(1., coords.y) + step(0., -coords.x) + step(0., -coords.y), 0., 1.);
  vec4 textColor = texture(u_textOverlay, vec2(coords.x, 1. - coords.y));
  textColor.a *= 1. - outOfBounds;
  fragColor = vec4(textColor.a * textColor.rgb, textColor.a);
}`,
};

export const TEXT_OVERLAY_WGSL = `
struct Uniforms { matrix: mat4x4<f32> };
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var overlay: texture_2d<f32>;
@group(0) @binding(2) var overlaySampler: sampler;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) texCoord: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VertexOut {
  // one triangle covering the viewport
  let p = vec2<f32>(f32((i & 1u) << 2u) - 1.0, f32((i & 2u) << 1u) - 1.0);
  var out: VertexOut;
  out.position = vec4<f32>(p, 0.0, 1.0);
  out.texCoord = p * 0.5 + 0.5; // y up, like GL's v_texCoord
  return out;
}

@fragment
fn fs(in: VertexOut) -> @location(0) vec4<f32> {
  var coords = in.texCoord * 2.0 - vec2<f32>(1.0);
  coords = (u.matrix * vec4<f32>(coords, 0.0, 1.0)).xy;
  coords = coords * 0.5 + vec2<f32>(0.5);
  let outOfBounds = clamp(step(1.0, coords.x) + step(1.0, coords.y) + step(0.0, -coords.x) + step(0.0, -coords.y), 0.0, 1.0);
  var textColor = textureSampleLevel(overlay, overlaySampler, vec2<f32>(coords.x, 1.0 - coords.y), 0.0);
  textColor.a = textColor.a * (1.0 - outOfBounds);
  return vec4<f32>(textColor.a * textColor.rgb, textColor.a);
}
`;
