/**
 * Main-thread side of the worker: one shared worker per page, requests
 * matched to responses by id. When the worker cannot start or fails, builds
 * run on the main thread instead.
 */
import {type Core, defaultWasmUrl, loadCore} from '../wasm/core.js';
import {runBuild} from './build.js';
import type {BuildRequest, BuildResponse, InitMessage, ReadyMessage} from './protocol.js';

export interface WorkerOptions {
  /** Override the wasm URL (e.g. when serving assets from a CDN). */
  wasmUrl?: string | URL;
}

/**
 * A build was lost with the worker (its instructions went to the worker and
 * are gone). The same build asked again runs on the main thread.
 */
export class WorkerFailedError extends Error {
  constructor(reason: string) {
    super(`ol-webgpu: the worker failed (${reason})`);
    this.name = 'WorkerFailedError';
  }
}

/** What a client needs from its surroundings (replaced in unit tests). */
export interface WorkerDeps {
  createWorker(): Worker;
  loadCore(wasmUrl: string | URL): Promise<Core>;
}

const defaultDeps: WorkerDeps = {
  createWorker: () => new Worker(new URL('./worker.ts', import.meta.url), {type: 'module', name: 'ol-webgpu'}),
  loadCore,
};

interface Pending {
  resolve(r: BuildResponse): void;
  reject(e: Error): void;
}

let shared: WorkerClient | null = null;

export class WorkerClient {
  /** Null once the worker failed (or could not be created). */
  private worker: Worker | null = null;
  /** The core for builds on the main thread (null: ol's JS code), loaded when the worker failed. */
  private local: Promise<Core | null> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly wasmUrl: string | URL;
  private resolveReady!: (engine: 'wasm' | 'js') => void;
  /** Resolves with the engine that builds ('wasm' or 'js' fallback), in the worker or on the main thread. */
  readonly ready: Promise<'wasm' | 'js'> = new Promise((resolve) => (this.resolveReady = resolve));

  constructor(
    options: WorkerOptions = {},
    private readonly deps: WorkerDeps = defaultDeps,
  ) {
    this.wasmUrl = options.wasmUrl ?? defaultWasmUrl();
    let worker: Worker;
    try {
      worker = deps.createWorker();
    } catch (e) {
      // e.g. a Content Security Policy that does not allow the worker
      this.fail(String(e));
      return;
    }
    this.worker = worker;
    worker.addEventListener('message', (e: MessageEvent<ReadyMessage | BuildResponse>) => {
      const data = e.data;
      if (data.type === 'ready') {
        if (data.error) {
          console.warn('ol-webgpu: WebAssembly unavailable, using the JS fallback:', data.error);
        }
        this.resolveReady(data.engine);
      } else if (data.type === 'build') {
        const pending = this.pending.get(data.id);
        if (pending) {
          this.pending.delete(data.id);
          settle(pending, data);
        }
      }
    });
    // the script did not load (404, CSP, a bundler that left it out) or threw outside a build
    worker.addEventListener('error', (e: ErrorEvent) => {
      e.preventDefault?.();
      this.fail(e.message || 'the worker script could not be loaded or threw');
    });
    worker.addEventListener('messageerror', () => this.fail('a message could not be read'));
    worker.postMessage({type: 'init', wasmUrl: String(this.wasmUrl)} satisfies InitMessage);
  }

  static shared(options?: WorkerOptions): WorkerClient {
    shared ??= new WorkerClient(options);
    return shared;
  }

  /** Whether builds run on the main thread because the worker failed. */
  get onMainThread(): boolean {
    return !this.worker;
  }

  /**
   * The worker is gone: its builds are rejected with a {@link WorkerFailedError}
   * and the builds asked from now on run on the main thread.
   */
  private fail(reason: string) {
    if (this.local) {
      return;
    }
    console.warn(`ol-webgpu: the worker is unavailable (${reason}); buffers are built on the main thread`);
    this.worker?.terminate();
    this.worker = null;
    this.local = this.deps.loadCore(this.wasmUrl).then(
      (core) => core,
      (e) => {
        console.warn('ol-webgpu: WebAssembly unavailable, using the JS fallback:', String(e));
        return null;
      },
    );
    this.local.then((core) => this.resolveReady(core ? 'wasm' : 'js'));
    const lost = [...this.pending.values()];
    this.pending.clear();
    const error = new WorkerFailedError(reason);
    lost.forEach((p) => p.reject(error));
  }

  build(request: Omit<BuildRequest, 'type' | 'id'>): Promise<BuildResponse> {
    const id = this.nextId++;
    const message: BuildRequest = {...request, type: 'build', id};
    const worker = this.worker;
    if (!worker) {
      return this.local!.then(
        (core) =>
          new Promise((resolve, reject) => {
            settle({resolve, reject}, runBuild(message, core));
          }),
      );
    }
    const transfer = [request.points, request.lines, request.polygons].filter(
      (b): b is ArrayBuffer => !!b,
    );
    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      worker.postMessage(message, transfer);
    });
  }
}

function settle(pending: Pending, response: BuildResponse) {
  if (response.error) {
    pending.reject(new Error(response.error));
  } else {
    pending.resolve(response);
  }
}
