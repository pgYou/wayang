/**
 * Signal → ConversationEntry converters (moved verbatim from
 * controller-agent.ts): one converter per ControllerSignal type plus the
 * shared `signalToEntry` dispatcher that stamps the originating worker's
 * lineage (rootTurnId / causationId / actor) onto each entry.
 */

import { generateId } from '@/utils/id';
import type {
  ControllerSignal,
  InputSignalPayload,
  CompletedSignalPayload,
  FailedSignalPayload,
  ProgressSignalPayload,
  HeartbeatSignalPayload,
  PermissionRequestSignalPayload,
  PreviousSessionTasksSignalPayload,
  CancelledSignalPayload,
  TaskCancelledSignalPayload,
  TaskQueuedSignalPayload,
  WorkerStartedSignalPayload,
  WorkerInquirySignalPayload,
  InquiryTimeoutSignalPayload,
  MessageUndeliveredSignalPayload,
} from '@/types/index';
import type { ConversationEntry, SignalEntry } from '@/types/conversation';
import { EEntryType, ESignalSubtype } from '@/types/index';

// ---------------------------------------------------------------------------
// Signal → ConversationEntry converters
// ---------------------------------------------------------------------------

/** Common fields for all SignalEntry variants. */
function signalBase(ts: string, sessionId: string): Omit<SignalEntry, 'subtype' | 'content' | 'taskTitle'> {
  return {
    type: EEntryType.Signal,
    uuid: generateId('sig'),
    parentUuid: null,
    sessionId,
    timestamp: ts,
  };
}

/** ISO string from a signal's epoch-ms timestamp. */
function isoMs(ms: number | undefined): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

/**
 * One-line activity tail for worker-produced signals (issue #16).
 * `lastActivityAt` is an epoch-ms stamp; null/undefined means "no entries yet".
 */
function signalActivityTail(currentTool?: string | null, lastActivityAt?: number | null): string | null {
  const parts: string[] = [];
  if (currentTool) parts.push(`tool=${currentTool}`);
  if (typeof lastActivityAt === 'number' && Number.isFinite(lastActivityAt)) {
    // Second precision keeps the tail short in the transcript/UI.
    parts.push(`lastEntry=${new Date(lastActivityAt).toISOString().replace(/\.\d{3}Z$/, 'Z')}`);
  }
  return parts.length > 0 ? `[activity: ${parts.join(', ')}]` : null;
}

type SignalConverter = (sig: ControllerSignal, ts: string, sessionId: string) => ConversationEntry;

