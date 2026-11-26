/**
 * Renderer state store 
 *
 * Module-level external singleton Store + React 19 `useSyncExternalStore`
 * per-slice fine-grained subscriptions — a streaming update only re-renders
 * the components subscribed to that slice (the old top-level `useState`
 * aggregate re-rendered the whole list on every `setSlices`).
 *
 * Fixed boot sequence: pull the full snapshot via
 * `wayang:getInitialState`, seed the initial state from it, then apply the
 * incremental `wayang:state` subscription. The first-paint snapshot race
 * (a4 — the server pushes its initial state before the renderer listens)
 * is dissolved architecturally: listeners attach BEFORE the pull and buffer
 * incoming events; the seed applies first, the buffer replays after, so no
 * event is ever lost and the snapshot never overwrites a newer value.
 * `did-finish-load` keeps the main-side full resend as the refresh replay
 * path.
 */

import { useSyncExternalStore } from 'react';
import type {
  ActiveWorkerInfo,
  ContextUsage,
  ConversationEntry,
  ControllerSignal,
  InquireQuestion,
  TaskDetail,
} from '@wayang-ai/protocol';
import { SLICE, sliceKey, type ConnectionStatus, type StateUpdate } from '@/shared/ipc-contract';
import { entryToDisplayItem, signalToDisplayItem, type DisplayItem } from './display';
import { wayang, type BridgeLike } from './wayang-api';

// Single source moved to the shared IPC contract: the slice keys
// here, the main-side subscription table and the snapshot set are one table.
export { SLICE };
export type { StateUpdate };

export type SliceStore = Record<string, unknown>;

/** Delay between snapshot-pull retries while the server boots. */
const SNAPSHOT_RETRY_MS = 250;

/**
 * The external store. One instance lives at module level (`wayangStore`);
 * tests construct their own with a fake bridge.
 */
export class WayangStore {
  private readonly slices = new Map<string, unknown>();
  private status: ConnectionStatus = { phase: 'connecting' };
  private readonly sliceListeners = new Map<string, Set<() => void>>();
  private readonly statusListeners = new Set<() => void>();
  private readonly stateBuffer: StateUpdate[] = [];
  private readonly statusBuffer: ConnectionStatus[] = [];
  /** While true, incoming events buffer instead of applying (boot/pull). */
  private buffering = true;
  private crashed = false;
  private subscribed = false;
  private bootPromise: Promise<void> | null = null;

  constructor(private readonly bridge: BridgeLike) {}

  /* -------- external-store surface (useSyncExternalStore) -------- */

  getSlice = (key: string): unknown => this.slices.get(key);

