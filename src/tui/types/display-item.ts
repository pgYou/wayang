import type { ConversationEntry } from '@/types/conversation';
import type { ControllerSignal } from '@/types/signal';
import { getSignalField } from '@/types/signal';
import { EEntryType, ESignalSubtype } from '@/types/conversation';

/** A section within an assistant step. */
export interface DisplaySection {
  /** Section kind. */
  kind: 'content' | 'reasoning' | 'tool_call' | 'tool_result';
  /** Unique id within the step (for tool sections: toolCallId). */
  id: string;
  /** Section text body. */
  text: string;
  toolName?: string;
  isError?: boolean;
}

/**
 * Unified display type for ChatArea.
 *
 * One DisplayItem = one ConversationEntry (1:1 mapping).
 * Assistant entries carry sub-sections for reasoning / tool calls / tool results.
 */
export interface DisplayItem {
  id: string;
  timestamp: number;
  read: boolean;
  role: 'user' | 'assistant' | 'signal' | 'system';
  /** Primary text content. */
  content: string;
  /** Assistant-only: ordered sub-sections within this step. */
  sections?: DisplaySection[];
  /** signal / system subtype discriminator. */
  subtype?: string;
  isError?: boolean;
  /** Worker signal context: task and worker IDs. */
  taskId?: string;
  taskTitle?: string;
  workerId?: string;
  /** Worker type label (e.g. 'puppet', 'claude-code') for emoji resolution. */
  workerType?: string;
  /** Display emoji for the worker type. */
  emoji?: string;
}

/** Convert a persisted conversation entry to a single DisplayItem, or null for hidden entries (e.g. skip_reply). */
export function entryToDisplayItem(entry: ConversationEntry): DisplayItem | null {
  const base = {
    id: entry.uuid,
    timestamp: new Date(entry.timestamp).getTime(),
    read: true,
  };

  switch (entry.type) {
    case EEntryType.User:
      return { ...base, role: 'user', content: entry.message.content };

    case EEntryType.Assistant: {
      // Hide any entry that contains a skip_reply tool call
      const hasSkipReply = entry.toolCalls?.some(tc => tc.toolName === 'skip_reply');
      if (hasSkipReply) return null;

      const sections: DisplaySection[] = [];

      // Reasoning (extended thinking)
      if (entry.message.reasoning) {
        sections.push({ kind: 'reasoning', id: 'reasoning', text: entry.message.reasoning });
      }

      // Main text content
      if (entry.message.content) {
        sections.push({ kind: 'content', id: 'content', text: entry.message.content });
      }

      // Tool calls
      for (const tc of entry.toolCalls ?? []) {
        sections.push({
          kind: 'tool_call',
          id: tc.toolCallId,
          text: tc.arguments,
          toolName: tc.toolName,
        });
      }

      // Tool results (paired by toolCallId)
      for (const tr of entry.toolResults ?? []) {
        sections.push({
          kind: 'tool_result',
          id: tr.toolCallId,
          text: tr.output.value,
          toolName: tr.toolName,
          isError: tr.isError,
        });
      }

      return {
        ...base,
        role: 'assistant',
        content: entry.message.content,
        sections,
      };
    }

    case EEntryType.Signal:
      return { ...base, role: 'signal', subtype: entry.subtype, content: entry.content, taskId: entry.taskId, taskTitle: entry.taskTitle, workerId: entry.workerId, workerType: entry.workerType, emoji: entry.emoji };

    case EEntryType.System:
      return { ...base, role: 'system', subtype: entry.subtype, content: entry.content };
  }
}

/** Convert an unread signal to a DisplayItem (always unread). */
export function signalToDisplayItem(signal: ControllerSignal): DisplayItem {
  const base = {
    id: signal.id,
    timestamp: signal.timestamp,
    read: false,
  };

  if (signal.type === 'input') {
    return {
      ...base,
      role: 'user',
      content: signal.payload.text,
    };
  }

  // worker signals
  const subtype = signal.type === 'completed' ? ESignalSubtype.WorkerCompleted
    : signal.type === 'failed' ? ESignalSubtype.WorkerFailed
    : ESignalSubtype.WorkerProgress;
  const content = getSignalField(signal, 'summary')
    ?? getSignalField(signal, 'error')
    ?? getSignalField(signal, 'message')
    ?? '';

  const taskId = getSignalField(signal, 'taskId');
  const taskTitle = getSignalField(signal, 'taskTitle');

  return {
    ...base,
    role: 'signal',
    subtype,
    content,
    taskId,
    workerId: getSignalField(signal, 'workerId'),
    workerType: getSignalField(signal, 'workerType'),
    emoji: getSignalField(signal, 'emoji'),
    taskTitle,
  };
}
