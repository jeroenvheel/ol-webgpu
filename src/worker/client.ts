/**
 * Main-thread side of the workers: one client per page, requests matched to
 * responses by id. There is one worker until a build is asked for while it
 * has a lot to do: then a second one starts (see `maxWorkers` and
 * `WORTH_A_WORKER`), so a big build of one layer does not hold up the builds
 * of the others. When a worker cannot
 * start or fails, builds run on the main thread instead.
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
  bytes: number;
}

/** A worker and the builds it has. */
interface Slot {
  worker: Worker;
  pending: Map<number, Pending>;
  /** Bytes of instructions of the builds it has. */
  bytes: number;
  /** Stops a worker that was added for a busy moment, when it has had nothing to do for a while. */
  idle: ReturnType<typeof setTimeout> | null;
}

/** How long an extra worker stays without builds before it is stopped (its memory is given back). */
const EXTRA_WORKER_IDLE = 10_000;

/**
 * A build waits for the builds before it. Another worker is worth starting
 * (its script and WebAssembly instance take 0.1 to 0.2 s) when that wait is
 * longer: when this many bytes of instructions are ahead at every worker.
 * 200 000 lines are about 10 MB and take 0.3 s.
 */
const WORTH_A_WORKER = 4 * 1024 * 1024;

let shared: WorkerClient | null = null;

export class WorkerClient {
  /**
   * The most workers that build at the same time (the first one stays, the
   * others stop when idle). One fewer than the processor has threads, and
   * two at most: every worker has its own WebAssembly instance, and the
   * main thread needs a core to make the instructions for the builds.
   */
  static maxWorkers = Math.max(1, Math.min(2, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1));

  /** Bytes of instructions that have to be waiting at every worker before another one starts. */
  static worthAWorker = WORTH_A_WORKER;

  /** Empty once a worker failed (or the first could not be created). */
  private slots: Slot[] = [];
  /** The most workers there were at once (for tests and benchmarks). */
  mostWorkers = 0;
  /** The core for builds on the main thread (null: ol's JS code), loaded when the worker failed. */
  private local: Promise<Core | null> | null = null;
  private nextId = 1;
  private readonly wasmUrl: string | URL;
  private resolveReady!: (engine: 'wasm' | 'js') => void;
  /** Resolves with the engine that builds ('wasm' or 'js' fallback), in the worker or on the main thread. */
  readonly ready: Promise<'wasm' | 'js'> = new Promise((resolve) => (this.resolveReady = resolve));

  constructor(
    options: WorkerOptions = {},
    private readonly deps: WorkerDeps = defaultDeps,
  ) {
    this.wasmUrl = options.wasmUrl ?? defaultWasmUrl();
    this.addWorker();
  }

  /** Starts a worker; null (and builds on the main thread from then on) when that fails. */
  private addWorker(): Slot | null {
    let worker: Worker;
    try {
      worker = this.deps.createWorker();
    } catch (e) {
      // e.g. a Content Security Policy that does not allow the worker
      this.fail(String(e));
      return null;
    }
    const slot: Slot = {worker, pending: new Map(), bytes: 0, idle: null};
    this.slots.push(slot);
    this.mostWorkers = Math.max(this.mostWorkers, this.slots.length);
    worker.addEventListener('message', (e: MessageEvent<ReadyMessage | BuildResponse>) => {
      const data = e.data;
      if (data.type === 'ready') {
        if (data.error) {
          console.warn('ol-webgpu: WebAssembly unavailable, using the JS fallback:', data.error);
        }
        this.resolveReady(data.engine);
      } else if (data.type === 'build') {
        const pending = slot.pending.get(data.id);
        if (pending) {
          slot.pending.delete(data.id);
          slot.bytes -= pending.bytes;
          settle(pending, data);
          this.rest(slot);
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
    return slot;
  }

  /** A worker has nothing to do: an extra one is stopped after a while. */
  private rest(slot: Slot) {
    if (slot.pending.size || slot === this.slots[0] || slot.idle !== null) {
      return;
    }
    slot.idle = setTimeout(() => {
      slot.idle = null;
      const at = this.slots.indexOf(slot);
      if (at > 0 && !slot.pending.size) {
        this.slots.splice(at, 1);
        slot.worker.terminate();
      }
    }, EXTRA_WORKER_IDLE);
    // a timer that is only there to free memory does not keep a process alive (Node)
    (slot.idle as {unref?: () => void}).unref?.();
  }

  /** The number of workers right now. */
  get workers(): number {
    return this.slots.length;
  }

  static shared(options?: WorkerOptions): WorkerClient {
    shared ??= new WorkerClient(options);
    return shared;
  }

  /** Whether builds run on the main thread because a worker failed. */
  get onMainThread(): boolean {
    return !this.slots.length;
  }

  /**
   * A worker is gone, so workers cannot be counted on here: the builds of all
   * of them are rejected with a {@link WorkerFailedError} and the builds
   * asked from now on run on the main thread.
   */
  private fail(reason: string) {
    if (this.local) {
      return;
    }
    console.warn(`ol-webgpu: the worker is unavailable (${reason}); buffers are built on the main thread`);
    const slots = this.slots;
    this.slots = [];
    for (const slot of slots) {
      slot.worker.terminate();
      if (slot.idle !== null) {
        clearTimeout(slot.idle);
      }
    }
    this.local = this.deps.loadCore(this.wasmUrl).then(
      (core) => core,
      (e) => {
        console.warn('ol-webgpu: WebAssembly unavailable, using the JS fallback:', String(e));
        return null;
      },
    );
    this.local.then((core) => this.resolveReady(core ? 'wasm' : 'js'));
    const lost = slots.flatMap((slot) => [...slot.pending.values()]);
    const error = new WorkerFailedError(reason);
    lost.forEach((p) => p.reject(error));
  }

  build(request: Omit<BuildRequest, 'type' | 'id'>): Promise<BuildResponse> {
    const id = this.nextId++;
    const message: BuildRequest = {...request, type: 'build', id};
    // the worker with the least to do; another one when that is a lot and there may be more
    let slot = this.slots.reduce<Slot | null>((least, s) => (!least || s.bytes < least.bytes ? s : least), null);
    if (slot && slot.bytes >= WorkerClient.worthAWorker && this.slots.length < WorkerClient.maxWorkers) {
      slot = this.addWorker();
    }
    if (!slot) {
      return this.local!.then(
        (core) =>
          new Promise((resolve, reject) => {
            settle({resolve, reject, bytes: 0}, runBuild(message, core));
          }),
      );
    }
    const transfer = [request.points, request.lines, request.polygons].filter(
      (b): b is ArrayBuffer => !!b,
    );
    const target = slot;
    if (target.idle !== null) {
      clearTimeout(target.idle);
      target.idle = null;
    }
    // an empty build still counts, so builds are spread
    const bytes = transfer.reduce((sum, b) => sum + b.byteLength, 1);
    target.bytes += bytes;
    return new Promise((resolve, reject) => {
      target.pending.set(id, {resolve, reject, bytes});
      target.worker.postMessage(message, transfer);
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
