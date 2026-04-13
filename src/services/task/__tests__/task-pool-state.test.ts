import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createLogger } from '@/infra/logger';
import { TaskPoolState } from '@/services/task/task-pool-state';
import type { TaskDetail } from '@/types/index';
import { makeTask } from '@/__tests__/helpers';

describe('TaskPoolState', () => {
  let tempDir: string;
  let state: TaskPoolState;
  const logger = createLogger('silent');

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wayang-test-'));
    state = new TaskPoolState(tempDir, logger);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });


  it('should initialize with empty task lists', () => {
    expect(state.get('tasks.pending')).toEqual([]);
    expect(state.get('tasks.running')).toEqual([]);
    expect(state.get('tasks.history')).toEqual([]);
  });

  it('should append pending tasks', () => {
    state.append('tasks.pending', makeTask('t1'));
    state.append('tasks.pending', makeTask('t2'));
    expect(state.get('tasks.pending')).toHaveLength(2);
  });

  it('should move task from pending to running', () => {
    state.append('tasks.pending', makeTask('t1'));
    const task = state.get('tasks.pending') as TaskDetail[];
    const t = task[0];
    t.status = 'running';
    state.remove('tasks.pending', 0);
    state.append('tasks.running', t);
    expect(state.get('tasks.pending')).toHaveLength(0);
    expect(state.get('tasks.running')).toHaveLength(1);
  });

  it('should persist tasks.json on mutation', async () => {
    state.append('tasks.pending', makeTask('t1'));

    const state2 = new TaskPoolState(tempDir, logger);
    await state2.restore();
    expect(state2.get('tasks.pending')).toHaveLength(1);
  });

  it('should restore all task lists', async () => {
    const task = makeTask('t1');
    state.append('tasks.pending', task);
    state.append('tasks.running', makeTask('t2', { status: 'running' }));
    state.append('tasks.history', makeTask('t3', { status: 'completed' }));

    const state2 = new TaskPoolState(tempDir, logger);
    await state2.restore();
    expect(state2.get('tasks.pending')).toHaveLength(1);
    expect(state2.get('tasks.running')).toHaveLength(1);
    expect(state2.get('tasks.history')).toHaveLength(1);
  });
});
