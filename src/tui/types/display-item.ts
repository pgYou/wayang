import type { ConversationEntry, PermissionRequestMeta, WorkerInquiryMeta } from '@/types/conversation';
import type { ControllerSignal, PermissionRequestSignalPayload, WorkerInquirySignalPayload } from '@/types/signal';
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
  /** system-only: compaction marker metadata — present iff this is a real compact marker. */
  compactMeta?: { summarizedTokenCount?: number };
  isError?: boolean;
  /** Worker signal context: task and worker IDs. */
  taskId?: string;
  taskTitle?: string;
  workerId?: string;
  /** Worker type label (e.g. 'puppet', 'claude-code') for emoji resolution. */
  workerType?: string;
  /** Display emoji for the worker type. */
  emoji?: string;
  /** signal-only: structured permission-request data (permission_request subtype). */
  permissionMeta?: PermissionRequestMeta;
  /** signal-only: structured worker-inquiry data (worker_inquiry subtype). */
  inquiryMeta?: WorkerInquiryMeta;
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

      // Reasoning (extended thinking). Providers may emit whitespace-only
      // reasoning on pure tool-call steps — skip it so no empty
      // "thinking:" row is rendered.
      if (entry.message.reasoning?.trim()) {
        sections.push({ kind: 'reasoning', id: 'reasoning', text: entry.message.reasoning.trim() });
      }

      // Main text content (whitespace-only content is skipped for the same reason)
      if (entry.message.content?.trim()) {
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
      return { ...base, role: 'signal', subtype: entry.subtype, content: entry.content, taskId: entry.taskId, taskTitle: entry.taskTitle, workerId: entry.workerId, workerType: entry.workerType, emoji: entry.emoji, permissionMeta: entry.permissionMeta, inquiryMeta: entry.inquiryMeta };

    case EEntryType.System:
      return { ...base, role: 'system', subtype: entry.subtype, content: entry.content, compactMeta: entry.compactMeta };
  }
}

/** SignalType → ESignalSubtype mapping. */
const signalSubtypeMap: Record<string, ESignalSubtype> = {
  completed: ESignalSubtype.WorkerCompleted,
  failed: ESignalSubtype.WorkerFailed,
  progress: ESignalSubtype.WorkerProgress,
  heartbeat: ESignalSubtype.Heartbeat,
  cancelled: ESignalSubtype.WorkerFailed,
  task_cancelled: ESignalSubtype.TaskCancelled,
  permission_request: ESignalSubtype.PermissionRequest,
  worker_inquiry: ESignalSubtype.WorkerInquiry,
  inquiry_timeout: ESignalSubtype.InquiryTimeout,
  message_undelivered: ESignalSubtype.MessageUndelivered,
};

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

  // Permission requests carry structured data (tool name + args) that the
  // generic summary/error/message content extraction below cannot reach.
  if (signal.type === 'permission_request') {
    const p = signal.payload as PermissionRequestSignalPayload;
    return {
      ...base,
      role: 'signal',
      subtype: ESignalSubtype.PermissionRequest,
      content: p.description,
      taskId: p.taskId,
      taskTitle: p.taskTitle,
      workerId: p.workerId,
      workerType: p.workerType,
      emoji: p.emoji,
      permissionMeta: {
        requestId: p.requestId,
        toolName: p.toolName,
        toolArgs: p.toolArgs,
        description: p.description,
      },
    };
  }

  // Worker inquiries carry the question as content plus structured meta for
  // matching a later respond_inquiry call.
  if (signal.type === 'worker_inquiry') {
    const p = signal.payload as WorkerInquirySignalPayload;
    return {
      ...base,
      role: 'signal',
      subtype: ESignalSubtype.WorkerInquiry,
      content: p.question,
      taskId: p.taskId,
      taskTitle: p.taskTitle,
      workerId: p.workerId,
      workerType: p.workerType,
      emoji: p.emoji,
      inquiryMeta: {
        inquiryId: p.inquiryId,
        question: p.question,
        ...(p.context !== undefined && { context: p.context }),
      },
    };
  }

  const subtype = signalSubtypeMap[signal.type] ?? ESignalSubtype.WorkerProgress;
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
