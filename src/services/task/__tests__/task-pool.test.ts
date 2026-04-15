import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createLogger } from '@/infra/logger';
import { TaskPoolState } from '@/services/task/task-pool-state';
import { LifecycleHooks } from '@/services/lifecycle-hooks';
import { TaskPool } from '@/services/task/task-pool';
import type { TaskDetail } from '@/types/index';
import { makeTask } from '@/__tests__/helpers';

describe('TaskPool', () => {
  let tempDir: string;
  let taskPool: TaskPool;
  let state: TaskPoolState;
  let hooks: LifecycleHooks;
  const logger = createLogger('silent');

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wayang-test-'));
    state = new TaskPoolState(tempDir, logger);
    hooks = new LifecycleHooks();
    taskPool = new TaskPool(state, hooks, logger);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('add', () => {
    it('should add a task to pending', () => {
      taskPool.add(makeTask('t1'));
      expect(taskPool.hasPending()).toBe(true);
      expect(taskPool.list('pending')).toHaveLength(1);
    });

    it('should emit task:added event', () => {
      let emitted = false;
      hooks.on('task:added', () => { emitted = true; });
      taskPool.add(makeTask('t1'));
      expect(emitted).toBe(true);
    });
  });

  describe('get', () => {
    it('should find task by id across all lists', () => {
      taskPool.add(makeTask('t1'));
      expect(taskPool.get('t1')).toBeDefined();
      expect(taskPool.get('t1')!.id).toBe('t1');
    });

    it('should return undefined for missing task', () => {
      expect(taskPool.get('nonexistent')).toBeUndefined();
    });
  });

  describe('moveToRunning', () => {
    it('should move task from pending to running', () => {
      taskPool.add(makeTask('t1'));
      taskPool.moveToRunning('t1', 'w1');
      expect(taskPool.list('pending')).toHaveLength(0);
      expect(taskPool.list('running')).toHaveLength(1);
      expect(taskPool.list('running')[0].workerSessionId).toBe('w1');
      expect(taskPool.list('running')[0].status).toBe('running');
    });
  });

  describe('complete / fail / cancel', () => {
    it('should complete a running task', () => {
      taskPool.add(makeTask('t1'));
      taskPool.moveToRunning('t1', 'w1');
      taskPool.complete('t1', 'done');
      const history = state.get<TaskDetail[]>('tasks.history');
      expect(history).toHaveLength(1);
      expect(history[0].status).toBe('completed');
      expect(history[0].result).toBe('done');
    });

    it('should fail a running task', () => {
      taskPool.add(makeTask('t1'));
      taskPool.moveToRunning('t1', 'w1');
      taskPool.fail('t1', 'error msg');
      const history = state.get<TaskDetail[]>('tasks.history');
      expect(history[0].status).toBe('failed');
      expect(history[0].error).toBe('error msg');
    });

    it('should cancel a running task', () => {
      taskPool.add(makeTask('t1'));
      taskPool.moveToRunning('t1', 'w1');
      taskPool.cancel('t1');
      const history = state.get<TaskDetail[]>('tasks.history');
      expect(history[0].status).toBe('cancelled');
    });

    it('should emit task:completed event', () => {
      let emitted = false;
      hooks.on('task:completed', () => { emitted = true; });
      taskPool.add(makeTask('t1'));
      taskPool.moveToRunning('t1', 'w1');
      taskPool.complete('t1', 'done');
      expect(emitted).toBe(true);
    });
  });

  describe('list', () => {
    it('should list all tasks', () => {
      taskPool.add(makeTask('t1'));
      taskPool.add(makeTask('t2'));
      expect(taskPool.list()).toHaveLength(2);
    });

    it('should list by status', () => {
      taskPool.add(makeTask('t1'));
      taskPool.add(makeTask('t2'));
      taskPool.moveToRunning('t1', 'w1');
      expect(taskPool.list('pending')).toHaveLength(1);
      expect(taskPool.list('running')).toHaveLength(1);
    });
  });

  describe('peekHighestPriority', () => {
    it('should return null when no pending tasks', () => {
      expect(taskPool.peekHighestPriority()).toBeNull();
    });

    it('should peek high priority first without removing', () => {
      taskPool.add(makeTask('t1', { priority: 'normal' }));
      taskPool.add(makeTask('t2', { priority: 'high' }));
      taskPool.add(makeTask('t3', { priority: 'normal' }));

      const peeked = taskPool.peekHighestPriority();
      expect(peeked!.id).toBe('t2');
      // Still in pending — peek does not remove
      expect(taskPool.hasPending()).toBe(true);
    });

    it('should remove from pending via moveToRunning', () => {
      taskPool.add(makeTask('t1'));
      taskPool.moveToRunning('t1', 'w1');
      expect(taskPool.hasPending()).toBe(false);
    });

    it('should peek FIFO when all same priority', () => {
      taskPool.add(makeTask('t1'));
      taskPool.add(makeTask('t2'));
      taskPool.add(makeTask('t3'));
      expect(taskPool.peekHighestPriority()!.id).toBe('t1');
      taskPool.moveToRunning('t1', 'w1');
      expect(taskPool.peekHighestPriority()!.id).toBe('t2');
    });
  });
});
