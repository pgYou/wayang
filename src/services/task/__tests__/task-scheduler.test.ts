import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TaskScheduler, type SchedulerContext } from '@/services/task/task-scheduler';
import type { TaskPool } from '@/services/task/task-pool';
import type { SignalQueue } from '@/services/signal/signal-queue';
import type { EventBus } from '@/infra/event-bus';
import type { TaskDetail, WorkerResult } from '@/types/index';
import { makeTask } from '@/__tests__/helpers';

// --- Mocks ---

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn(() => mockLogger) };

function createMockTaskPool(runningCount = 0) {
  const pending: TaskDetail[] = [];
  const running: TaskDetail[] = [];

  return {
    hasPending: () => pending.length > 0,
    getRunningCount: () => running.length,
    peekHighestPriority: () => pending[0] ?? null,
    moveToRunning: vi.fn((taskId: string, workerId: string) => {
      const idx = pending.findIndex(t => t.id === taskId);
      if (idx !== -1) {
        const task = pending.splice(idx, 1)[0];
        task.status = 'running';
        task.workerSessionId = workerId;
        running.push(task);
      }
    }),
    complete: vi.fn((taskId: string) => {
      const idx = running.findIndex(t => t.id === taskId);
      if (idx !== -1) running.splice(idx, 1);
    }),
    fail: vi.fn((taskId: string) => {
      const idx = running.findIndex(t => t.id === taskId);
      if (idx !== -1) running.splice(idx, 1);
    }),
    add: (task: TaskDetail) => pending.push(task),
    list: vi.fn(),
    get: vi.fn(),
    _pending: pending,
    _running: running,
  } as unknown as TaskPool;
}

function createMockSignalQueue() {
  return {
    enqueue: vi.fn(),
    dequeueUnread: vi.fn(),
    query: vi.fn(),
    restore: vi.fn(),
  } as unknown as SignalQueue;
}

function createMockEventBus() {
  const handlers = new Map<string, () => void>();
  return {
    on: vi.fn((event: string, handler: () => void) => { handlers.set(event, handler); }),
    emit: vi.fn((event: string) => { handlers.get(event)?.(); }),
    off: vi.fn(),
    _handlers: handlers,
  } as unknown as EventBus;
}

function createMockContext(): SchedulerContext {
  return {
    addActiveWorker: vi.fn(),
    removeActiveWorker: vi.fn(),
    removeWorker: vi.fn(),
  };
}


// --- Tests ---

