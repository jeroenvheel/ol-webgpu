/** What the rendering test pages wait for. */
import {liveRenderers} from '../../src/renderer/BaseGpuVectorRenderer.js';

/** Resolves on the next animation frame. */
export const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

/** All ol-webgpu renderers have built their buffers, drawn them for `frames` frames, can be picked, and their labels are at rest. */
export const renderersSettled = (frames = 1) => [...liveRenderers].every((r) => r.ready && r.framesSinceReady >= frames && !r.indexPending && !r.labelsBusy);
