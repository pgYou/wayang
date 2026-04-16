import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createMockCtx } from '@/__tests__/helpers';
import { ControllerAgentState } from '@/services/agents/controller-state';
import type { SystemContext } from '@/infra/system-context';

describe('ControllerAgentState', () => {
  let tempDir: string;
  let state: ControllerAgentState;
  let ctx: SystemContext;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wayang-test-'));
    ctx = createMockCtx({ sessionDir: tempDir } as any);
    state = new ControllerAgentState(ctx);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should initialize with default data', () => {
    const runtime = state.get('runtimeState');
    expect(runtime.notebook).toBe('');
    expect(runtime.pendingInquiry).toBeNull();
    expect(state.get('conversation')).toEqual([]);
    expect(state.get('compactSummary')).toBeNull();
  });

  it('should set runtime state', () => {
    state.set('runtimeState.session', { id: 's1', startedAt: 1000 });
    expect(state.get('runtimeState.session')).toEqual({ id: 's1', startedAt: 1000 });
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
    const fs = require('fs');
    const content = fs.readFileSync(join(tempDir, 'conversation.jsonl'), 'utf-8');
    expect(content).toContain('hello');
  });

  it('should restore from disk', async () => {
    state.set('runtimeState.session', { id: 's1', startedAt: 1000 });

    const state2 = new ControllerAgentState(ctx);
    await state2.restore();

    expect(state2.get('runtimeState.session')).toEqual({ id: 's1', startedAt: 1000 });
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

    const state2 = new ControllerAgentState(ctx);
    await state2.restore();

    expect(state2.get('conversation')).toHaveLength(1);
    expect((state2.get('conversation') as any[])[0].message.content).toBe('hello');
  });
});
