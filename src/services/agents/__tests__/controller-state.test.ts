import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createLogger } from '@/infra/logger';
import { ControllerAgentState } from '@/services/agents/controller-state';

describe('ControllerAgentState', () => {
  let tempDir: string;
  let state: ControllerAgentState;
  const logger = createLogger('silent');

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wayang-test-'));
    state = new ControllerAgentState(tempDir, logger);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should initialize with default data', () => {
    const runtime = state.get('runtimeState');
    expect(runtime.activeWorkers).toEqual([]);
    expect(runtime.maxConcurrency).toBe(3);
    expect(state.get('conversation')).toEqual([]);
    expect(state.get('compactSummary')).toBeNull();
  });

  it('should set runtime state', () => {
    state.set('runtimeState.session', { id: 's1', startedAt: 1000 });
    expect(state.get('runtimeState.session')).toEqual({ id: 's1', startedAt: 1000 });
  });

  it('should append active workers', () => {
    state.append('runtimeState.activeWorkers', {
      workerId: 'w1',
      taskId: 't1',
      startedAt: Date.now(),
    });
    expect(state.get('runtimeState.activeWorkers')).toHaveLength(1);
    expect(state.get('runtimeState.activeWorkers[0].workerId')).toBe('w1');
    // verify via array directly
    const workers = state.get('runtimeState.activeWorkers') as any[];
    expect(workers[0].workerId).toBe('w1');
  });

  it('should persist conversation entries via append', () => {
    const entry = {
      type: 'user' as const,
      uuid: 'u1',
      parentUuid: null,
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      message: { role: 'user' as const, content: 'hello' },
    };

    state.append('conversation', entry);
    // Read from disk
    const fs = require('fs');
    const content = fs.readFileSync(join(tempDir, 'conversation.jsonl'), 'utf-8');
    expect(content).toContain('hello');
  });

  it('should restore from disk', async () => {
    // Write data
    state.set('runtimeState.session', { id: 's1', startedAt: 1000 });
    state.append('runtimeState.activeWorkers', {
      workerId: 'w1',
      taskId: 't1',
      startedAt: 1000,
    });

    // Create new state instance and restore
    const state2 = new ControllerAgentState(tempDir, logger);
    await state2.restore();

    expect(state2.get('runtimeState.session')).toEqual({ id: 's1', startedAt: 1000 });
    expect(state2.get('runtimeState.activeWorkers')).toHaveLength(1);
  });

  it('should restore conversation entries', async () => {
    state.append('conversation', {
      type: 'user',
      uuid: 'u1',
      parentUuid: null,
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'hello' },
    });

    const state2 = new ControllerAgentState(tempDir, logger);
    await state2.restore();

    expect(state2.get('conversation')).toHaveLength(1);
    expect((state2.get('conversation') as any[])[0].message.content).toBe('hello');
  });
});
