import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ControllerLoop, type HeartbeatProvider } from '@/services/controller-loop';

function createMocks() {
  const signalQueue = {
    dequeueUnread: vi.fn().mockReturnValue([]),
    waitForSignal: vi.fn().mockResolvedValue(undefined),
    enqueue: vi.fn(),
  };
  const controllerAgent = {
    run: vi.fn().mockImplementation(() => (async function* () {
      yield 'ok';
      return { text: 'ok' };
    })()),
    needsCompaction: vi.fn().mockReturnValue(false),
    state: {
      set: vi.fn(),
      append: vi.fn(),
    },
  };
  const heartbeat: HeartbeatProvider = {
    getRunningCount: vi.fn().mockReturnValue(0),
    getActiveWorkers: vi.fn().mockReturnValue([]),
    getPendingCount: vi.fn().mockReturnValue(0),
  };
  const ctx = {
    abortController: new AbortController(),
    hooks: {
      on: vi.fn().mockReturnValue(() => {}),
      emit: vi.fn(),
    },
    logger: {
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    },
  };
  return { signalQueue, controllerAgent, heartbeat, ctx };
}

function createLoop(mocks: ReturnType<typeof createMocks>, opts?: { heartbeatIntervalMs?: number }) {
  return new ControllerLoop(
    mocks.ctx as any,
    mocks.signalQueue as any,
    mocks.controllerAgent as any,
    mocks.heartbeat,
    opts,
  );
}

describe('ControllerLoop', () => {
  let mocks: ReturnType<typeof createMocks>;

  beforeEach(() => {
    mocks = createMocks();
  });

  it('should dequeue signals and execute them', async () => {
    const signals = [{ id: '1', source: 'user', type: 'input', payload: { text: 'hello' } }];
    let callCount = 0;
    mocks.signalQueue.dequeueUnread.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return signals;
      mocks.ctx.abortController.abort();
      return [];
    });

    await createLoop(mocks).start();
    expect(mocks.controllerAgent.run).toHaveBeenCalledWith(signals);
  });

  it('should emit controller:loop-start and controller:loop-end hooks', async () => {
    const emitted: Array<{ hook: string; payload: any }> = [];
    mocks.ctx.hooks.on.mockImplementation((_hook: string) => () => {});
    mocks.ctx.hooks.emit.mockImplementation((hook: string, payload: any) => {
      emitted.push({ hook, payload });
    });

    const signals = [{ id: '1', source: 'user', type: 'input', payload: { text: 'hello' } }];
    let callCount = 0;
    mocks.signalQueue.dequeueUnread.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return signals;
      mocks.ctx.abortController.abort();
      return [];
    });

    await createLoop(mocks).start();
    expect(emitted.some(e => e.hook === 'controller:loop-start')).toBe(true);
    expect(emitted.some(e => e.hook === 'controller:loop-end')).toBe(true);
  });

  it('should subscribe to hooks on start', async () => {
    mocks.signalQueue.waitForSignal.mockImplementation(async () => {
      mocks.ctx.abortController.abort();
    });

    await createLoop(mocks).start();
    expect(mocks.ctx.hooks.on).toHaveBeenCalledWith('controller:loop-end', expect.any(Function));
    expect(mocks.ctx.hooks.on).toHaveBeenCalledWith('signal:enqueued', expect.any(Function));
  });

  it('should wait for signals when queue is empty', async () => {
    let waitCount = 0;
    mocks.signalQueue.waitForSignal.mockImplementation(async () => {
      waitCount++;
      if (waitCount >= 2) mocks.ctx.abortController.abort();
    });

    await createLoop(mocks).start();
    expect(mocks.signalQueue.waitForSignal).toHaveBeenCalled();
  });

  it('should stop when aborted during waitForSignal', async () => {
    mocks.signalQueue.waitForSignal.mockImplementation(async () => {
      mocks.ctx.abortController.abort();
    });

    await createLoop(mocks).start();
    expect(mocks.ctx.abortController.signal.aborted).toBe(true);
  });

  it('should handle errors and continue loop', async () => {
    let dequeueCount = 0;
    mocks.signalQueue.dequeueUnread.mockImplementation(() => {
      dequeueCount++;
      if (dequeueCount === 1) throw new Error('test error');
      mocks.ctx.abortController.abort();
      return [];
    });

    await createLoop(mocks).start();
    expect(mocks.ctx.logger.error).toHaveBeenCalled();
  });

  it('should break on error if aborted', async () => {
    mocks.signalQueue.dequeueUnread.mockImplementation(() => {
      mocks.ctx.abortController.abort();
      throw new Error('test error');
    });

    await createLoop(mocks).start();
    expect(mocks.ctx.logger.error).not.toHaveBeenCalled();
  });
});

