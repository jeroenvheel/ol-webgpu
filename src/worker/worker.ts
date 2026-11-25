/// <reference lib="webworker" />
/**
 * ol-webgpu worker: turns render instructions into GPU buffers and builds the
 * hit index, with the Rust/WASM core (JS fallback if wasm cannot load).
 */
import {type Core, LARGE_MEMORY_BYTES, compileWasm, loadCore} from '../wasm/core.js';
import {type KeptInstructions, responseTransferables, runBuild, runIndex} from './build.js';
import type {BuildRequest, IndexMessage, InitMessage, ReadyMessage} from './protocol.js';

declare const self: DedicatedWorkerGlobalScope;

let core: Core | null = null;
let module: WebAssembly.Module | null = null;
let resolveInit: (url: string) => void;
const initUrl = new Promise<string>((r) => (resolveInit = r));
let coreReady: Promise<void> = (async () => {
  try {
    // the main thread sends the wasm URL so bundlers resolve it once
    module = await compileWasm(await initUrl);
    core = await loadCore(module);
    self.postMessage({type: 'ready', engine: 'wasm'} satisfies ReadyMessage);
  } catch (e) {
    core = null;
    self.postMessage({type: 'ready', engine: 'js', error: String(e)} satisfies ReadyMessage);
  }
})();

/** Milliseconds without a build after which a large instance is replaced. */
const IDLE = 5000;
let idleTimer = 0;

/**
 * The memory of a wasm instance only grows, so after the buffers of a
 * large layer were built it would stay that large for good. Nothing is
 * kept in it between builds: when no build came for a while, a large
 * instance makes way for a new one and its memory goes back to the system.
 */
function recycleWhenIdle() {
  clearTimeout(idleTimer);
  idleTimer = self.setTimeout(() => {
    if (core && module && core.memoryBytes > LARGE_MEMORY_BYTES) {
      const fresh = loadCore(module);
      coreReady = fresh.then(
        (c) => {
          core = c;
        },
        () => {}, // the instance on hand keeps working
      );
    }
  }, IDLE);
}

self.onmessage = async (event: MessageEvent<BuildRequest | InitMessage>) => {
  const req = event.data;
  if (req.type === 'init') {
    resolveInit(req.wasmUrl);
    return;
  }
  await coreReady;
  // the buffers go out first: the layer is drawn while the hit index is made
  const kept: Partial<KeptInstructions> = {};
  const builder = core;
  const response = runBuild(req, builder, kept);
  if (response.indexFollows && !response.error) {
    self.postMessage(response, responseTransferables(response));
    const {index, time} = runIndex(req, kept as KeptInstructions, builder!);
    if (!index && module) {
      // as after a build that failed: the next one gets a new instance
      coreReady = loadCore(module).then(
        (c) => {
          core = c;
        },
        () => {},
      );
    }
    recycleWhenIdle();
    self.postMessage({type: 'index', id: req.id, index, time} satisfies IndexMessage, index ? [index.buffer as ArrayBuffer] : []);
    return;
  }
  response.indexFollows = false;
  if (response.error && core && module) {
    // whatever went wrong (out of memory, mostly), the next build gets a new instance
    coreReady = loadCore(module).then(
      (c) => {
        core = c;
      },
      () => {},
    );
  }
  recycleWhenIdle();
  self.postMessage(response, responseTransferables(response));
};
