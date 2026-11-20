// --- Worker instance ---

import type { Subscribable } from '@wayang-ai/protocol/types/subscribable';
import type { WorkerLiveStatus, WorkerResult } from '@wayang-ai/protocol/types/worker';

/** Unified interface for all worker types (puppet, third-party). */
export interface IWorkerInstance extends Subscribable {
  readonly id: string;
  /**
   * Workspace this worker was CREATED in — the root its identity was stamped
   * with and the one its cwd / permission boundary / prompt were built for.
   *
   * A worker's workspace is fixed at construction: reusing the instance for a
   * task pinned to another workspace would only re-point the run (tools, gate,
   * cwd) while the worker keeps the old workspace's identity and the
   * relative-path assumptions baked into its accumulated context. Callers
   * therefore compare this value before reusing (see the engine's
   * `validateWorkerWorkspace`).
   */
  readonly workspaceDir: string;
  /** Execute the task. Returns the final result. */
  run(
    task: import('@wayang-ai/protocol/types/task').TaskDetail & { workerId: string },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- public interface param: heterogeneous zod-inferred tool set (see src/services/tools/common.ts relaxation boundary)
    tools: Record<string, any>,
    onProgress?: (msg: string) => void,
  ): Promise<WorkerResult>;
  /** Abort the current execution. */
  abort(): void;
  /** Get conversation entries for controller tool or audit. */
  getConversation(): import('@wayang-ai/protocol/types/conversation').ConversationEntry[];
  /** Get state for UI rendering. @deprecated Will be removed after TUI subscription refactor. */
  getState(): import('../../infra/state/base-state').BaseWayangState | null;
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
