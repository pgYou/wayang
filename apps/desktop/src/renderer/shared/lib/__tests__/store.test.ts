import { describe, it, expect, vi } from 'vitest';
import { SLICE, type ConnectionStatus, type StateUpdate } from '@/shared/ipc-contract';
import { WayangStore, selectTasks, type SliceStore } from '../store';
import type { TaskDetail } from '@wayang-ai/protocol';

const task = (id: string, status: TaskDetail['status']): TaskDetail =>
  ({ id, status, description: `task ${id}`, priority: 'normal', createdAt: 1 }) as TaskDetail;

describe('SLICE', () => {
  it('subscribes the task history path core actually writes', () => {
    // Core's TaskExecuteEngine appends terminal tasks to `tasks.history`;
    // the old `tasks.completed` slice was a dead path (counter stuck at 0).
    expect(SLICE.tasksHistory).toBe('engine:tasks.history');
    expect(Object.values(SLICE)).not.toContain('engine:tasks.completed');
  });
});

describe('selectTasks', () => {
  it('counts only cleanly completed tasks out of the history slice', () => {
    const s: SliceStore = {
      [SLICE.tasksPending]: [task('p1', 'pending')],
      [SLICE.tasksRunning]: [task('r1', 'running')],
      [SLICE.tasksHistory]: [
        task('c1', 'completed'),
        task('x1', 'failed'),
        task('x2', 'cancelled'),
        task('c2', 'completed'),
      ],
    };
    expect(selectTasks(s)).toEqual({
      pending: [task('p1', 'pending')],
      running: [task('r1', 'running')],
      completed: [task('c1', 'completed'), task('c2', 'completed')],
    });
  });

  it('falls back to empty arrays when no slice has arrived yet', () => {
    expect(selectTasks({})).toEqual({ pending: [], running: [], completed: [] });
  });
});

/* ------------------------------------------------------------------ *
 * WayangStore — boot sequence, buffering, granularity, switch
 * ------------------------------------------------------------------ */

/** Fake bridge: controllable snapshot + manually pushed events. */
class FakeBridge {
  snapshot: { status: ConnectionStatus; slices: Record<string, unknown> } | null = null;
  failNextPulls = 0;
  pullCount = 0;
  private readonly stateListeners = new Set<(update: StateUpdate) => void>();
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();

  getInitialState(): Promise<{ status: ConnectionStatus; slices: Record<string, unknown> }> {
    this.pullCount += 1;
    if (this.failNextPulls > 0) {
      this.failNextPulls -= 1;
      return Promise.reject(new Error('no live server for a snapshot'));
    }
    if (!this.snapshot) return Promise.reject(new Error('no snapshot fixture'));
    return Promise.resolve(this.snapshot);
  }

  onState(callback: (update: StateUpdate) => void): () => void {
    this.stateListeners.add(callback);
    return () => this.stateListeners.delete(callback);
  }

  onStatus(callback: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(callback);
    return () => this.statusListeners.delete(callback);
  }

  pushState(update: StateUpdate): void {
    for (const listener of this.stateListeners) listener(update);
  }

  pushStatus(status: ConnectionStatus): void {
    for (const listener of this.statusListeners) listener(status);
  }
}

const readySnapshot = (slices: Record<string, unknown> = {}): { status: ConnectionStatus; slices: Record<string, unknown> } =>
  ({ status: { phase: 'ready', sessionId: 's-1' }, slices });

const update = (target: string, path: string, data: unknown): StateUpdate => ({ target, path, data });

