import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createMockCtx } from '@/__tests__/helpers';
import { SignalState } from '@/services/signal/signal-state';
import { SignalQueue } from '@/services/signal/signal-queue';
import type { ControllerSignal, InputSignalPayload, ProgressSignalPayload } from '@/types/index';
import type { SystemContext } from '@/infra/system-context';

describe('SignalQueue', () => {
  let tempDir: string;
  let sq: SignalQueue;
  let ctx: SystemContext;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wayang-test-'));
    ctx = createMockCtx({ sessionDir: tempDir } as any);
    sq = new SignalQueue(ctx);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should enqueue and dequeue signals', () => {
    sq.enqueue({
      source: 'user',
      type: 'input',
      payload: { text: 'hello' },
    });

    const unread = sq.dequeueUnread();
    expect(unread).toHaveLength(1);
    expect((unread[0].payload as InputSignalPayload).text).toBe('hello');
  });

  it('should mark dequeued signals as read via state API', () => {
    const events: string[] = [];
    sq.subscribe('signals', (e: any) => events.push(e.type));

    sq.enqueue({
      source: 'user',
      type: 'input',
      payload: { text: 'hello' },
    });

    expect(events).toContain('append'); // enqueue triggers append

    sq.dequeueUnread();
    // dequeue triggers set via state.set()
    expect(events).toContain('set');
  });

  it('should not return already-read signals', () => {
    sq.enqueue({
      source: 'user',
      type: 'input',
      payload: { text: 'hello' },
    });

    sq.dequeueUnread();
    expect(sq.dequeueUnread()).toHaveLength(0);
  });

  it('should merge progress signals from same worker', () => {
    sq.enqueue({
      source: 'worker',
      type: 'progress',
      payload: { workerId: 'w1', taskId: 't1', taskTitle: 'Task 1', message: 'step 1' },
    });
    sq.enqueue({
      source: 'worker',
      type: 'progress',
      payload: { workerId: 'w1', taskId: 't1', taskTitle: 'Task 1', message: 'step 2' },
    });
    sq.enqueue({
      source: 'worker',
      type: 'progress',
      payload: { workerId: 'w2', taskId: 't2', taskTitle: 'Task 2', message: 'other' },
    });

    // w1 step1 discarded, w1 step2 + w2 kept = 2 unread
    const unread = sq.dequeueUnread();
    expect(unread).toHaveLength(2);

    const all = sq.getSnapshot<ControllerSignal[]>('signals');
    const discarded = all.filter(s => s.status === 'discarded');
    expect(discarded).toHaveLength(1);
    expect((discarded[0].payload as ProgressSignalPayload).message).toBe('step 1');
  });

  it('should trigger state notification on progress merge', () => {
    const events: string[] = [];
    sq.subscribe('signals', (e: any) => events.push(e.type));

    sq.enqueue({
      source: 'worker',
      type: 'progress',
      payload: { workerId: 'w1', taskId: 't1', taskTitle: 'Task 1', message: 'step 1' },
    });
    sq.enqueue({
      source: 'worker',
      type: 'progress',
      payload: { workerId: 'w1', taskId: 't1', taskTitle: 'Task 1', message: 'step 2' },
    });

    // First enqueue: append
    // Second enqueue: set (merge) + append
    expect(events).toContain('append');
    expect(events).toContain('set');
  });

  it('should not merge non-progress signals', () => {
    sq.enqueue({
      source: 'worker',
      type: 'completed',
      payload: { taskId: 't1', workerId: 'w1', taskTitle: 'Task 1' },
    });
    sq.enqueue({
      source: 'worker',
      type: 'completed',
      payload: { taskId: 't2', workerId: 'w1', taskTitle: 'Task 2' },
    });

    const unread = sq.dequeueUnread();
    expect(unread).toHaveLength(2);
  });

  it('should resolve waitForSignal immediately if signals exist', async () => {
    sq.enqueue({
      source: 'user',
      type: 'input',
      payload: { text: 'test' },
    });

    await expect(sq.waitForSignal()).resolves.toBeUndefined();
  });

  it('should resolve waitForSignal when signal arrives', async () => {
    const promise = sq.waitForSignal();

    setTimeout(() => {
      sq.enqueue({
        source: 'user',
        type: 'input',
        payload: { text: 'delayed' },
      });
    }, 10);

    await expect(promise).resolves.toBeUndefined();
  });

  it('should persist signals', async () => {
    sq.enqueue({
      source: 'user',
      type: 'input',
      payload: { text: 'persist me' },
    });

    const state2 = new SignalState(ctx);
    await state2.restore();
    const restored = state2.get<ControllerSignal[]>('signals');
    expect(restored).toHaveLength(1);
    expect((restored[0].payload as InputSignalPayload).text).toBe('persist me');
  });

  // --- query() tests ---

  it('should query all signals when no filter provided', () => {
    sq.enqueue({ source: 'user', type: 'input', payload: { text: 'msg1' } });
    sq.enqueue({ source: 'worker', type: 'progress', payload: { workerId: 'w1', taskId: 't1', taskTitle: 'Task 1', message: 'p1' } });
    sq.enqueue({ source: 'worker', type: 'completed', payload: { taskId: 't1', workerId: 'w1', taskTitle: 'Task 1' } });

    const result = sq.query({});
    expect(result).toHaveLength(3);
  });

  it('should query signals by status', () => {
    sq.enqueue({ source: 'user', type: 'input', payload: { text: 'msg1' } });
    sq.enqueue({ source: 'worker', type: 'progress', payload: { workerId: 'w1', taskId: 't1', taskTitle: 'Task 1', message: 'p1' } });
    sq.enqueue({ source: 'worker', type: 'completed', payload: { taskId: 't1', workerId: 'w1', taskTitle: 'Task 1' } });

    // All signals start as 'unread'
    const unread = sq.query({ status: 'unread' });
    expect(unread).toHaveLength(3);

    // Mark all as read
    sq.dequeueUnread();

    const read = sq.query({ status: 'read' });
    expect(read).toHaveLength(3);
    expect(read.every(s => s.status === 'read')).toBe(true);
  });

  it('should query signals by source', () => {
    sq.enqueue({ source: 'user', type: 'input', payload: { text: 'msg1' } });
    sq.enqueue({ source: 'user', type: 'input', payload: { text: 'msg2' } });
    sq.enqueue({ source: 'worker', type: 'progress', payload: { workerId: 'w1', taskId: 't1', taskTitle: 'Task 1', message: 'p1' } });
    sq.enqueue({ source: 'worker', type: 'completed', payload: { taskId: 't1', workerId: 'w1', taskTitle: 'Task 1' } });
    sq.enqueue({ source: 'system', type: 'failed', payload: { taskId: 't2', workerId: 'w2', taskTitle: 'Task 2', error: 'oops' } });

    const userSigs = sq.query({ source: 'user' });
    expect(userSigs).toHaveLength(2);

    const workerSigs = sq.query({ source: 'worker' });
    expect(workerSigs).toHaveLength(2);

    const systemSigs = sq.query({ source: 'system' });
    expect(systemSigs).toHaveLength(1);
  });

  it('should query signals by type', () => {
    sq.enqueue({ source: 'user', type: 'input', payload: { text: 'msg1' } });
    sq.enqueue({ source: 'worker', type: 'progress', payload: { workerId: 'w1', taskId: 't1', taskTitle: 'Task 1', message: 'p1' } });
    sq.enqueue({ source: 'worker', type: 'progress', payload: { workerId: 'w2', taskId: 't2', taskTitle: 'Task 2', message: 'p2' } });
    sq.enqueue({ source: 'worker', type: 'completed', payload: { taskId: 't1', workerId: 'w1', taskTitle: 'Task 1' } });
    sq.enqueue({ source: 'worker', type: 'failed', payload: { taskId: 't2', workerId: 'w2', taskTitle: 'Task 2', error: 'oops' } });

    const inputSigs = sq.query({ type: 'input' });
    expect(inputSigs).toHaveLength(1);

    const progressSigs = sq.query({ type: 'progress' });
    expect(progressSigs).toHaveLength(2);

    const completedSigs = sq.query({ type: 'completed' });
    expect(completedSigs).toHaveLength(1);
  });

  it('should query signals with multiple filters', () => {
    sq.enqueue({ source: 'user', type: 'input', payload: { text: 'msg1' } });
    sq.enqueue({ source: 'worker', type: 'progress', payload: { workerId: 'w1', taskId: 't1', taskTitle: 'Task 1', message: 'p1' } });
    sq.enqueue({ source: 'worker', type: 'completed', payload: { taskId: 't1', workerId: 'w1', taskTitle: 'Task 1' } });

    // All signals start as 'unread'
    const unreadWorker = sq.query({ source: 'worker', status: 'unread' });
    expect(unreadWorker).toHaveLength(2);
    expect(unreadWorker.every(s => s.source === 'worker')).toBe(true);
    expect(unreadWorker.every(s => s.status === 'unread')).toBe(true);

    // Filter by source and type
    const workerProgress = sq.query({ source: 'worker', type: 'progress' });
    expect(workerProgress).toHaveLength(1);
    expect(workerProgress[0].type).toBe('progress');

    // Filter by source and status after marking as read
    sq.dequeueUnread();
    const readWorker = sq.query({ source: 'worker', status: 'read' });
    expect(readWorker).toHaveLength(2);
  });

  it('should not modify state when querying', () => {
    sq.enqueue({ source: 'user', type: 'input', payload: { text: 'msg1' } });

    const beforeState = sq.getSnapshot<ControllerSignal[]>('signals');
    const result = sq.query({ status: 'unread' });
    const afterState = sq.getSnapshot<ControllerSignal[]>('signals');

    expect(result).toHaveLength(1);
    expect(beforeState).toEqual(afterState);
  });

  it('should include discarded signals in query results', () => {
    sq.enqueue({
      source: 'worker',
      type: 'progress',
      payload: { workerId: 'w1', taskId: 't1', taskTitle: 'Task 1', message: 'step 1' },
    });
    sq.enqueue({
      source: 'worker',
      type: 'progress',
      payload: { workerId: 'w1', taskId: 't1', taskTitle: 'Task 1', message: 'step 2' },
    });

    const discarded = sq.query({ status: 'discarded' });
    expect(discarded).toHaveLength(1);
    expect((discarded[0].payload as ProgressSignalPayload).message).toBe('step 1');
  });
});