describe('ControllerLoop heartbeat', () => {
  let mocks: ReturnType<typeof createMocks>;
  let idleHandler: ((payload: { lastWakeAt: number }) => void) | null;
  let signalEnqueuedHandler: (() => void) | null;

  beforeEach(() => {
    vi.useFakeTimers();
    mocks = createMocks();
    idleHandler = null;
    signalEnqueuedHandler = null;

    mocks.ctx.hooks.on.mockImplementation((hook: string, fn: any) => {
      if (hook === 'controller:loop-end') idleHandler = fn;
      if (hook === 'signal:enqueued') signalEnqueuedHandler = fn;
      return () => {};
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function startLoop(opts?: { heartbeatIntervalMs?: number }) {
    mocks.signalQueue.waitForSignal.mockImplementation(async () => {
      mocks.ctx.abortController.abort();
    });
    const loop = createLoop(mocks, opts);
    await loop.start();
    return loop;
  }

  it('should inject heartbeat after idle interval when workers are running', async () => {
    vi.mocked(mocks.heartbeat.getRunningCount).mockReturnValue(1);
    vi.mocked(mocks.heartbeat.getActiveWorkers).mockReturnValue([
      { workerId: 'w1', taskId: 't1', taskTitle: 'Test', workerType: 'puppet', startedAt: Date.now() - 5000, emoji: '🧸' },
    ]);

    await startLoop({ heartbeatIntervalMs: 10_000 });
    idleHandler!({ lastWakeAt: Date.now() });

    expect(mocks.signalQueue.enqueue).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(mocks.signalQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'system', type: 'heartbeat' }),
    );
  });

  it('should NOT inject heartbeat when no workers are running', async () => {
    vi.mocked(mocks.heartbeat.getRunningCount).mockReturnValue(0);

    await startLoop({ heartbeatIntervalMs: 10_000 });
    idleHandler!({ lastWakeAt: Date.now() });
    vi.advanceTimersByTime(30_000);

    expect(mocks.signalQueue.enqueue).not.toHaveBeenCalled();
  });

  it('should reset timer when signal:enqueued fires', async () => {
    vi.mocked(mocks.heartbeat.getRunningCount).mockReturnValue(1);
    vi.mocked(mocks.heartbeat.getActiveWorkers).mockReturnValue([
      { workerId: 'w1', taskId: 't1', taskTitle: 'Test', workerType: 'puppet', startedAt: Date.now(), emoji: '🧸' },
    ]);

    await startLoop({ heartbeatIntervalMs: 30_000 });
    idleHandler!({ lastWakeAt: Date.now() });

    vi.advanceTimersByTime(20_000);
    signalEnqueuedHandler!();

    vi.advanceTimersByTime(10_000);
    expect(mocks.signalQueue.enqueue).not.toHaveBeenCalled();
  });

  it('should clean up timer on shutdown', async () => {
    vi.mocked(mocks.heartbeat.getRunningCount).mockReturnValue(1);
    vi.mocked(mocks.heartbeat.getActiveWorkers).mockReturnValue([
      { workerId: 'w1', taskId: 't1', taskTitle: 'Test', workerType: 'puppet', startedAt: Date.now(), emoji: '🧸' },
    ]);

    const loop = await startLoop({ heartbeatIntervalMs: 10_000 });
    idleHandler!({ lastWakeAt: Date.now() });
    loop.shutdown();

    vi.advanceTimersByTime(30_000);
    expect(mocks.signalQueue.enqueue).not.toHaveBeenCalled();
  });

  it('should include worker details in heartbeat payload', async () => {
    const startedAt = Date.now() - 15_000;
    vi.mocked(mocks.heartbeat.getRunningCount).mockReturnValue(1);
    vi.mocked(mocks.heartbeat.getPendingCount).mockReturnValue(2);
    vi.mocked(mocks.heartbeat.getActiveWorkers).mockReturnValue([
      { workerId: 'w1', taskId: 't1', taskTitle: 'Write code', workerType: 'puppet', startedAt, emoji: '🧸' },
    ]);

    await startLoop({ heartbeatIntervalMs: 10_000 });
    idleHandler!({ lastWakeAt: Date.now() });
    vi.advanceTimersByTime(10_000);

    const call = mocks.signalQueue.enqueue.mock.calls[0][0];
    expect(call.payload.workers).toHaveLength(1);
    expect(call.payload.workers[0].taskTitle).toBe('Write code');
    expect(call.payload.workers[0].workerType).toBe('puppet');
    expect(call.payload.pendingTaskCount).toBe(2);
    expect(call.payload.idleSinceMs).toBeGreaterThanOrEqual(10_000);
  });
});
