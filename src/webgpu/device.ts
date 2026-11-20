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

/** Registers a callback for device loss; returns an unregister function. */
export function onDeviceLost(listener: () => void): () => void {
  lostListeners.add(listener);
  return () => lostListeners.delete(listener);
}

export function preferredFormat(): GPUTextureFormat {
  return navigator.gpu.getPreferredCanvasFormat();
}