describe('TaskScheduler', () => {
  let scheduler: TaskScheduler;
  let taskPool: ReturnType<typeof createMockTaskPool>;
  let signalQueue: ReturnType<typeof createMockSignalQueue>;
  let eventBus: ReturnType<typeof createMockEventBus>;
  let ctx: ReturnType<typeof createMockContext>;
  let spawnResults: Map<string, WorkerResult>;
  let spawnErrors: Map<string, Error>;

  beforeEach(() => {
    vi.clearAllMocks();
    taskPool = createMockTaskPool();
    signalQueue = createMockSignalQueue();
    eventBus = createMockEventBus();
    ctx = createMockContext();
    spawnResults = new Map();
    spawnErrors = new Map();

    scheduler = new TaskScheduler(
      mockLogger as any,
      taskPool,
      signalQueue,
      eventBus,
      ctx,
      3, // maxConcurrency
    );

    // Default spawnFn resolves with configured result per task id
    scheduler.setSpawnFn(async (taskWithWorkerId) => {
      if (spawnErrors.has(taskWithWorkerId.id)) throw spawnErrors.get(taskWithWorkerId.id)!;
      return spawnResults.get(taskWithWorkerId.id) ?? { status: 'completed', summary: 'ok' };
    });
  });

  describe('start', () => {
    it('should register task:added event listener', () => {
      scheduler.start();
      expect(eventBus.on).toHaveBeenCalledWith('task:added', expect.any(Function));
    });
  });

  describe('schedule', () => {
    it('should spawn worker for pending task', () => {
      const task = makeTask('t1');
      (taskPool as any).add(task);
      spawnResults.set('t1', { status: 'completed', summary: 'done' });

      scheduler.schedule();

      expect(taskPool.moveToRunning).toHaveBeenCalledWith('t1', expect.stringMatching(/^w-/));
      expect(ctx.addActiveWorker).toHaveBeenCalledWith(expect.objectContaining({
        taskId: 't1',
        taskTitle: 'Task t1',
        workerType: 'puppet',
      }));
    });

    it('should not schedule when no pending tasks', () => {
      scheduler.schedule();
      expect(taskPool.moveToRunning).not.toHaveBeenCalled();
    });

    it('should not schedule when spawnFn is null', () => {
      const schedulerNoSpawn = new TaskScheduler(mockLogger as any, taskPool, signalQueue, eventBus, ctx, 3);
      (taskPool as any).add(makeTask('t1'));

      schedulerNoSpawn.schedule();

      expect(taskPool.moveToRunning).not.toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith('spawnFn not set, cannot schedule task');
    });

    it('should respect maxConcurrency limit', () => {
      // maxConcurrency = 3, add 5 pending tasks
      for (let i = 1; i <= 5; i++) {
        (taskPool as any).add(makeTask(`t${i}`));
        // Don't resolve — keep them running
        spawnResults.set(`t${i}`, new Promise(() => {}) as any);
      }

      scheduler.schedule();

      // Should only spawn 3 (maxConcurrency)
      expect(taskPool.moveToRunning).toHaveBeenCalledTimes(3);
    });

    it('should handle completed worker result', async () => {
      const task = makeTask('t1');
      (taskPool as any).add(task);
      spawnResults.set('t1', { status: 'completed', summary: 'All done' });

      scheduler.schedule();
      // spawnFn is async, wait for resolution
      await vi.waitFor(() => {
        expect(taskPool.complete).toHaveBeenCalledWith('t1', 'All done');
      });

      expect(signalQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
        source: 'worker',
        type: 'completed',
      }));
      expect(ctx.removeActiveWorker).toHaveBeenCalled();
      expect(ctx.removeWorker).toHaveBeenCalled();
    });

    it('should handle failed worker result', async () => {
      const task = makeTask('t1');
      (taskPool as any).add(task);
      spawnResults.set('t1', { status: 'failed', error: 'Something broke' });

      scheduler.schedule();
      await vi.waitFor(() => {
        expect(taskPool.fail).toHaveBeenCalledWith('t1', 'Something broke');
      });

      expect(signalQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
        source: 'worker',
        type: 'failed',
      }));
    });

    it('should handle spawn error', async () => {
      const task = makeTask('t1');
      (taskPool as any).add(task);
      spawnErrors.set('t1', new Error('LLM rate limit'));

      scheduler.schedule();
      await vi.waitFor(() => {
        expect(taskPool.fail).toHaveBeenCalledWith('t1', expect.stringContaining('LLM rate limit'));
      });

      expect(signalQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
        source: 'worker',
        type: 'failed',
      }));
      expect(ctx.removeActiveWorker).toHaveBeenCalled();
      expect(ctx.removeWorker).toHaveBeenCalled();
    });

    it('should re-schedule after worker completes', async () => {
      // 4 tasks, maxConcurrency 3 — after first completes, 4th should start
      for (let i = 1; i <= 4; i++) {
        (taskPool as any).add(makeTask(`t${i}`));
      }
      // t1 resolves quickly, others hang
      spawnResults.set('t1', { status: 'completed', summary: 'ok' });
      for (let i = 2; i <= 4; i++) {
        spawnResults.set(`t${i}`, new Promise(() => {}) as any);
      }

      scheduler.schedule();
      // First batch: 3 tasks
      expect(taskPool.moveToRunning).toHaveBeenCalledTimes(3);

      // Wait for t1 to complete and trigger re-schedule
      await vi.waitFor(() => {
        expect(taskPool.complete).toHaveBeenCalledWith('t1', 'ok');
      });

      // After re-schedule, 4th task should have been spawned
      expect(taskPool.moveToRunning).toHaveBeenCalledTimes(4);
    });

    it('should use workerType from task for addActiveWorker', () => {
      const task = makeTask('t1', { workerType: 'claude-code' });
      (taskPool as any).add(task);
      spawnResults.set('t1', { status: 'completed', summary: 'ok' });

      scheduler.schedule();

      // claude-code doesn't have built-in meta, defaults to label=type, emoji=fallback
      expect(ctx.addActiveWorker).toHaveBeenCalledWith(expect.objectContaining({
        workerType: 'claude-code',
      }));
    });
  });

  describe('event-driven scheduling', () => {
    it('should trigger schedule on task:added event after start', () => {
      scheduler.start();

      // Emit task:added event via the mock event bus
      const handlers = (eventBus as any)._handlers as Map<string, () => void>;
      const handler = handlers.get('task:added');

      // Simulate: add a task then emit the event
      (taskPool as any).add(makeTask('t1'));
      handler?.();

      expect(taskPool.moveToRunning).toHaveBeenCalledWith('t1', expect.any(String));
    });
  });
});