describe('WayangStore boot sequence', () => {
  it('seeds every slice and the current status from the initial snapshot', async () => {
    const bridge = new FakeBridge();
    bridge.snapshot = readySnapshot({
      [SLICE.conversation]: [{ uuid: 'u1' }],
      [SLICE.busy]: true,
      [SLICE.tasksHistory]: [task('c1', 'completed')],
    });
    const store = new WayangStore(bridge);
    await store.boot();
    expect(store.getSlice(SLICE.conversation)).toEqual([{ uuid: 'u1' }]);
    expect(store.getSlice(SLICE.busy)).toBe(true);
    expect(store.getStatus()).toEqual({ phase: 'ready', sessionId: 's-1' });
    expect(bridge.pullCount).toBe(1);
  });

  it('events arriving during the pull are buffered and replayed after the seed (a4 race closed)', async () => {
    const bridge = new FakeBridge();
    // The snapshot resolves AFTER an event arrived — the buffered value must
    // win over the seeded one, never be lost.
    bridge.snapshot = readySnapshot({ [SLICE.busy]: true });
    const store = new WayangStore(bridge);
    const booting = store.boot();
    // An event fires between subscription attach and the snapshot resolving.
    bridge.pushState(update('controllerAgent', 'dynamicState.busy', false));
    await booting;
    expect(store.getSlice(SLICE.busy)).toBe(false);
    // Live events apply immediately afterwards.
    bridge.pushState(update('controllerAgent', 'dynamicState.busy', true));
    expect(store.getSlice(SLICE.busy)).toBe(true);
  });

  it('a failed pull is retried until it succeeds', async () => {
    const bridge = new FakeBridge();
    bridge.snapshot = readySnapshot({ [SLICE.busy]: true });
    bridge.failNextPulls = 2;
    const store = new WayangStore(bridge);
    const booting = store.boot();
    await vi.waitFor(() => expect(store.getSlice(SLICE.busy)).toBe(true));
    await booting;
    expect(bridge.pullCount).toBeGreaterThanOrEqual(3);
  });

  it('a terminal crashed status aborts the boot loop and surfaces immediately', async () => {
    const bridge = new FakeBridge();
    bridge.snapshot = null; // every pull rejects
    const store = new WayangStore(bridge);
    const booting = store.boot();
    bridge.pushStatus({ phase: 'crashed', detail: 'server gone' });
    await expect(booting).resolves.toBeUndefined();
    expect(store.getStatus()).toEqual({ phase: 'crashed', detail: 'server gone' });
  });
});

describe('WayangStore subscription granularity', () => {
  it('a streaming update notifies only the streaming slice listeners', async () => {
    const bridge = new FakeBridge();
    bridge.snapshot = readySnapshot({});
    const store = new WayangStore(bridge);
    await store.boot();
    const streamingListener = vi.fn();
    const conversationListener = vi.fn();
    const statusListener = vi.fn();
    store.subscribeSlice(SLICE.streaming, streamingListener);
    store.subscribeSlice(SLICE.conversation, conversationListener);
    store.subscribeStatus(statusListener);

    store.applyState(update('controllerAgent', 'dynamicState.streamingEntries', [{ uuid: 'a1' }]));
    expect(streamingListener).toHaveBeenCalledTimes(1);
    expect(conversationListener).not.toHaveBeenCalled();
    expect(statusListener).not.toHaveBeenCalled();

    store.applyStatus({ phase: 'ready', sessionId: 's-1' });
    expect(statusListener).toHaveBeenCalledTimes(1);
    expect(streamingListener).toHaveBeenCalledTimes(1);
  });

  it('unsubscribing stops notifications for that slice', async () => {
    const bridge = new FakeBridge();
    bridge.snapshot = readySnapshot({});
    const store = new WayangStore(bridge);
    await store.boot();
    const listener = vi.fn();
    const unsubscribe = store.subscribeSlice(SLICE.busy, listener);
    store.applyState(update('controllerAgent', 'dynamicState.busy', true));
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.applyState(update('controllerAgent', 'dynamicState.busy', false));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('WayangStore session-switch rehydrate', () => {
  it('clears the old session and seeds the new one via the same snapshot pull', async () => {
    const bridge = new FakeBridge();
    bridge.snapshot = readySnapshot({ [SLICE.conversation]: [{ uuid: 'old-1' }], [SLICE.busy]: true });
    const store = new WayangStore(bridge);
    await store.boot();
    expect(store.getSlice(SLICE.conversation)).toEqual([{ uuid: 'old-1' }]);

    // The switch completed (host ready): point the bridge at the new session.
    bridge.snapshot = readySnapshot({ [SLICE.conversation]: [{ uuid: 'new-1' }], [SLICE.busy]: false });
    bridge.snapshot.status = { phase: 'ready', sessionId: 's-2' };
    await store.rehydrate();
    expect(store.getSlice(SLICE.conversation)).toEqual([{ uuid: 'new-1' }]);
    expect(store.getSlice(SLICE.busy)).toBe(false);
    expect(store.getStatus()).toEqual({ phase: 'ready', sessionId: 's-2' });
    // The old session's value is gone.
    expect(JSON.stringify(store.getSlice(SLICE.conversation))).not.toContain('old-1');
  });

  it('events arriving during the rehydrate pull buffer and replay after the seed', async () => {
    const bridge = new FakeBridge();
    bridge.snapshot = readySnapshot({ [SLICE.busy]: true });
    const store = new WayangStore(bridge);
    await store.boot();
    bridge.snapshot = readySnapshot({ [SLICE.busy]: false });
    const rehydrating = store.rehydrate();
    bridge.pushState(update('controllerAgent', 'dynamicState.busy', true));
    await rehydrating;
    expect(store.getSlice(SLICE.busy)).toBe(true);
  });
});
