import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ControllerLoop } from '@/services/controller-loop';
import type { Supervisor } from '@/services/supervisor';

function createMockSupervisor(): any {
  return {
    signalQueue: {
      dequeueUnread: vi.fn().mockReturnValue([]),
      waitForSignal: vi.fn().mockResolvedValue(undefined),
      enqueue: vi.fn(),
    },
    controllerAgent: {
      run: vi.fn().mockImplementation(() => (async function* () {
        yield 'ok';
        return { text: 'ok' };
      })()),
      needsCompaction: vi.fn().mockReturnValue(false),
      state: {
        set: vi.fn(),
        append: vi.fn(),
      },
    },
    engine: {
      getRunningCount: vi.fn().mockReturnValue(0),
      getActiveWorkers: vi.fn().mockReturnValue([]),
      list: vi.fn().mockReturnValue([]),
    },
    ctx: {
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
    },
  };
}

describe('ControllerLoop', () => {
  let supervisor: ReturnType<typeof createMockSupervisor>;

  beforeEach(() => {
    supervisor = createMockSupervisor();
  });

  it('should dequeue signals and execute them', async () => {
    const signals = [{ id: '1', source: 'user', type: 'input', payload: { text: 'hello' } }];
    let callCount = 0;
    supervisor.signalQueue.dequeueUnread.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return signals;
      supervisor.ctx.abortController.abort();
      return [];
    });

    const loop = new ControllerLoop(supervisor as unknown as Supervisor);
    await loop.start();

    expect(supervisor.controllerAgent.run).toHaveBeenCalledWith(signals);
  });

  it('should emit controller:loop-start and controller:loop-end hooks', async () => {
    const emitted: Array<{ hook: string; payload: any }> = [];
    supervisor.ctx.hooks.on.mockImplementation((hook: string, fn: any) => {
      return () => {};
    });
    supervisor.ctx.hooks.emit.mockImplementation((hook: string, payload: any) => {
      emitted.push({ hook, payload });
    });

    const signals = [{ id: '1', source: 'user', type: 'input', payload: { text: 'hello' } }];
    let callCount = 0;
    supervisor.signalQueue.dequeueUnread.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return signals;
      supervisor.ctx.abortController.abort();
      return [];
    });

    const loop = new ControllerLoop(supervisor as unknown as Supervisor);
    await loop.start();

    expect(emitted.some(e => e.hook === 'controller:loop-start')).toBe(true);
    expect(emitted.some(e => e.hook === 'controller:loop-end')).toBe(true);
  });

  it('should subscribe to hooks on start', async () => {
    supervisor.signalQueue.waitForSignal.mockImplementation(async () => {
      supervisor.ctx.abortController.abort();
    });

    const loop = new ControllerLoop(supervisor as unknown as Supervisor);
    await loop.start();

    expect(supervisor.ctx.hooks.on).toHaveBeenCalledWith('controller:loop-end', expect.any(Function));
    expect(supervisor.ctx.hooks.on).toHaveBeenCalledWith('signal:enqueued', expect.any(Function));
  });

  it('should wait for signals when queue is empty', async () => {
    let waitCount = 0;
    supervisor.signalQueue.waitForSignal.mockImplementation(async () => {
      waitCount++;
      if (waitCount >= 2) {
        supervisor.ctx.abortController.abort();
      }
    });

    const loop = new ControllerLoop(supervisor as unknown as Supervisor);
    await loop.start();

    expect(supervisor.signalQueue.waitForSignal).toHaveBeenCalled();
  });

  it('should stop when aborted during waitForSignal', async () => {
    supervisor.signalQueue.waitForSignal.mockImplementation(async () => {
      supervisor.ctx.abortController.abort();
    });

    const loop = new ControllerLoop(supervisor as unknown as Supervisor);
    await loop.start();

    expect(supervisor.ctx.abortController.signal.aborted).toBe(true);
  });

  it('should handle errors and continue loop', async () => {
    let dequeueCount = 0;
    supervisor.signalQueue.dequeueUnread.mockImplementation(() => {
      dequeueCount++;
      if (dequeueCount === 1) throw new Error('test error');
      supervisor.ctx.abortController.abort();
      return [];
    });

    const loop = new ControllerLoop(supervisor as unknown as Supervisor);
    await loop.start();

    expect(supervisor.ctx.logger.error).toHaveBeenCalled();
  });

  it('should break on error if aborted', async () => {
    supervisor.signalQueue.dequeueUnread.mockImplementation(() => {
      supervisor.ctx.abortController.abort();
      throw new Error('test error');
    });

    const loop = new ControllerLoop(supervisor as unknown as Supervisor);
    await loop.start();

    expect(supervisor.ctx.logger.error).not.toHaveBeenCalled();
  });
});

