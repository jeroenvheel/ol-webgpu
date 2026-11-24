/**
 * Per-draw uniform values, computed exactly as ol's WebGL vector renderer
 * does (Helper.applyFrameState + applyUniforms + vectorUtil.applyVectorUniforms),
 * but backend-neutral: the WebGL2 and WebGPU renderers only differ in how
 * they upload the resulting values.
 */
import type {FrameState} from 'ol/Map.js';
import {getHighPart, getLowPart} from 'ol/render/webgl/float64Util.js';
import {
  type Transform,
  apply as applyTransform,
  compose as composeTransform,
  create as createTransform,
  makeInverse,
  multiply,
  setFromArray,
} from 'ol/transform.js';
import {create as createMat4, fromTransform as mat4FromTransform} from 'ol/vec/mat4.js';
import {FB_HEIGHT_UNIFORM} from '../style/glsl.js';
import type {UniformValue} from './stylePasses.js';

/** A resolved uniform: scalar, vector, 4x4 matrix (16 floats) or texture source. */
export type ResolvedUniform = number | number[] | Float32Array | TexImageSource;

export function isTextureSource(v: unknown): v is TexImageSource {
  return (
    (typeof HTMLCanvasElement !== 'undefined' && v instanceof HTMLCanvasElement) ||
    (typeof HTMLImageElement !== 'undefined' && v instanceof HTMLImageElement) ||
    (typeof ImageData !== 'undefined' && v instanceof ImageData) ||
    (typeof ImageBitmap !== 'undefined' && v instanceof ImageBitmap) ||
    (typeof OffscreenCanvas !== 'undefined' && v instanceof OffscreenCanvas)
  );
}

const tmpTransform = createTransform();
const tmpMat4 = createMat4();

/** World to clip-space transform for a frame (Helper.makeProjectionTransform). */
export function makeProjectionTransform(
  frameState: FrameState,
  transform: Transform,
  ignoreRotation = false,
  center: number[] = frameState.viewState.center,
): Transform {
  const size = frameState.size;
  const rotation = ignoreRotation ? 0 : frameState.viewState.rotation;
  const resolution = frameState.viewState.resolution;
  return composeTransform(
    transform,
    0,
    0,
    2 / (resolution * size[0]),
    2 / (resolution * size[1]),
    -rotation,
    -center[0],
    -center[1],
  );
}

/**
 * How many worlds `x` is from the world of the projection (0 when the
 * projection does not wrap): the world copy that `x` is in.
 */
export function worldOf(x: number, projection: FrameState['viewState']['projection']): number {
  const extent = projection.getExtent();
  if (!extent || !projection.canWrapX()) {
    return 0;
  }
  return Math.floor((x - extent[0]) / (extent[2] - extent[0]));
}

export class UniformState {
  private readonly startTime = Date.now();

  /** Called for an image of the style that has not loaded yet, in each frame that would draw it. */
  onPendingImage: ((image: HTMLImageElement) => void) | null = null;

  constructor(private styleUniforms: Record<string, UniformValue>) {}

  setStyleUniforms(u: Record<string, UniformValue>) {
    this.styleUniforms = u;
  }

  /**
   * @param worldToView frame world→clip transform (already offset for the rendered world)
   * @param geometryInvert inverse of the transform the buffers were built with
   */
  compute(
    frameState: FrameState,
    worldToView: Transform,
    geometryInvert: Transform,
    framebufferHeight: number,
  ): Map<string, ResolvedUniform> {
    const out = new Map<string, ResolvedUniform>();
    const size = frameState.size;
    const vs = frameState.viewState;

    // Helper.applyFrameState
    out.set('u_time', (Date.now() - this.startTime) * 0.001);
    out.set('u_zoom', vs.zoom);
    out.set('u_resolution', vs.resolution);
    out.set('u_pixelRatio', frameState.pixelRatio);
    out.set('u_viewportSizePx', [size[0], size[1]]);
    out.set('u_rotation', vs.rotation);

    // renderer uniforms (VectorLayer.js constructor)
    out.set('u_renderExtent', [0, 0, 0, 0]);
    out.set('u_globalAlpha', 1);
    out.set('u_one', 1);
    out.set('u_depth', 0);
    out.set('u_hitDetection', 0);
    out.set(FB_HEIGHT_UNIFORM, framebufferHeight);

    // style uniforms (Helper.applyUniforms)
    for (const name in this.styleUniforms) {
      const raw = this.styleUniforms[name];
      const value = typeof raw === 'function' ? raw(frameState) : raw;
      if (Array.isArray(value) && value.length === 6) {
        out.set(name, Float32Array.from(mat4FromTransform(tmpMat4, value as Transform)));
      } else if (value !== undefined && value !== null) {
        out.set(name, value);
        if (this.onPendingImage && typeof HTMLImageElement !== 'undefined' && value instanceof HTMLImageElement && !value.complete) {
          this.onPendingImage(value);
        }
      }
    }

    // vectorUtil.applyVectorUniforms
    setFromArray(tmpTransform, worldToView);
    multiply(tmpTransform, geometryInvert);
    out.set('u_projectionMatrix', Float32Array.from(mat4FromTransform(tmpMat4, tmpTransform)));
    makeInverse(tmpTransform, tmpTransform);
    out.set('u_invertProjectionMatrix', Float32Array.from(mat4FromTransform(tmpMat4, tmpTransform)));

    const coords = [0, 0];
    composeTransform(tmpTransform, size[0] / 2, size[1] / 2, 1 / vs.resolution, 1 / vs.resolution, 0, -vs.center[0], -vs.center[1]);
    applyTransform(tmpTransform, coords);
    out.set('u_df_patternOriginX', [getHighPart(coords[0]), getLowPart(coords[0])]);
    out.set('u_df_patternOriginY', [getHighPart(coords[1]), getLowPart(coords[1])]);
    const scaleRatio = Math.pow(2, ((vs.zoom + 0.5) % 1) - 0.5);
    out.set('u_df_patternScaleRatio', [getHighPart(scaleRatio), getLowPart(scaleRatio)]);
    return out;
  }
}
