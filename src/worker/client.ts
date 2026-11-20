/**
 * Main-thread side of the worker: one shared worker per page, requests
 * matched to responses by id.
 */
import {defaultWasmUrl} from '../wasm/core.js';
import type {BuildRequest, BuildResponse, InitMessage, ReadyMessage} from './protocol.js';

export interface WorkerOptions {
  /** Override the wasm URL (e.g. when serving assets from a CDN). */
  wasmUrl?: string | URL;
}

let shared: WorkerClient | null = null;

export class WorkerClient {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, (r: BuildResponse) => void>();
  /** Resolves with the engine used by the worker ('wasm' or 'js' fallback). */
  readonly ready: Promise<'wasm' | 'js'>;

  constructor(options: WorkerOptions = {}) {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), {type: 'module', name: 'ol-webgpu'});
    this.worker.postMessage({type: 'init', wasmUrl: String(options.wasmUrl ?? defaultWasmUrl())} satisfies InitMessage);
    this.ready = new Promise((resolve) => {
      const onReady = (e: MessageEvent<ReadyMessage | BuildResponse>) => {
        if (e.data.type === 'ready') {
          if (e.data.error) {
            console.warn('ol-webgpu: WebAssembly unavailable, using the JS fallback:', e.data.error);
          }
          this.worker.removeEventListener('message', onReady);
          resolve(e.data.engine);
        }
      };
      this.worker.addEventListener('message', onReady);
    });
    this.worker.addEventListener('message', (e: MessageEvent<ReadyMessage | BuildResponse>) => {
      if (e.data.type === 'build') {
        const resolve = this.pending.get(e.data.id);
        if (resolve) {
          this.pending.delete(e.data.id);
          resolve(e.data);
        }
      }
    });
  }

  static shared(options?: WorkerOptions): WorkerClient {
    shared ??= new WorkerClient(options);
    return shared;
  }

  build(request: Omit<BuildRequest, 'type' | 'id'>): Promise<BuildResponse> {
    const id = this.nextId++;
    const message: BuildRequest = {...request, type: 'build', id};
    const transfer = [request.points, request.lines, request.polygons].filter(
      (b): b is ArrayBuffer => !!b,
    );
    return new Promise((resolve, reject) => {
      this.pending.set(id, (r) => (r.error ? reject(new Error(r.error)) : resolve(r)));
      this.worker.postMessage(message, transfer);
    });
  }
}