describe('ControllerLoop heartbeat', () => {
  let supervisor: ReturnType<typeof createMockSupervisor>;
  let idleHandler: ((payload: { lastWakeAt: number }) => void) | null;
  let signalEnqueuedHandler: (() => void) | null;

  beforeEach(() => {
    vi.useFakeTimers();
    supervisor = createMockSupervisor();
    idleHandler = null;
    signalEnqueuedHandler = null;

    supervisor.ctx.hooks.on.mockImplementation((hook: string, fn: any) => {
      if (hook === 'controller:loop-end') idleHandler = fn;
      if (hook === 'signal:enqueued') signalEnqueuedHandler = fn;
      return () => {};
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function createAndStartLoop(opts?: { heartbeatIntervalMs?: number }) {
    supervisor.signalQueue.waitForSignal.mockImplementation(async () => {
      supervisor.ctx.abortController.abort();
    });
    const loop = new ControllerLoop(supervisor as unknown as Supervisor, opts);
    await loop.start();
    return loop;
  }

  it('should inject heartbeat after idle interval when workers are running', async () => {
    supervisor.engine.getRunningCount.mockReturnValue(1);
    supervisor.engine.getActiveWorkers.mockReturnValue([
      { workerId: 'w1', taskId: 't1', taskTitle: 'Test', workerType: 'puppet', startedAt: Date.now() - 5000 },
    ]);

    await createAndStartLoop({ heartbeatIntervalMs: 10_000 });

    idleHandler!({ lastWakeAt: Date.now() });

    expect(supervisor.signalQueue.enqueue).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);

    expect(supervisor.signalQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'system', type: 'heartbeat' }),
    );
  });

  it('should NOT inject heartbeat when no workers are running', async () => {
    supervisor.engine.getRunningCount.mockReturnValue(0);

    await createAndStartLoop({ heartbeatIntervalMs: 10_000 });
    idleHandler!({ lastWakeAt: Date.now() });
    vi.advanceTimersByTime(30_000);

    expect(supervisor.signalQueue.enqueue).not.toHaveBeenCalled();
  });

  it('should reset timer when signal:enqueued fires', async () => {
    supervisor.engine.getRunningCount.mockReturnValue(1);
    supervisor.engine.getActiveWorkers.mockReturnValue([
      { workerId: 'w1', taskId: 't1', taskTitle: 'Test', workerType: 'puppet', startedAt: Date.now() },
    ]);

    await createAndStartLoop({ heartbeatIntervalMs: 30_000 });
    idleHandler!({ lastWakeAt: Date.now() });

    vi.advanceTimersByTime(20_000);
    signalEnqueuedHandler!();

    vi.advanceTimersByTime(10_000);
    expect(supervisor.signalQueue.enqueue).not.toHaveBeenCalled();
  });

  it('should clean up timer on shutdown', async () => {
    supervisor.engine.getRunningCount.mockReturnValue(1);
    supervisor.engine.getActiveWorkers.mockReturnValue([
      { workerId: 'w1', taskId: 't1', taskTitle: 'Test', workerType: 'puppet', startedAt: Date.now() },
    ]);

    const loop = await createAndStartLoop({ heartbeatIntervalMs: 10_000 });
    idleHandler!({ lastWakeAt: Date.now() });
    loop.shutdown();

    vi.advanceTimersByTime(30_000);
    expect(supervisor.signalQueue.enqueue).not.toHaveBeenCalled();
  });

  it('should include worker details in heartbeat payload', async () => {
    const startedAt = Date.now() - 15_000;
    supervisor.engine.getRunningCount.mockReturnValue(1);
    supervisor.engine.list.mockReturnValue([{ id: 'p1' }, { id: 'p2' }]);
    supervisor.engine.getActiveWorkers.mockReturnValue([
      { workerId: 'w1', taskId: 't1', taskTitle: 'Write code', workerType: 'puppet', startedAt },
    ]);

    await createAndStartLoop({ heartbeatIntervalMs: 10_000 });
    idleHandler!({ lastWakeAt: Date.now() });
    vi.advanceTimersByTime(10_000);

    const call = supervisor.signalQueue.enqueue.mock.calls[0][0];
    expect(call.payload.workers).toHaveLength(1);
    expect(call.payload.workers[0].taskTitle).toBe('Write code');
    expect(call.payload.workers[0].workerType).toBe('puppet');
    expect(call.payload.pendingTaskCount).toBe(2);
    expect(call.payload.idleSinceMs).toBeGreaterThanOrEqual(10_000);
  });
});
