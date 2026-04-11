import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createLogger } from '@/infra/logger';
import { WorkerState } from '@/services/agents/worker-state';

describe('WorkerState', () => {
  let tempDir: string;
  let state: WorkerState;
  const logger = createLogger('silent');
  const workerId = 'w-001';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wayang-test-'));
    state = new WorkerState(tempDir, workerId, logger);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should initialize with worker session id', () => {
    expect(state.get('runtimeState.session.id')).toBe(workerId);
    expect(state.get('conversation')).toEqual([]);
  });

  it('should set task info', () => {
    state.set('runtimeState.task', { id: 't1', description: 'do something' });
    expect(state.get('runtimeState.task.description')).toBe('do something');
  });

  it('should append conversation entries', () => {
    state.append('conversation', {
      type: 'system',
      uuid: 'sys-1',
      parentUuid: null,
      sessionId: workerId,
      timestamp: new Date().toISOString(),
      subtype: 'task_started',
      content: 'Task started',
    });

    expect(state.get('conversation')).toHaveLength(1);
  });

  it('should persist and restore', async () => {
    state.set('runtimeState.task', { id: 't1', description: 'test task' });
    state.append('conversation', {
      type: 'system',
      uuid: 'sys-1',
      parentUuid: null,
      sessionId: workerId,
      timestamp: new Date().toISOString(),
      subtype: 'task_started',
      content: 'Task started',
    });

    const state2 = new WorkerState(tempDir, workerId, logger);
    await state2.restore();

    expect(state2.get('runtimeState.task')).toEqual({ id: 't1', description: 'test task' });
    expect(state2.get('conversation')).toHaveLength(1);
  });

  it('should create worker subdirectory', () => {
    state.set('runtimeState.task', { id: 't1', description: 'test' });
    const fs = require('fs');
    expect(fs.existsSync(join(tempDir, 'workers', workerId, 'runtime-state.json'))).toBe(true);
  });
});
