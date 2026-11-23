import {describe, expect, it, vi} from 'vitest';
import {WorkerClient, type WorkerDeps, WorkerFailedError} from '../../src/worker/client.js';
import type {BuildRequest, BuildResponse} from '../../src/worker/protocol.js';
import {loadTestCore} from './helpers.js';

/** A worker that answers nothing by itself and fails when told to. */
class FakeWorker extends EventTarget {
  messages: {type: string}[] = [];
  terminated = false;
  postMessage(message: {type: string}) {
    this.messages.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  answer(data: unknown) {
    const event = new Event('message') as Event & {data: unknown};
    event.data = data;
    this.dispatchEvent(event);
  }
  fail() {
    const event = new Event('error') as Event & {message: string};
    event.message = 'script not found';
    this.dispatchEvent(event);
  }
}

// two points with one custom attribute: x, y, attribute
const request = (): Omit<BuildRequest, 'type' | 'id'> => ({
  points: new Float32Array([0, 0, 5, 0.5, 0.5, 6]).buffer as ArrayBuffer,
  lines: null,
  polygons: null,
  customSize: 1,
  refOffset: 0,
  invert: [1, 0, 0, 1, 0, 0],
  indexTransform: [100, 0, 0, 100, 0, 0],
});

const answerTo = (sent: BuildRequest, error?: string): BuildResponse => ({
  type: 'build',
  id: sent.id,
  points: null,
  lines: null,
  polygons: null,
  index: null,
  engine: 'wasm',
  timings: {},
  error,
});

function client(loadCore: WorkerDeps['loadCore'] = () => loadTestCore()) {
  const worker = new FakeWorker();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  return {worker, client: new WorkerClient({wasmUrl: 'core.wasm'}, {createWorker: () => worker as unknown as Worker, loadCore})};
}

describe('WorkerClient', () => {
  it('resolves a build with the answer of the worker', async () => {
    const {worker, client: c} = client();
    const build = c.build(request());
    const response = answerTo(worker.messages.find((m) => m.type === 'build') as BuildRequest);
    worker.answer(response);
    await expect(build).resolves.toBe(response);
    expect(c.onMainThread).toBe(false);
  });

  it('rejects the builds a failed worker had, and builds on the main thread from then on', async () => {
    const {worker, client: c} = client();
    const lost = c.build(request());
    worker.fail();
    await expect(lost).rejects.toBeInstanceOf(WorkerFailedError);
    expect(worker.terminated).toBe(true);
    expect(c.onMainThread).toBe(true);
    await expect(c.ready).resolves.toBe('wasm');

    const response = await c.build(request());
    expect(response.engine).toBe('wasm');
    expect(Array.from(response.points!.instances)).toEqual([0, 0, 5, 0.5, 0.5, 6]);
    expect(response.index).toBeInstanceOf(Float32Array);
    expect(worker.messages.filter((m) => m.type === 'build')).toHaveLength(1);
  });

  it('builds with the JS code when there is no worker and no WebAssembly', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = new WorkerClient(
      {wasmUrl: 'core.wasm'},
      {
        createWorker: () => {
          throw new Error('blocked by the Content Security Policy');
        },
        loadCore: () => Promise.reject(new Error('no wasm')),
      },
    );
    expect(c.onMainThread).toBe(true);
    await expect(c.ready).resolves.toBe('js');
    const response = await c.build(request());
    expect(response.engine).toBe('js');
    expect(Array.from(response.points!.instances)).toEqual([0, 0, 5, 0.5, 0.5, 6]);
    expect(response.index).toBeNull();
  });

  it('rejects a build that fails, without giving up the worker', async () => {
    const {worker, client: c} = client();
    const build = c.build(request());
    worker.answer(answerTo(worker.messages.find((m) => m.type === 'build') as BuildRequest, 'boom'));
    const error = await build.catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(WorkerFailedError);
    expect(error.message).toBe('boom');
    expect(c.onMainThread).toBe(false);
  });
});
