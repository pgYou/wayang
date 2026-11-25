/**
 * Renderer state store — the slices the TUI subscribes to, forwarded from
 * main as `{ target, path, data }` updates. DisplayItem conversion is shared
 * with the CLI through core's client SDK, so both frontends render the same
 * conversation model.
 */

import { useEffect, useState } from 'react';
import type { ConversationEntry, ControllerSignal, ActiveWorkerInfo, TaskDetail, InquireQuestion, ContextUsage } from '@wayang-ai/protocol';
import { entryToDisplayItem, signalToDisplayItem, type DisplayItem } from './display';

export const SLICE = {
  conversation: 'controllerAgent:conversation',
  streaming: 'controllerAgent:dynamicState.streamingEntries',
  busy: 'controllerAgent:dynamicState.busy',
  pendingInquiry: 'controllerAgent:runtimeState.pendingInquiry',
  contextUsage: 'controllerAgent:dynamicState.contextUsage',
  signals: 'signalQueue:signals',
  activeWorkers: 'engine:activeWorkers',
  tasksPending: 'engine:tasks.pending',
  tasksRunning: 'engine:tasks.running',
  // Core writes the full task history (all terminal states) to tasks.history;
  // `tasks.completed` was a dead path. Completed tasks are filtered below.
  tasksHistory: 'engine:tasks.history',
} as const;

export interface StateUpdate {
  target: string;
  path: string;
  data: unknown;
}

export type SliceStore = Record<string, unknown>;

export function useWayangSlices(): SliceStore {
  const [slices, setSlices] = useState<SliceStore>({});
  useEffect(() => window.wayang.onState((update: StateUpdate) => {
    setSlices((prev) => ({ ...prev, [`${update.target}:${update.path}`]: update.data }));
  }), []);
  return slices;
}

export function useConnectionStatus(): { phase: string; detail?: string; sessionId?: string } {
  const [status, setStatus] = useState<{ phase: string; detail?: string; sessionId?: string }>({ phase: 'connecting' });
  useEffect(() => window.wayang.onStatus(setStatus), []);
  return status;
}

/* Typed selectors with the same `?? fallback` tolerance the TUI uses. */

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

/** Same composition as the TUI controller page: read entries + unread signals. */
export function buildDisplayItems(s: SliceStore): DisplayItem[] {
  const conversation = selectConversation(s);
  const readItems = conversation
    .map(entryToDisplayItem)
    .filter((d): d is DisplayItem => d !== null);
  const unreadSignals = selectSignals(s)
    .filter((sig) => sig.status === 'unread')
    .map(signalToDisplayItem);

  const seen = new Set(conversation.map((e) => e.uuid));
  const streamingItems = selectStreaming(s)
    .filter((e) => !seen.has(e.uuid))
    .map(entryToDisplayItem)
    .filter((d): d is DisplayItem => d !== null);

  return [...readItems, ...streamingItems, ...unreadSignals];
}
