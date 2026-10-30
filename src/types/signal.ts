// --- Signal (SignalQueue) ---

export type SignalStatus = 'unread' | 'read' | 'discarded';
export type SignalSource = 'user' | 'worker' | 'system';
export type SignalType = 'input' | 'completed' | 'failed' | 'progress' | 'cancelled' | 'task_cancelled' | 'heartbeat' | 'permission_request' | 'previous_session_tasks';

/** User input signal payload. */
export interface InputSignalPayload {
  /** Raw text from user. */
  text: string;
}

/** Worker task completed signal payload. */
export interface CompletedSignalPayload {
  taskId: string;
  workerId: string;
  /** Task title for display context. */
  taskTitle: string;
  /** Worker type label (e.g. 'puppet', 'claude-code'). */
  workerType?: string;
  /** Display emoji for the worker type. */
  emoji?: string;
  /** Brief summary of completed work. */
  summary?: string;
}

/** Worker task failed signal payload. */
export interface FailedSignalPayload {
  taskId: string;
  workerId: string;
  /** Task title for display context. */
  taskTitle: string;
  /** Worker type label (e.g. 'puppet', 'claude-code'). */
  workerType?: string;
  /** Display emoji for the worker type. */
  emoji?: string;
  /** Error description. */
  error: string;
}

/** Worker progress report signal payload. */
export interface ProgressSignalPayload {
  workerId: string;
  taskId: string;
  /** Task title for UI display. */
  taskTitle: string;
  /** Worker type label (e.g. 'puppet', 'claude-code'). */
  workerType?: string;
  /** Display emoji for the worker type. */
  emoji?: string;
  /** Human-readable progress message. */
  message: string;
  percent?: number;
}

/** Worker task cancelled signal payload. */
export interface CancelledSignalPayload {
  taskId: string;
  workerId: string;
  /** Worker type label. */
  workerType?: string;
  /** Display emoji for the worker type. */
  emoji?: string;
}

/**
 * Dispatched task cancelled by the user/controller. Distinct from
 * `cancelled` (idle worker disposal): here the task itself terminated as
 * cancelled — a terminal outcome, but not a failure.
 */
export interface TaskCancelledSignalPayload {
  taskId: string;
  /** Worker executing the task, when the cancel hit a running task. */
  workerId?: string;
  /** Task title for display context. */
  taskTitle?: string;
  /** Worker type label (e.g. 'puppet', 'claude-code'). */
  workerType?: string;
  /** Display emoji for the worker type. */
  emoji?: string;
}

/** System heartbeat signal payload — periodic check-in while workers are running. */
export interface HeartbeatSignalPayload {
  /** Human-readable reason for the heartbeat. */
  reason: string;
  /** Milliseconds since the last loop wake. */
  idleSinceMs: number;
  /** Snapshot of currently active workers. */
  workers: Array<{
    workerId: string;
    taskId: string;
    taskTitle: string;
    workerType: string;
    /** How long this worker has been running (ms). */
    runningForMs: number;
  }>;
  /** Number of pending (queued) tasks. */
  pendingTaskCount: number;
}

/** Worker requesting permission for a sensitive tool operation. */
export interface PermissionRequestSignalPayload {
  /** Unique ID for matching request → response. */
  requestId: string;
  workerId: string;
  taskId: string;
  /** Task title for display context. */
  taskTitle: string;
  /** Worker type label (e.g. 'puppet', 'claude-code'). */
  workerType?: string;
  /** Display emoji for the worker type. */
  emoji?: string;
  /** Tool name that triggered the permission check. */
  toolName: string;
  /** Arguments passed to the tool. */
  toolArgs: Record<string, any>;
  /** Human-readable description of what the tool will do. */
  description: string;
}

/** Snapshot of an unfinished task carried over from a previous session. */
export interface PreviousSessionTask {
  taskId: string;
  title: string;
  description: string;
  status: 'pending' | 'running';
}

/**
 * System signal injected at sessionless resume: tasks that were pending or
 * running when the previous session ended. The controller decides whether to
 * re-dispatch them, treat them as stale, or ask the user. Workers are NOT
 * auto-resumed — this is purely informational.
 */
export interface PreviousSessionTasksSignalPayload {
  /** Session these tasks came from. */
  sessionId: string;
  /** When that session was last active (ms epoch). */
  lastActiveAt: number;
  /** Unfinished task snapshots (pending + running from the previous session). */
  tasks: PreviousSessionTask[];
}

/** Discriminated union of all signal payloads by SignalType. */
export type SignalPayloadMap = {
  input: InputSignalPayload;
  completed: CompletedSignalPayload;
  failed: FailedSignalPayload;
  progress: ProgressSignalPayload;
  cancelled: CancelledSignalPayload;
  task_cancelled: TaskCancelledSignalPayload;
  heartbeat: HeartbeatSignalPayload;
  permission_request: PermissionRequestSignalPayload;
  previous_session_tasks: PreviousSessionTasksSignalPayload;
};

/** Turn lineage fields a signal producer can attach. All optional. */
export interface SignalTurnLineage {
  /** Turn that produced this signal (e.g. the worker's execution turn). */
  turnId?: string;
  /** Root user turn of the chain this signal belongs to. */
  rootTurnId?: string;
  /** What produced this signal — typically the task id for worker signals. */
  causationId?: string;
}

/** A typed signal where payload corresponds to the signal type. */
export type TypedControllerSignal = {
  [K in SignalType]: {
    id: string;
    status: SignalStatus;
    source: SignalSource;
    type: K;
    payload: SignalPayloadMap[K];
    timestamp: number;
  } & SignalTurnLineage;
}[SignalType];

/**
 * ControllerSignal — the primary signal type.
 * Discriminated on `type` field; payload is typed accordingly.
 */
export type ControllerSignal = TypedControllerSignal;

/** Input type for SignalQueue.enqueue() — auto-assigned fields omitted. */
export type NewSignalInput = {
  [K in SignalType]: {
    source: SignalSource;
    type: K;
    payload: SignalPayloadMap[K];
  } & SignalTurnLineage;
}[SignalType];

/**
 * Type-safe accessor for signal payload fields.
 * Use when narrowing by `sig.type` is not ergonomic (e.g. after source-based branching).
 */
export function getSignalField<K extends keyof (InputSignalPayload & CompletedSignalPayload & FailedSignalPayload & ProgressSignalPayload & CancelledSignalPayload)>(
  sig: ControllerSignal,
  field: K,
): string | undefined {
  return (sig.payload as Record<string, any>)[field] as string | undefined;
}
