/**
 * WebGPU canvas shared by consecutive WebGPU layers (see render/surface.ts).
 */
import type {FrameState} from 'ol/Map.js';
import ViewHint from 'ol/ViewHint.js';
import {Surface} from '../render/surface.js';
import {flushSubmits, frameEncoder, submitEpoch} from './device.js';

/** Composites a layer's offscreen image onto the canvas with the layer opacity. */
const COMPOSITE_WGSL = `
struct Uniforms { opacity: f32 };
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var layerImage: texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  // one triangle covering the viewport
  let p = vec2<f32>(f32((i & 1u) << 2u) - 1.0, f32((i & 2u) << 1u) - 1.0);
  return vec4<f32>(p, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  // premultiplied colour, so opacity scales all channels (like a CSS opacity)
  return textureLoad(layerImage, vec2<i32>(position.xy), 0) * u.opacity;
}
`;

export interface Composite {
  pipeline: GPURenderPipeline;
  layout: GPUBindGroupLayout;
}

const composites = new WeakMap<GPUDevice, Map<string, Composite>>();

/** Pipeline that composites an offscreen layer image (one per device, format and sample count). */
export function compositePipeline(device: GPUDevice, format: GPUTextureFormat, sampleCount: number): Composite {
  let perDevice = composites.get(device);
  if (!perDevice) {
    perDevice = new Map();
    composites.set(device, perDevice);
  }
  const key = `${format}/${sampleCount}`;
  let composite = perDevice.get(key);
  if (!composite) {
    const module = device.createShaderModule({code: COMPOSITE_WGSL, label: 'ol-webgpu composite'});
    const layout = device.createBindGroupLayout({
      entries: [
        {binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: {type: 'uniform'}},
        {binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {sampleType: 'unfilterable-float'}},
      ],
    });
    composite = {
      layout,
      pipeline: device.createRenderPipeline({
        label: 'ol-webgpu composite',
        layout: device.createPipelineLayout({bindGroupLayouts: [layout]}),
        vertex: {module, entryPoint: 'vs'},
        fragment: {
          module,
          entryPoint: 'fs',
          targets: [{format, blend: {
            color: {srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add'},
            alpha: {srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add'},
          }}],
        },
        primitive: {topology: 'triangle-list'},
        multisample: {count: sampleCount},
      }),
    };
    perDevice.set(key, composite);
  }
  return composite;
}

/** What a layer drew in the last frame, so the frame can be drawn again for export. */
export interface DrawRecord {
  redraw(): void;
}

export class WebGPUSurface extends Surface {
  private context: GPUCanvasContext | null = null;
  private device: GPUDevice | null = null;
  private format: GPUTextureFormat = 'bgra8unorm';
  private msaa: {texture: GPUTexture; view: GPUTextureView} | null = null;
  /** Canvas texture view of the current frame (until the next submit). */
  private target: {epoch: number; view: GPUTextureView} | null = null;
  private records: DrawRecord[] = [];
  private redrawing = false;
  private redrawnFrame = -1;
  private lastFrame = -1;

  constructor(
    key: string,
    className: string,
    readonly sampleCount: number,
    private readonly preserveDrawingBuffer: boolean,
  ) {
    super(key, className);
  }

  /** Configures the canvas for a device (again after a device loss). */
  configure(device: GPUDevice, format: GPUTextureFormat) {
    if (this.device === device && this.context) {
      return;
    }
    this.context ??= this.canvas.getContext('webgpu');
    if (!this.context) {
      throw new Error('ol-webgpu: could not create a WebGPU canvas context');
    }
    this.context.configure({device, format, alphaMode: 'premultiplied', usage: GPUTextureUsage.RENDER_ATTACHMENT});
    this.device = device;
    this.format = format;
    this.msaa = null;
    this.target = null;
    this.blank = true;
  }

  getContext(): GPUCanvasContext | null {
    return this.context;
  }

  override beginFrame(frameState: FrameState) {
    super.beginFrame(frameState);
    this.lastFrame = frameState.index;
  }

  protected override restartFrame() {
    super.restartFrame();
    if (!this.redrawing) {
      this.records = [];
    }
  }

  /** Records a layer's draw of this frame for the export redraw. */
  record(record: DrawRecord) {
    if (!this.redrawing) {
      this.records.push(record);
    }
  }

  private targetView(): GPUTextureView {
    const epoch = submitEpoch();
    if (!this.target || this.target.epoch !== epoch) {
      this.target = {epoch, view: this.context!.getCurrentTexture().createView()};
    }
    return this.target.view;
  }

  private msaaView(): GPUTextureView {
    const {width, height} = this.canvas;
    if (!this.msaa || this.msaa.texture.width !== width || this.msaa.texture.height !== height) {
      if (this.msaa) {
        flushSubmits();
        this.msaa.texture.destroy();
      }
      const texture = this.device!.createTexture({size: [width, height], sampleCount: this.sampleCount, format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT});
      this.msaa = {texture, view: texture.createView()};
    }
    return this.msaa.view;
  }

  /** A render pass that draws over what earlier layers drew on the canvas in this frame. */
  beginPass(encoder: GPUCommandEncoder): GPURenderPassEncoder {
    return this.pass(encoder, this.takeClear() ? 'clear' : 'load');
  }

  private pass(encoder: GPUCommandEncoder, loadOp: GPULoadOp): GPURenderPassEncoder {
    const target = this.targetView();
    return encoder.beginRenderPass({
      colorAttachments: [
        this.sampleCount > 1
          ? {view: this.msaaView(), resolveTarget: target, clearValue: [0, 0, 0, 0], loadOp, storeOp: 'store'}
          : {view: target, clearValue: [0, 0, 0, 0], loadOp, storeOp: 'store'},
      ],
    });
  }

  protected clear() {
    if (!this.device || !this.context) {
      return;
    }
    this.pass(frameEncoder(this.device), 'clear').end();
  }

  /**
   * A presented WebGPU canvas reads back empty from a later task, so when the
   * app may export (rendercomplete, which ol dispatches from a timeout), the
   * layers draw the last frame once more, in order. Not while the view is
   * being dragged or animated: ol fires rendercomplete after every such
   * frame, and drawing each one twice would halve the frame rate; the frame
   * after the interaction ends is drawn again as usual.
   */
  redraw(frameState: FrameState | null | undefined) {
    if (!this.preserveDrawingBuffer || !frameState || frameState.index !== this.lastFrame || this.redrawnFrame === frameState.index || !this.device) {
      return;
    }
    if (frameState.viewHints[ViewHint.INTERACTING] || frameState.viewHints[ViewHint.ANIMATING]) {
      return;
    }
    this.redrawnFrame = frameState.index;
    this.redrawing = true;
    try {
      this.restartFrame();
      this.target = null;
      this.records.forEach((r) => r.redraw());
      this.endFrame(frameState);
    } finally {
      this.redrawing = false;
    }
    flushSubmits();
  }

  protected override dispose() {
    flushSubmits();
    this.msaa?.texture.destroy();
    this.context?.unconfigure();
  }
}
