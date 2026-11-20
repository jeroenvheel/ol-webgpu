/**
 * A canvas shared by consecutive ol-webgpu layers, like ol's WebGL layers
 * share one canvas per group of consecutive layers with the same class name
 * (ol/renderer/webgl/Layer.js). Layers draw into it in map order: the first
 * layer with something to draw in a frame clears it, the others draw over.
 * One canvas per layer would cost a WebGL context each (browsers keep about
 * 16 per page and drop the oldest), and for WebGPU a canvas texture, a render
 * pass and a compositor layer each.
 */
import type {FrameState} from 'ol/Map.js';

export abstract class Surface {
  readonly canvas: HTMLCanvasElement;
  /** Renderers using this surface. */
  users = 0;
  private frameIndex = -1;
  /** Nothing has been drawn in this frame yet: the next draw clears the canvas first. */
  private needsClear = false;
  /** The canvas shows nothing (never drawn, cleared or resized). */
  protected blank = true;

  constructor(
    readonly key: string,
    className: string,
  ) {
    const canvas = document.createElement('canvas');
    canvas.style.position = 'absolute';
    canvas.style.left = '0'; // like ol's WebGL canvas: no explicit top
    canvas.className = className;
    this.canvas = canvas;
  }

  /** Sizes the canvas for a frame (a resize clears it). */
  resize(width: number, height: number, cssWidth: number, cssHeight: number) {
    const canvas = this.canvas;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = cssWidth + 'px';
      canvas.style.height = cssHeight + 'px';
      this.blank = true;
    }
  }

  /** Called by each layer before it draws; the first call of a frame starts it. */
  beginFrame(frameState: FrameState) {
    if (frameState.index !== this.frameIndex) {
      this.frameIndex = frameState.index;
      this.restartFrame();
    }
  }

  /** Starts the current frame over (the WebGPU backend draws it again for export). */
  protected restartFrame() {
    this.needsClear = true;
  }

  /** A layer is about to draw: returns whether it must clear the canvas first. */
  takeClear(): boolean {
    const clear = this.needsClear;
    this.needsClear = false;
    this.blank = false;
    return clear;
  }

  /**
   * After all layers of a frame have rendered (map `postcompose`): if none
   * of this surface's layers drew anything, clear what an earlier frame left.
   */
  endFrame(frameState: FrameState | null | undefined) {
    if (!frameState || frameState.index !== this.frameIndex || !this.needsClear) {
      return;
    }
    this.needsClear = false;
    if (!this.blank) {
      this.clear();
      this.blank = true;
    }
  }

  protected abstract clear(): void;

  protected dispose() {}

  /** @internal */
  disposeSurface() {
    this.dispose();
  }
}

/** What is fixed per canvas: the backend and the options its context is created with. */
export interface SurfaceSpec {
  backend: 'webgpu' | 'webgl2';
  /** Multisample antialiasing. */
  antialias: boolean;
  /** Keep the drawing buffer after compositing (needed for map export). */
  preserveDrawingBuffer: boolean;
}

/** The spec for a layer's options; the defaults of the two options are here and nowhere else. */
export function surfaceSpec(backend: SurfaceSpec['backend'], options: {antialias?: boolean; preserveDrawingBuffer?: boolean}): SurfaceSpec {
  return {backend, antialias: options.antialias ?? false, preserveDrawingBuffer: options.preserveDrawingBuffer ?? true};
}

/** Layers share a canvas only when this matches. */
export function surfaceType(spec: SurfaceSpec): string {
  return `${spec.backend}/${spec.antialias ? 1 : 0}/${spec.preserveDrawingBuffer ? 1 : 0}`;
}

const surfaces = new Map<string, Surface>();

/** The surface for `key`, created on first use; release it with `releaseSurface`. */
export function acquireSurface<T extends Surface>(key: string, create: () => T): T {
  let surface = surfaces.get(key) as T | undefined;
  if (!surface) {
    surface = create();
    surfaces.set(key, surface);
  }
  surface.users++;
  return surface;
}

export function releaseSurface(surface: Surface) {
  if (--surface.users > 0) {
    return;
  }
  if (surfaces.get(surface.key) === surface) {
    surfaces.delete(surface.key);
  }
  surface.disposeSurface();
}
