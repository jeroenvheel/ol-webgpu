import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
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

/** A client whose workers are new fake workers, in `workers`. */
function pool() {
  const workers: FakeWorker[] = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const c = new WorkerClient(
    {wasmUrl: 'core.wasm'},
    {
      createWorker: () => {
        workers.push(new FakeWorker());
        return workers[workers.length - 1] as unknown as Worker;
      },
      loadCore: () => loadTestCore(),
    },
  );
  const builds = (w: FakeWorker) => w.messages.filter((m) => m.type === 'build') as BuildRequest[];
  return {workers, client: c, builds};
}

describe('WorkerClient with more workers', () => {
  // in these tests any build that waits is worth a worker
  const worth = WorkerClient.worthAWorker;
  beforeEach(() => {
    WorkerClient.worthAWorker = 1;
  });
  afterEach(() => {
    WorkerClient.worthAWorker = worth;
  });

  it('starts no second worker for little work', () => {
    WorkerClient.worthAWorker = worth;
    WorkerClient.maxWorkers = 2;
    const {workers, client: c} = pool();
    void c.build(request());
    void c.build(request());
    void c.build(request());
    expect(workers).toHaveLength(1);
    // 5 MB of instructions are waiting: the next build gets a worker of its own
    void c.build({...request(), lines: new ArrayBuffer(5 * 1024 * 1024)});
    expect(workers).toHaveLength(1);
    void c.build(request());
    expect(workers).toHaveLength(2);
  });

  it('starts a second worker for a build that comes while the first is busy, and no third', async () => {
    WorkerClient.maxWorkers = 2;
    const {workers, client: c, builds} = pool();
    const first = c.build(request());
    expect(workers).toHaveLength(1);
    const second = c.build(request());
    expect(workers).toHaveLength(2);
    expect(workers[1].messages[0].type).toBe('init');
    // both are busy: the third build waits at the one with the fewest (the first, on a tie)
    const third = c.build(request());
    expect(workers).toHaveLength(2);
    expect(builds(workers[0])).toHaveLength(2);
    expect(builds(workers[1])).toHaveLength(1);
    expect(c.mostWorkers).toBe(2);

    // every build is answered by the worker that has it
    workers[1].answer(answerTo(builds(workers[1])[0]));
    await expect(second).resolves.toMatchObject({id: builds(workers[1])[0].id});
    workers[0].answer(answerTo(builds(workers[0])[0]));
    workers[0].answer(answerTo(builds(workers[0])[1]));
    await expect(first).resolves.toMatchObject({id: builds(workers[0])[0].id});
    await expect(third).resolves.toMatchObject({id: builds(workers[0])[1].id});
  });

  it('gives a build to the worker that is free', async () => {
    WorkerClient.maxWorkers = 2;
    const {workers, client: c, builds} = pool();
    const first = c.build(request());
    void c.build(request());
    workers[0].answer(answerTo(builds(workers[0])[0]));
    await first;
    void c.build(request());
    expect(builds(workers[0])).toHaveLength(2);
    expect(builds(workers[1])).toHaveLength(1);
  });

  it('keeps to one worker when told to', () => {
    WorkerClient.maxWorkers = 1;
    const {workers, client: c, builds} = pool();
    void c.build(request());
    void c.build(request());
    expect(workers).toHaveLength(1);
    expect(builds(workers[0])).toHaveLength(2);
    expect(c.mostWorkers).toBe(1);
    WorkerClient.maxWorkers = 2;
  });

  it('stops the extra worker when it has had nothing to do for a while', async () => {
    vi.useFakeTimers();
    try {
      WorkerClient.maxWorkers = 2;
      const {workers, client: c, builds} = pool();
      void c.build(request());
      const second = c.build(request());
      workers[1].answer(answerTo(builds(workers[1])[0]));
      await second;
      vi.advanceTimersByTime(5_000);
      expect(workers[1].terminated).toBe(false);
      vi.advanceTimersByTime(6_000);
      expect(workers[1].terminated).toBe(true);
      expect(workers[0].terminated).toBe(false);
      expect(c.workers).toBe(1);
      // and starts one again when it is busy again
      void c.build(request());
      expect(workers).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up all workers when one fails: their builds are rejected and the next run on the main thread', async () => {
    WorkerClient.maxWorkers = 2;
    const {workers, client: c} = pool();
    const first = c.build(request());
    const second = c.build(request());
    workers[1].fail();
    await expect(first).rejects.toBeInstanceOf(WorkerFailedError);
    await expect(second).rejects.toBeInstanceOf(WorkerFailedError);
    expect(workers.map((w) => w.terminated)).toEqual([true, true]);
    expect(c.onMainThread).toBe(true);
    const response = await c.build(request());
    expect(Array.from(response.points!.instances)).toEqual([0, 0, 5, 0.5, 0.5, 6]);
  });
});

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