const signalConverters: Record<string, SignalConverter> = {
  input: (sig, ts, sessionId) => ({
    type: EEntryType.User,
    uuid: generateId('u'),
    parentUuid: null,
    sessionId,
    timestamp: ts,
    actor: { kind: 'user', id: 'user' },
    startedAt: isoMs(sig.timestamp),
    // Delivery/processing of the input is complete when it is recorded here.
    endedAt: ts,
    message: { role: 'user' as const, content: (sig.payload as InputSignalPayload).text },
  }),

  completed: (sig, ts, sessionId) => {
    const p = sig.payload as CompletedSignalPayload;
    return {
      ...signalBase(ts, sessionId),
      subtype: ESignalSubtype.WorkerCompleted,
      workerId: p.workerId, workerType: p.workerType, emoji: p.emoji,
      taskId: p.taskId, taskTitle: p.taskTitle,
      content: p.summary ?? JSON.stringify(sig.payload),
    };
  },

  failed: (sig, ts, sessionId) => {
    const p = sig.payload as FailedSignalPayload;
    return {
      ...signalBase(ts, sessionId),
      subtype: ESignalSubtype.WorkerFailed,
      workerId: p.workerId, workerType: p.workerType, emoji: p.emoji,
      taskId: p.taskId, taskTitle: p.taskTitle,
      content: p.error,
    };
  },

  progress: (sig, ts, sessionId) => {
    const p = sig.payload as ProgressSignalPayload;
    // Activity tail (issue #16): the controller can judge "still moving" from
    // the signal itself, without an extra get_worker_status call.
    const activity = signalActivityTail(p.currentTool, p.lastActivityAt);
    return {
      ...signalBase(ts, sessionId),
      subtype: ESignalSubtype.WorkerProgress,
      workerId: p.workerId, workerType: p.workerType, emoji: p.emoji,
      taskId: p.taskId, taskTitle: p.taskTitle,
      content: activity ? `${p.message}\n${activity}` : p.message,
    };
  },

  heartbeat: (sig, ts, sessionId) => {
    const p = sig.payload as HeartbeatSignalPayload;
    const workerSummary = p.workers
      .map((w) => {
        const tool = w.currentTool ? `, tool ${w.currentTool}` : '';
        const idle = w.lastActivityAgoMs !== null && w.lastActivityAgoMs !== undefined
          ? `, last activity ${Math.round(w.lastActivityAgoMs / 1000)}s ago`
          : '';
        return `${w.taskTitle} [${w.workerId}] (${w.workerType}, running ${Math.round(w.runningForMs / 1000)}s${tool}${idle})`;
      })
      .join(', ');
    return {
      ...signalBase(ts, sessionId),
      subtype: ESignalSubtype.Heartbeat,
      taskTitle: 'heartbeat',
      content: `[HEARTBEAT] ${p.reason}\nIdle: ${Math.round(p.idleSinceMs / 1000)}s\nWorkers: ${workerSummary}\nPending tasks: ${p.pendingTaskCount}`,
    };
  },

  permission_request: (sig, ts, sessionId) => {
    const p = sig.payload as PermissionRequestSignalPayload;
    return {
      ...signalBase(ts, sessionId),
      subtype: ESignalSubtype.PermissionRequest,
      workerId: p.workerId, workerType: p.workerType, emoji: p.emoji,
      taskId: p.taskId, taskTitle: p.taskTitle,
      content: `[PERMISSION REQUEST] The worker running task "${p.taskTitle}" wants to run ${p.toolName}.\nDescription: ${p.description}\nRequest ID: ${p.requestId}\nUse respond_permission to approve or deny.`,
      // Structured copy for per-tool summary rendering (content stays as the
      // LLM-facing flattened text — do not remove).
      permissionMeta: {
        requestId: p.requestId,
        toolName: p.toolName,
        toolArgs: p.toolArgs,
        description: p.description,
      },
    };
  },

  worker_inquiry: (sig, ts, sessionId) => {
    const p = sig.payload as WorkerInquirySignalPayload;
    return {
      ...signalBase(ts, sessionId),
      subtype: ESignalSubtype.WorkerInquiry,
      workerId: p.workerId, workerType: p.workerType, emoji: p.emoji,
      taskId: p.taskId, taskTitle: p.taskTitle,
      content: `[WORKER INQUIRY] The worker running task "${p.taskTitle}" is blocked and asks:${'\n'}${p.question}` +
        `${p.context ? `\nContext: ${p.context}` : ''}\nInquiry ID: ${p.inquiryId}\nUse respond_inquiry to answer; the worker is waiting and will continue on its own after a 5-minute timeout.`,
      inquiryMeta: {
        inquiryId: p.inquiryId,
        question: p.question,
        ...(p.context !== undefined && { context: p.context }),
      },
    };
  },

  inquiry_timeout: (sig, ts, sessionId) => {
    const p = sig.payload as InquiryTimeoutSignalPayload;
    return {
      ...signalBase(ts, sessionId),
      subtype: ESignalSubtype.InquiryTimeout,
      workerId: p.workerId, workerType: p.workerType, emoji: p.emoji,
      taskId: p.taskId, taskTitle: p.taskTitle,
      content: `[INQUIRY TIMEOUT] The worker running task "${p.taskTitle}" got no answer within 5 minutes and continued on its own judgment. Question was: ${p.question}`,
    };
  },

  message_undelivered: (sig, ts, sessionId) => {
    const p = sig.payload as MessageUndeliveredSignalPayload;
    const lines = p.messages.map(m => `- ${m}`);
    return {
      ...signalBase(ts, sessionId),
      subtype: ESignalSubtype.MessageUndelivered,
      workerId: p.workerId, workerType: p.workerType, emoji: p.emoji,
      taskId: p.taskId, taskTitle: p.taskTitle ?? 'message_undelivered',
      content: `[MESSAGES NOT DELIVERED] The worker ${p.reason === 'worker_disposed' ? 'was disposed (idle)' : 'finished its task'} before reading your message(s):${'\n'}${lines.join('\n')}\nThey were never seen by the worker. If still relevant, re-dispatch as a follow-up task.`,
    };
  },

  cancelled: (sig, ts, sessionId) => {
    const p = sig.payload as CancelledSignalPayload;
    return {
      ...signalBase(ts, sessionId),
      subtype: ESignalSubtype.WorkerDisposed,
      workerId: p.workerId, workerType: p.workerType, emoji: p.emoji,
      taskId: p.taskId, taskTitle: 'worker_disposed',
      content: `[WORKER DISPOSED] An idle (multi-stage) worker was disposed (reaped by timeout or manually). No task failed — its last stage already completed. If you still need this worker's context, create a fresh multi-stage task instead.`,
    };
  },

  task_cancelled: (sig, ts, sessionId) => {
    const p = sig.payload as TaskCancelledSignalPayload;
    return {
      ...signalBase(ts, sessionId),
      subtype: ESignalSubtype.TaskCancelled,
      workerId: p.workerId, workerType: p.workerType, emoji: p.emoji,
      taskId: p.taskId, taskTitle: p.taskTitle ?? 'task_cancelled',
      content: `[TASK CANCELLED] Task ${p.taskId}${p.taskTitle ? ` (${p.taskTitle})` : ''} was cancelled by the user/controller. This is not a failure — the task terminated as cancelled.`,
    };
  },

  task_queued: (sig, ts, sessionId) => {
    const p = sig.payload as TaskQueuedSignalPayload;
    return {
      ...signalBase(ts, sessionId),
      subtype: ESignalSubtype.TaskQueued,
      workerType: p.workerType, emoji: p.emoji,
      taskId: p.taskId, taskTitle: p.taskTitle,
      content: `[TASK QUEUED] ${p.message}`,
    };
  },

  worker_started: (sig, ts, sessionId) => {
    const p = sig.payload as WorkerStartedSignalPayload;
    return {
      ...signalBase(ts, sessionId),
      subtype: ESignalSubtype.WorkerStarted,
      workerId: p.workerId, workerType: p.workerType, emoji: p.emoji,
      taskId: p.taskId, taskTitle: p.taskTitle,
      content: `[WORKER STARTED${p.reused ? ' (reused idle worker)' : ''}] ${p.message}`,
    };
  },

  previous_session_tasks: (sig, ts, sessionId) => {
    const p = sig.payload as PreviousSessionTasksSignalPayload;
    const lines = p.tasks.map(t => `- [${t.status}] ${t.title} (id: ${t.taskId}): ${t.description}`);
    return {
      ...signalBase(ts, sessionId),
      subtype: ESignalSubtype.PreviousSessionTasks,
      taskTitle: 'previous_session_tasks',
      content: `[PREVIOUS SESSION] ${p.tasks.length} unfinished task(s) from session ${p.sessionId} (last active ${new Date(p.lastActiveAt).toLocaleString()}):\n${lines.join('\n')}\nWorkers were NOT resumed. Decide: re-dispatch with add_task, treat as stale, or ask the user.`,
    };
  },
};

