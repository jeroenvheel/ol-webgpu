/**
 * One shared GPUDevice per page for all ol-webgpu WebGPU layers.
 */

let device: Promise<GPUDevice> | null = null;
const lostListeners = new Set<() => void>();

export function isWebGPUAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator && !!navigator.gpu;
}

export function getDevice(): Promise<GPUDevice> {
  if (!device) {
    device = (async () => {
      if (!isWebGPUAvailable()) {
        throw new Error('ol-webgpu: WebGPU is not available in this browser');
      }
      const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
      if (!adapter) {
        throw new Error('ol-webgpu: no WebGPU adapter available');
      }
      const d = await adapter.requestDevice({label: 'ol-webgpu'});
      d.lost.then((info) => {
        if (info.reason !== 'destroyed') {
          console.warn('ol-webgpu: WebGPU device lost:', info.message);
        }
        device = null;
        lostListeners.forEach((l) => l());
      });
      return d;
    })();
    device.catch(() => {
      device = null;
    });
  }
  return device;
}

/**
 * Command encoder shared by all layers for the current map frame. Each layer
 * records a render pass for its own canvas into it, and the frame is
 * submitted once. An encoder and a submit per layer per frame create many
 * short-lived GPU objects, and with a large JS heap the garbage collection
 * they cause costs more than the drawing.
 */
let frame: {device: GPUDevice; encoder: GPUCommandEncoder} | null = null;
let epoch = 0;
/** Resources the recorded frame may still use: destroyed once it is submitted. */
const doomed: Array<{destroy(): void}> = [];

/**
 * Destroys a buffer or texture that is being replaced. The frame recorded
 * so far may still draw with it, so it goes after that frame is submitted
 * (at once when nothing is recorded).
 */
export function destroyAfterSubmit(resource: {destroy(): void} | null | undefined) {
  if (!resource) {
    return;
  }
  if (frame) {
    doomed.push(resource);
  } else {
    resource.destroy();
  }
}

/**
 * Increases with every submit. A canvas texture from `getCurrentTexture`
 * is reused by the layers of a frame until then.
 */
export function submitEpoch(): number {
  return epoch;
}

/** The current frame's encoder; recorded work is submitted by `flushSubmits`, at the latest in a microtask. */
export function frameEncoder(d: GPUDevice): GPUCommandEncoder {
  if (frame && frame.device !== d) {
    flushSubmits();
  }
  if (!frame) {
    frame = {device: d, encoder: d.createCommandEncoder({label: 'ol-webgpu frame'})};
    queueMicrotask(flushSubmits);
  }
  return frame.encoder;
}

/**
 * Submits the recorded frame. Called when the map has composed a frame (so a
 * canvas read in the same task sees it) and from a microtask as a fallback.
 */
export function flushSubmits() {
  const f = frame;
  frame = null;
  epoch++;
  if (f) {
    f.device.queue.submit([f.encoder.finish()]);
  }
  for (const resource of doomed.splice(0)) {
    resource.destroy();
  }
}

/** Registers a callback for device loss; returns an unregister function. */
export function onDeviceLost(listener: () => void): () => void {
  lostListeners.add(listener);
  return () => lostListeners.delete(listener);
}

export function preferredFormat(): GPUTextureFormat {
  return navigator.gpu.getPreferredCanvasFormat();
}
