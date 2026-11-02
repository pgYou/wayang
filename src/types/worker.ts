// --- Worker ---

import type { Subscribable } from '@/infra/state/subscribable';

export interface WorkerResult {
  status: 'completed' | 'failed';
  summary?: string;
  error?: string;
}

/** Runtime info for an active worker, stored in ControllerState. */
export interface ActiveWorkerInfo {
  workerId: string;
  taskId: string;
  startedAt: number;
  /** Worker type label (e.g. 'puppet', 'claude-code'). */
  workerType: string;
  /** Task title for display. */
  taskTitle: string;
  /** Display emoji for the worker type. */
  emoji: string;
  /** Lifecycle phase. `idle` = a multi-stage worker parked between stages. */
  status: 'running' | 'idle';
  /** For idle workers: summary of the last completed stage. */
  lastStageSummary?: string;
  /** For idle workers: timestamp (ms) when it entered idle. */
  idleSinceMs?: number;
}

/**
 * Live execution flags a worker can report about its current run (issue #16).
 * These answer "is it still working, or has it already finished and is just
 * not released?" — the question the controller could not answer when a
 * claude-code worker held a completed result for 571s.
 *
 * `null` means the worker type does not track that fact (e.g. a puppet worker
 * has no SDK result/stream concept) — it is not an assertion of "false".
 */
export interface WorkerLiveStatus {
  /** The underlying SDK/agent produced a final result for this run. */
  resultReceived: boolean | null;
  /** The message stream of this run has closed (run loop exited). */
  streamEnded: boolean | null;
}

/** Unified interface for all worker types (puppet, third-party). */
export interface IWorkerInstance extends Subscribable {
  readonly id: string;
  /** Execute the task. Returns the final result. */
  run(
    task: import('./task').TaskDetail & { workerId: string },
    tools: Record<string, any>,
    onProgress?: (msg: string) => void,
  ): Promise<WorkerResult>;
  /** Abort the current execution. */
  abort(): void;
  /** Get conversation entries for controller tool or audit. */
  getConversation(): import('@/types/conversation').ConversationEntry[];
  /** Get state for UI rendering. @deprecated Will be removed after TUI subscription refactor. */
  getState(): import('@/infra/state/base-state').BaseWayangState | null;
  /**
   * Accept a message from the controller during execution. Implementation varies by worker type.
   * Returns false when the worker can no longer receive messages (e.g. a
   * third-party worker whose session input has closed) — the caller must
   * report failure instead of pretending the message was queued.
   */
  acceptMessage(message: string): boolean;
  /** Live run flags (result arrived / stream closed). Optional — see WorkerLiveStatus. */
  getLiveStatus?(): WorkerLiveStatus;
  /**
   * Controller messages received but not yet read (non-destructive). The
   * engine reports them via a message_undelivered signal when the worker's
   * run ends (or an idle worker is disposed) with unread messages.
   */
  pendingMessages?(): string[];
}
