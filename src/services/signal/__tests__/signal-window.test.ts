import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createMockCtx } from '@/__tests__/helpers';
import { SignalState } from '@/services/signal/signal-state';
import { SignalQueue } from '@/services/signal/signal-queue';
import type { ControllerSignal } from '@/types/index';
import type { SystemContext } from '@/infra/system-context';

/** Build a ctx whose config carries a small signal window. */
function ctxWithWindow(sessionDir: string, windowSize: number): SystemContext {
  return createMockCtx({
    sessionDir,
    config: { signalWindowSize: windowSize } as any,
  } as any);
}

describe('SignalQueue window trimming', () => {
  let tempDir: string;
  let ctx: SystemContext;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wayang-test-'));
    ctx = ctxWithWindow(tempDir, 3);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const enqueueInput = (sq: SignalQueue, text: string) =>
    sq.enqueue({ source: 'user', type: 'input', payload: { text } });

  it('should keep all processed signals while under the window size', () => {
    const sq = new SignalQueue(ctx);
    for (let i = 0; i < 3; i++) enqueueInput(sq, `m${i}`);
    sq.dequeueUnread();

    expect(sq.getSnapshot<ControllerSignal[]>('signals')).toHaveLength(3);
  });

  it('should trim processed signals beyond the window size', () => {
    const sq = new SignalQueue(ctx);
    for (let i = 0; i < 6; i++) enqueueInput(sq, `m${i}`);
    sq.dequeueUnread();

    const all = sq.getSnapshot<ControllerSignal[]>('signals');
    expect(all).toHaveLength(3);
    // The newest three survive; the oldest are dropped.
    expect(all.map(s => (s.payload as any).text)).toEqual(['m3', 'm4', 'm5']);
  });

  it('should never drop unread signals, even beyond the window size', () => {
    const sq = new SignalQueue(ctx);
    for (let i = 0; i < 5; i++) enqueueInput(sq, `m${i}`);

    const all = sq.getSnapshot<ControllerSignal[]>('signals');
    expect(all).toHaveLength(5);
    expect(all.every(s => s.status === 'unread')).toBe(true);
  });

  it('should allow total size to exceed the window when unread backlog exists', () => {
    const sq = new SignalQueue(ctx);
    // Three processed signals fill the window.
    for (let i = 0; i < 3; i++) enqueueInput(sq, `old${i}`);
    sq.dequeueUnread();
    // Two more arrive and stay unread.
    enqueueInput(sq, 'new0');
    enqueueInput(sq, 'new1');

    const all = sq.getSnapshot<ControllerSignal[]>('signals');
    expect(all).toHaveLength(5);
    expect(all.filter(s => s.status === 'unread')).toHaveLength(2);
  });

  it('should combine status change and trim into a single snapshot write', () => {
    const sq = new SignalQueue(ctx);
    for (let i = 0; i < 6; i++) enqueueInput(sq, `m${i}`);

    let snapshotWrites = 0;
    sq.subscribe('signals', (e) => {
      if (e.type === 'set') snapshotWrites += 1;
    });

    sq.dequeueUnread();

    // One set for the batch status change + trim, not one per signal.
    expect(snapshotWrites).toBe(1);
  });

  it('should persist the trimmed window and restore it', async () => {
    const sq = new SignalQueue(ctx);
    for (let i = 0; i < 6; i++) enqueueInput(sq, `m${i}`);
    sq.dequeueUnread();

    const state2 = new SignalState(ctx);
    await state2.restore();
    const restored = state2.get<ControllerSignal[]>('signals');
    expect(restored).toHaveLength(3);
    expect(restored.map(s => (s.payload as any).text)).toEqual(['m3', 'm4', 'm5']);
  });

  it('should keep the complete history of trimmed signals in signals.jsonl', () => {
    const sq = new SignalQueue(ctx);
    for (let i = 0; i < 6; i++) enqueueInput(sq, `m${i}`);
    sq.dequeueUnread();

    const state2 = new SignalState(ctx);
    const enqueued = state2.readHistory().filter(e => e.status === 'enqueued');
    expect(enqueued).toHaveLength(6);
    expect(enqueued.map(e => (e.signal!.payload as any).text)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5']);

    // Trimmed-out signal remains queryable from history alone.
    const archived = state2.getArchivedSignal(enqueued[0].signalId);
    expect(archived).not.toBeNull();
    expect(archived!.status).toBe('read');
  });

  it('should never reuse ids after trimming', async () => {
    const sq = new SignalQueue(ctx);
    for (let i = 0; i < 6; i++) enqueueInput(sq, `m${i}`);
    sq.dequeueUnread();

    // Window still holds the last three, all with ids sig-4..sig-6.
    const beforeIds = sq.getSnapshot<ControllerSignal[]>('signals').map(s => s.id);

    // Restore into a fresh queue: the id counter must come from the high-water
    // mark, not from the window contents.
    const restoredQueue = new SignalQueue(ctx);
    await restoredQueue.restore();
    enqueueInput(restoredQueue, 'after-restore');

    const ids = new Set(beforeIds);
    const newSig = restoredQueue.getSnapshot<ControllerSignal[]>('signals').at(-1)!;
    expect(ids.has(newSig.id)).toBe(false);
    expect(newSig.id).toBe('sig-7');
  });

  it('should record read transitions in history for each dequeued signal', () => {
    const sq = new SignalQueue(ctx);
    for (let i = 0; i < 2; i++) enqueueInput(sq, `m${i}`);
    sq.dequeueUnread();

    const state2 = new SignalState(ctx);
    const transitions = state2.readHistory().filter(e => e.status === 'read');
    expect(transitions).toHaveLength(2);
    expect(transitions.every(e => e.from === 'unread')).toBe(true);
  });

  it('should record discarded transitions when progress signals merge', () => {
    const sq = new SignalQueue(ctx);
    sq.enqueue({ source: 'worker', type: 'progress', payload: { workerId: 'w1', taskId: 't1', taskTitle: 'T', message: 'a' } });
    sq.enqueue({ source: 'worker', type: 'progress', payload: { workerId: 'w1', taskId: 't1', taskTitle: 'T', message: 'b' } });

    const state2 = new SignalState(ctx);
    const discarded = state2.readHistory().filter(e => e.status === 'discarded');
    expect(discarded).toHaveLength(1);
    expect(discarded[0].from).toBe('unread');
  });

  it('should write the snapshot file with window and high-water mark', () => {
    const sq = new SignalQueue(ctx);
    enqueueInput(sq, 'm0');

    const raw = JSON.parse(readFileSync(join(tempDir, 'signals.json'), 'utf-8'));
    expect(Array.isArray(raw.signals)).toBe(true);
    expect(raw.idHighWaterMark).toBe(1);
  });

  it('should fall back to the default window size when unconfigured', () => {
    const plainCtx = createMockCtx({ sessionDir: tempDir } as any);
    const sq = new SignalQueue(plainCtx);
    for (let i = 0; i < 5; i++) enqueueInput(sq, `m${i}`);
    sq.dequeueUnread();
    // Default window is far larger than 5, so everything is retained.
    expect(sq.getSnapshot<ControllerSignal[]>('signals')).toHaveLength(5);
  });
});