  subscribeSlice = (key: string, listener: () => void): (() => void) => {
    let set = this.sliceListeners.get(key);
    if (!set) {
      set = new Set();
      this.sliceListeners.set(key, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.sliceListeners.delete(key);
    };
  };

  getStatus = (): ConnectionStatus => this.status;

  subscribeStatus = (listener: () => void): (() => void) => {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  };

  /* -------- event application (live path) -------- */

  applyState(update: StateUpdate): void {
    const key = sliceKey(update.target, update.path);
    this.slices.set(key, update.data);
    this.notifySlice(key);
  }

  /**
   * Drop every slice and notify its subscribers（懒新会话的本地视图重置）：
   * 订阅者收到 undefined 后落各自 fallback（空列表 / false / null），
   * 界面即刻呈现「新会话」空态；真正的 server 会话在首条消息时才创建。
   */
  resetSlices(): void {
    const keys = [...this.slices.keys()];
    this.slices.clear();
    for (const key of keys) this.notifySlice(key);
  }

  applyStatus(status: ConnectionStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener();
  }

  /* -------- boot sequence -------- */

  /** Idempotent: the first call wins, later calls join the same boot. */
  boot(): Promise<void> {
    this.bootPromise ??= this.runBoot();
    return this.bootPromise;
  }

  private async runBoot(): Promise<void> {
    this.attachSubscriptions();
    for (;;) {
      if (this.crashed) return;
      try {
        await this.pullAndSeed();
        return;
      } catch {
        // The server is not ready yet (or is self-healing): retry until it
        // is, or until the terminal `crashed` status aborts the loop.
        await new Promise((resolve) => setTimeout(resolve, SNAPSHOT_RETRY_MS));
      }
    }
  }

  /**
   * Session-switch restore: drop the old session's slices, then run
   * the same snapshot pull + drain sequence for the new session.
   */
  async rehydrate(): Promise<void> {
    this.slices.clear();
    this.buffering = true;
    await this.pullAndSeed();
  }

  /** Snapshot pull → seed → notify → replay the buffered events. */
  private async pullAndSeed(): Promise<void> {
    const snapshot = await this.bridge.getInitialState();
    for (const [key, value] of Object.entries(snapshot.slices)) {
      this.slices.set(key, value);
    }
    this.status = snapshot.status;
    // From here on events apply live; the buffer replays in order AFTER the
    // seed so buffered values converge correctly — see the class doc for
    // the race analysis.
    this.buffering = false;
    for (const key of [...this.slices.keys()]) this.notifySlice(key);
    for (const listener of this.statusListeners) listener();
    for (const status of this.statusBuffer.splice(0)) this.applyStatus(status);
    for (const update of this.stateBuffer.splice(0)) this.applyState(update);
  }

  private attachSubscriptions(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    this.bridge.onState((update) => {
      if (this.buffering) this.stateBuffer.push(update);
      else this.applyState(update);
    });
    this.bridge.onStatus((status) => {
      if (status.phase === 'crashed') {
        // Terminal: surface immediately (even mid-boot) and stop waiting.
        this.crashed = true;
        this.applyStatus(status);
        return;
      }
      if (this.buffering) this.statusBuffer.push(status);
      else this.applyStatus(status);
    });
  }

  private notifySlice(key: string): void {
    for (const listener of this.sliceListeners.get(key) ?? []) listener();
  }
}

/** The module-level singleton; bridge resolved lazily. */
export const wayangStore = new WayangStore({
  onState: (callback) => wayang.onState(callback),
  onStatus: (callback) => wayang.onStatus(callback),
  getInitialState: () => wayang.getInitialState(),
});

/* -------- React bindings (per-slice fine-grained) -------- */

/** Subscribe to one slice; the snapshot is the raw slice value (undefined = not set). */
export function useSliceValue<T>(key: string): T | undefined {
  return useSyncExternalStore(
    (listener: () => void) => wayangStore.subscribeSlice(key, listener),
    () => wayangStore.getSlice(key) as T | undefined,
  );
}

/** Connection status machine. */
export function useConnectionStatus(): ConnectionStatus {
  return useSyncExternalStore(
    (listener: () => void) => wayangStore.subscribeStatus(listener),
    () => wayangStore.getStatus(),
  );
}

export function useConversation(): ConversationEntry[] {
  return useSliceValue<ConversationEntry[]>(SLICE.conversation) ?? [];
}

export function useStreamingEntries(): ConversationEntry[] {
  return useSliceValue<ConversationEntry[]>(SLICE.streaming) ?? [];
}

export function useSignals(): ControllerSignal[] {
  return useSliceValue<ControllerSignal[]>(SLICE.signals) ?? [];
}

export function useBusy(): boolean {
  return useSliceValue<boolean>(SLICE.busy) ?? false;
}

export function usePendingInquiry(): InquireQuestion | null {
  return useSliceValue<InquireQuestion | null>(SLICE.pendingInquiry) ?? null;
}

export function useContextUsage(): ContextUsage | null {
  return useSliceValue<ContextUsage>(SLICE.contextUsage) ?? null;
}

export function useActiveWorkers(): ActiveWorkerInfo[] {
  return useSliceValue<ActiveWorkerInfo[]>(SLICE.activeWorkers) ?? [];
}

export function useTasks(): { pending: TaskDetail[]; running: TaskDetail[]; completed: TaskDetail[] } {
  const pending = useSliceValue<TaskDetail[]>(SLICE.tasksPending);
  const running = useSliceValue<TaskDetail[]>(SLICE.tasksRunning);
  const history = useSliceValue<TaskDetail[]>(SLICE.tasksHistory);
  // `tasks.history` carries every terminal task (completed, failed,
  // cancelled); the status bar counts only the ones that finished cleanly.
  return {
    pending: pending ?? [],
    running: running ?? [],
    completed: (history ?? []).filter((t) => t.status === 'completed'),
  };
}

/* -------- Typed selectors with the same `?? fallback` tolerance the TUI uses -------- */

export const selectConversation = (s: SliceStore): ConversationEntry[] =>
  (s[SLICE.conversation] as ConversationEntry[] | undefined) ?? [];

export const selectStreaming = (s: SliceStore): ConversationEntry[] =>
  (s[SLICE.streaming] as ConversationEntry[] | undefined) ?? [];

export const selectSignals = (s: SliceStore): ControllerSignal[] =>
  (s[SLICE.signals] as ControllerSignal[] | undefined) ?? [];

export const selectBusy = (s: SliceStore): boolean =>
  (s[SLICE.busy] as boolean | undefined) ?? false;

export const selectPendingInquiry = (s: SliceStore): InquireQuestion | null =>
  (s[SLICE.pendingInquiry] as InquireQuestion | null | undefined) ?? null;

export const selectContextUsage = (s: SliceStore): ContextUsage | null =>
  (s[SLICE.contextUsage] as ContextUsage | null | undefined) ?? null;

export const selectActiveWorkers = (s: SliceStore): ActiveWorkerInfo[] =>
  (s[SLICE.activeWorkers] as ActiveWorkerInfo[] | undefined) ?? [];

export const selectTasks = (s: SliceStore): { pending: TaskDetail[]; running: TaskDetail[]; completed: TaskDetail[] } => ({
  pending: (s[SLICE.tasksPending] as TaskDetail[] | undefined) ?? [],
  running: (s[SLICE.tasksRunning] as TaskDetail[] | undefined) ?? [],
  // `tasks.history` carries every terminal task (completed, failed,
  // cancelled); the status bar counts only the ones that finished cleanly.
  completed: ((s[SLICE.tasksHistory] as TaskDetail[] | undefined) ?? []).filter((t) => t.status === 'completed'),
});

/* -------- Display composition, split per section --------
 * The old buildDisplayItems produced one mixed list; the sections below keep
 * the same visual order (conversation → streaming → unread signals) while
 * letting each section subscribe to (and re-render on) its own slice only.
 */

/** Conversation entries → display rows. */
export function buildConversationItems(s: SliceStore): DisplayItem[] {
  return selectConversation(s)
    .map(entryToDisplayItem)
    .filter((d): d is DisplayItem => d !== null);
}

/** Streaming entries not yet committed to the conversation (the live row). */
export function buildStreamingItems(s: SliceStore): DisplayItem[] {
  const seen = new Set(selectConversation(s).map((e) => e.uuid));
  return selectStreaming(s)
    .filter((e) => !seen.has(e.uuid))
    .map(entryToDisplayItem)
    .filter((d): d is DisplayItem => d !== null);
}

/** Unread worker signals → display rows. */
export function buildUnreadSignalItems(s: SliceStore): DisplayItem[] {
  return selectSignals(s)
    .filter((sig) => sig.status === 'unread')
    .map(signalToDisplayItem);
}
