// --- Signal (SignalQueue) ---

export type SignalStatus = 'unread' | 'read' | 'discarded';
export type SignalSource = 'user' | 'worker' | 'system';
export type SignalType = 'input' | 'completed' | 'failed' | 'progress' | 'cancelled' | 'heartbeat';

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

/** Discriminated union of all signal payloads by SignalType. */
export type SignalPayloadMap = {
  input: InputSignalPayload;
  completed: CompletedSignalPayload;
  failed: FailedSignalPayload;
  progress: ProgressSignalPayload;
  cancelled: CancelledSignalPayload;
  heartbeat: HeartbeatSignalPayload;
};

/** A typed signal where payload corresponds to the signal type. */
export type TypedControllerSignal = {
  [K in SignalType]: {
    id: string;
    status: SignalStatus;
    source: SignalSource;
    type: K;
    payload: SignalPayloadMap[K];
    timestamp: number;
  };
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
  };
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