/** Convert a ControllerSignal to a ConversationEntry. */
export function signalToEntry(sig: ControllerSignal, ts: string, sessionId: string): ConversationEntry {
  const converter = signalConverters[sig.type];
  let entry: ConversationEntry;
  if (converter) {
    entry = converter(sig, ts, sessionId);
  } else {
    // Fallback for unknown/cancelled signals
    const p = sig.payload as FailedSignalPayload;
    entry = {
      ...signalBase(ts, sessionId),
      subtype: ESignalSubtype.WorkerFailed,
      workerId: p.workerId, workerType: p.workerType, emoji: p.emoji,
      taskId: p.taskId, taskTitle: p.taskTitle ?? sig.type,
      content: JSON.stringify(sig.payload),
    } as SignalEntry;
  }

  // Stamp signal lineage onto SignalEntry records: the originating worker's
  // chain (rootTurnId / causationId) plus the queue id. turnId is NOT copied —
  // the entry joins the controller turn that consumes the signal (set by
  // applyTurnEnvelope at the call site); the worker's own turn lives in the
  // worker's conversation file. endedAt marks the delivery moment: the signal
  // was consumed and recorded by this controller run.
  if (entry.type === EEntryType.Signal) {
    const s = entry as SignalEntry;
    s.signalId = sig.id;
    if (sig.rootTurnId !== undefined) s.rootTurnId = sig.rootTurnId;
    if (sig.causationId !== undefined) s.causationId = sig.causationId;
    s.startedAt = isoMs(sig.timestamp);
    s.endedAt = ts;
    const payload = sig.payload as unknown as Record<string, unknown>;
    if (sig.source === 'worker' && typeof payload.workerId === 'string') {
      s.actor = {
        kind: 'worker',
        id: payload.workerId,
        ...(typeof payload.taskId === 'string' && { taskId: payload.taskId }),
      };
    } else if (sig.source === 'system') {
      s.actor = { kind: 'system', id: 'system' };
    }
  }
  return entry;
}
