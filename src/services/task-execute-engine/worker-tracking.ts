// WorkerTrackingEngine: worker queries (active workers, conversations,
// inquiries), the activeWorkers runtime state, and the idle-worker lifecycle.
// Extends TaskLifecycleEngine.

import type {
  ActiveWorkerInfo,
  ConversationEntry,
  TaskDetail,
  WorkerLiveStatus,
} from '@/types/index';
import type { Subscribable } from '@/infra/state/subscribable';
import { summarizeTranscript } from '@/services/worker-transcript';
import { WorkerAgent } from '@/services/agents/worker-agent';
import type { PermissionResolutionStatus } from '@/services/tools/permission-middleware';
import { generateId } from '@/utils/id';
import type { WorkerMessageDelivery } from './types';
import { normalizeWorkspacePath } from '@/infra/workspace-registry';
import { TaskLifecycleEngine } from './task-lifecycle';

export abstract class WorkerTrackingEngine extends TaskLifecycleEngine {
  // ---------------------------------------------------------------------------
  // Worker queries
  // ---------------------------------------------------------------------------

  getActiveWorkers(): ActiveWorkerInfo[] {
    return this.workerState.get<ActiveWorkerInfo[]>('activeWorkers');
  }

  /** Count slots occupied by running + idle workers (both count against maxConcurrency). */
  getOccupiedSlots(): number {
    return this.getActiveWorkers().length;
  }

  /** Check whether a worker is idle and reusable. Returns error message or null. */
  validateIdleWorker(workerId: string): string | null {
    const info = this.getActiveWorkers().find(w => w.workerId === workerId);
    if (!info) return `Worker "${workerId}" not found.`;
    if (info.status !== 'idle') return `Worker "${workerId}" is not idle (status: ${info.status}).`;
    return null;
  }

  /**
   * Validate that an idle worker may take a task executing in `workspacePath`.
   * Returns an error message or null.
   *
   * A worker's workspace is fixed at construction: its state identity, the
   * relative-path assumptions in its accumulated conversation, and the identity
   * stamped on its records all belong to the workspace it was born in. Reuse
   * across workspaces would silently re-point only the RUN (cwd, tools,
   * permission gate) at the new workspace while the worker keeps the old
   * identity — so both sides are canonicalized (realpath, resolve fallback)
   * and compared before any reuse. A mismatch is never resolved by re-stamping
   * the worker; the caller must create a new one.
   *
   * Two consumers: `assignToExistingWorker` (the single reuse choke point, so
   * no caller can bypass it) and the add_task tool's pre-check (which turns the
   * rejection into an explicit instruction instead of a generic failure).
   * `workspacePath` falls back to the process workspace, mirroring
   * `taskWorkspaceDir` for tasks without a workspace stamp.
   */
  validateWorkerWorkspace(workerId: string, workspacePath?: string): string | null {
    const worker = this.workers.get(workerId);
    if (!worker) return `Worker "${workerId}" not found.`;

    const workerWorkspace = worker.workspaceDir;
    if (!workerWorkspace) {
      return `Worker "${workerId}" does not report the workspace it was created in, so reuse cannot be verified across workspaces. Create a new worker instead (drop assignToWorker).`;
    }

    const createdIn = normalizeWorkspacePath(workerWorkspace);
    const target = normalizeWorkspacePath(workspacePath ?? this.ctx.workspaceDir);
    if (createdIn !== target) {
      return `Worker "${workerId}" was created in workspace ${createdIn} and cannot take a task in ${target}. Create a new worker for that workspace instead (drop assignToWorker).`;
    }
    return null;
  }

  getWorkerState(workerId: string): Subscribable | null {
    const worker = this.workers.get(workerId);
    return worker ?? null;
  }

  /**
   * Send a message to a worker. Delivery is judged by the activeWorkers
   * runtime state — NOT by the workers Map, which lingers one tick past
   * disposal (removeWorkerTracking defers) and would accept messages for a
   * worker that is already gone. A worker that rejects the message (its run
   * can no longer take input) is reported as 'finished' — never a fake
   * 'queued'.
   */
  sendMessageToWorker(workerId: string, message: string): WorkerMessageDelivery {
    const info = this.getActiveWorkers().find(w => w.workerId === workerId);
    if (!info) return 'not_running';
    const worker = this.workers.get(workerId);
    if (!worker) return 'not_running';

    if (!worker.acceptMessage(message)) return 'finished';
    // Idle (multi-stage) workers read messages when their next stage starts;
    // a running puppet reads at its next LLM step; a running third-party
    // worker reads at its next turn boundary (the CLI queues the prompt and
    // processes it between turns — a tool call in progress is never cut).
    if (info.status === 'idle') return 'queued';
    return worker instanceof WorkerAgent ? 'delivered' : 'queued';
  }

  /**
   * Resolve a pending permission request (issue #69). Every return value is
   * a definite terminal answer for the controller:
   * - 'resolved' — this call settled a live pending request;
   * - 'already-resolved' / 'expired' / 'worker-closed' — the request already
   *   reached that terminal state (the worker side was released with it);
   * - 'not-found' — no live worker's gate ever knew this id.
   *
   * Ids are unique across middleware instances, so at most one resolver
   * recognizes a given id; the others answer 'not-found' without side
   * effects. The first non-'not-found' answer wins.
   */
  resolvePermission(requestId: string, approved: boolean, reason?: string): PermissionResolutionStatus {
    let known: PermissionResolutionStatus = 'not-found';
    for (const resolver of this.permissionResolvers.values()) {
      const status = resolver.resolvePermission(requestId, approved, reason);
      if (status === 'resolved') return 'resolved';
      if (known === 'not-found') known = status;
    }
    return known;
  }

  /**
   * Answer a worker's pending ask_controller call.
   * - 'answered': the blocked worker received the answer and resumes.
   * - 'not_found': the inquiry already settled (timed out) on a live worker.
   * - 'worker_gone': no registry has it — aborted/cancelled (tombstoned) or
   *   no worker runs at all.
   */
  resolveInquiry(inquiryId: string, answer: string): 'answered' | 'not_found' | 'worker_gone' {
    for (const registry of this.inquiryRegistries.values()) {
      if (registry.resolve(inquiryId, { kind: 'answer', answer })) return 'answered';
    }
    if (this.abortedInquiryIds.delete(inquiryId)) return 'worker_gone';
    return this.inquiryRegistries.size > 0 ? 'not_found' : 'worker_gone';
  }

  /** Abort a worker's pending inquiries (worker shutting down), tombstoning their ids. */
  protected cleanupInquiryRegistry(workerId: string): void {
    const registry = this.inquiryRegistries.get(workerId);
    if (!registry) return;
    registry.cleanupAll((id) => {
      this.abortedInquiryIds.add(id);
      return { kind: 'aborted' };
    });
    this.inquiryRegistries.delete(workerId);
  }

  /**
   * Report controller messages a worker never read before its run ended (or
   * before an idle worker was disposed). No-op when nothing is pending.
   */
  protected emitUndeliveredIfAny(
    workerId: string,
    ctx: { taskId?: string; taskTitle?: string; workerType?: string; emoji?: string },
    reason: 'task_finished' | 'worker_disposed',
  ): void {
    const worker = this.workers.get(workerId);
    const messages = worker?.pendingMessages?.() ?? [];
    if (messages.length === 0) return;
    this.enqueueWorkerSignal(workerId, {
      source: 'system',
      type: 'message_undelivered',
      payload: {
        workerId,
        ...ctx,
        messages,
        reason,
      },
    });
  }

  /**
   * Live run flags of a worker instance — "has the result arrived?" and "has
   * the stream closed?" (issue #16). Returns undefined for workers that do not
   * report them or are no longer tracked.
   */
  getWorkerLiveStatus(workerId: string): WorkerLiveStatus | undefined {
    return this.workers.get(workerId)?.getLiveStatus?.();
  }

  /**
   * Per-worker activity derived from the in-memory conversation: when it last
   * produced an entry, and which tool it called last. Fed into heartbeat
   * signals so the controller can spot a stall without calling a tool.
   */
  getWorkerActivity(workerId: string): { lastActivityAt: number | null; currentTool: string | null } {
    const entries = this.workers.get(workerId)?.getConversation() ?? [];
    const summary = summarizeTranscript(entries);
    return { lastActivityAt: summary.lastActivityAt, currentTool: summary.currentTool };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- controller-side formatters (get-task-detail) read these mixed-vintage entries defensively; changing the return type would cascade into those formatters
  getWorkerConversation(taskId: string): any[] {
    for (const [workerId, tId] of this.workerTaskMap) {
      if (tId === taskId) {
        const worker = this.workers.get(workerId);
        return worker?.getConversation() ?? [];
      }
    }
    return [];
  }

  /**
   * Live in-memory conversation of a worker looked up by worker id (not task
   * id). Undefined once the worker is no longer tracked — the on-disk
   * transcript (via the task's workerTranscriptId) takes over then.
   */
  getWorkerConversationByWorkerId(workerId: string): ConversationEntry[] | undefined {
    const worker = this.workers.get(workerId);
    return worker === undefined ? undefined : worker.getConversation();
  }

  /**
   * The worker instance's OWN id (agent-…/cw-…) — the directory name under
   * `<sessionDir>/workers/` where its conversation.jsonl lives. Distinct from
   * the engine worker id (w-…) used in tasks/signals. Only resolvable while
   * the engine tracks the worker; afterwards the task's persisted
   * `workerTranscriptId` is the source of truth.
   */
  getWorkerTranscriptId(workerId: string): string | undefined {
    return this.workers.get(workerId)?.id;
  }

  getRunningCount(): number {
    return this.taskState.get<TaskDetail[]>('tasks.running').length;
  }

  /**
   * Register the execution turn for a worker run and return it. The id is
   * handed to the worker (stamped on its entries) and reused on every signal
   * the engine emits for this worker, so the worker's conversation file and
   * the controller's signal records share the same turn id.
   */
  protected registerWorkerTurn(workerId: string, task: TaskDetail): string {
    const executionTurnId = generateId('turn');
    this.workerTurnLineage.set(workerId, {
      turnId: executionTurnId,
      ...(task.rootTurnId !== undefined && { rootTurnId: task.rootTurnId }),
      ...(task.rootTurnId === undefined && task.turnId !== undefined && { rootTurnId: task.turnId }),
      taskId: task.id,
    });
    return executionTurnId;
  }

  // ---------------------------------------------------------------------------
  // Private: active workers state
  // ---------------------------------------------------------------------------

  protected addActiveWorker(info: ActiveWorkerInfo): void {
    this.workerState.append('activeWorkers', info);
  }

  protected updateActiveWorker(workerId: string, updates: Partial<ActiveWorkerInfo>): void {
    const workers = this.workerState.get<ActiveWorkerInfo[]>('activeWorkers');
    const idx = workers.findIndex(w => w.workerId === workerId);
    if (idx === -1) return;
    workers[idx] = { ...workers[idx], ...updates };
    this.workerState.set('activeWorkers', [...workers]);
  }

  protected removeActiveWorker(workerId: string): void {
    const workers = this.workerState.get<ActiveWorkerInfo[]>('activeWorkers');
    const idx = workers.findIndex(w => w.workerId === workerId);
    if (idx !== -1) {
      this.workerState.remove('activeWorkers', idx);
    }
  }

  // ---------------------------------------------------------------------------
  // Private: idle worker lifecycle
  // ---------------------------------------------------------------------------

  /** Park a multi-stage worker in `idle`, keeping its instance + context. */
  protected moveToIdle(workerId: string, task: TaskDetail, summary: string): void {
    this.updateActiveWorker(workerId, {
      status: 'idle',
      lastStageSummary: summary,
      idleSinceMs: Date.now(),
    });
    this.startIdleTimer(workerId);
    this.ctx.hooks.emit('worker:idle', { workerId, taskId: task.id });
    this.logger.info({ workerId, taskId: task.id }, 'Worker entered idle (multi-stage)');
  }

  /** Start the reaper timer for an idle worker. */
  protected startIdleTimer(workerId: string): void {
    this.clearIdleTimer(workerId);
    const timer = setTimeout(() => {
      this.disposeIdleWorker(workerId, 'idle timeout');
    }, this.idleTimeoutMs);
    // Allow the process to exit even if a timer is pending
    if (typeof timer === 'object' && timer && 'unref' in timer) {
      (timer as { unref: () => void }).unref();
    }
    this.idleTimers.set(workerId, timer);
  }

  protected clearIdleTimer(workerId: string): void {
    const timer = this.idleTimers.get(workerId);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(workerId);
    }
  }

  /**
   * Dispose an idle worker: abort, drop tracking, emit a signal so the
   * controller knows the worker is gone. No task-state change (the stage
   * task already completed).
   */
  protected disposeIdleWorker(workerId: string, reason: string): void {
    const info = this.getActiveWorkers().find(w => w.workerId === workerId);
    if (!info || info.status !== 'idle') return;

    const worker = this.workers.get(workerId);
    worker?.abort();
    this.clearIdleTimer(workerId);

    // Messages parked in the idle worker's inbox die with it — report them.
    this.emitUndeliveredIfAny(
      workerId,
      { taskId: info.taskId, workerType: info.workerType, emoji: info.emoji },
      'worker_disposed',
    );

    this.enqueueWorkerSignal(workerId, {
      source: 'system',
      type: 'cancelled',
      payload: {
        taskId: info.taskId,
        workerId,
        workerType: info.workerType,
        emoji: info.emoji,
      },
    });

    this.removeActiveWorker(workerId);
    this.removeWorkerTracking(workerId);
    this.logger.info({ workerId, reason }, 'Idle worker disposed');
    this.scheduleNext();
  }

  /**
   * Workspace a task executes in.
   *
   * `task.workspace.path` is canonical (add_task canonicalizes through
   * realpath), so it is used verbatim — worker construction, tool cwd and the
   * permission-gate boundary all read this single value, never a path
   * re-assembled from the process workspace. Tasks without a workspace stamp
   * (written before workspaces existed, restored from an older session, or
   * dispatched internally) fall back to the process workspace.
   */
  protected taskWorkspaceDir(task: TaskDetail): string {
    return task.workspace?.path ?? this.ctx.workspaceDir;
  }

  protected removeWorkerTracking(workerId: string): void {
    // Clear any pending idle reaper (shouldn't exist for disposed workers, but be safe)
    this.clearIdleTimer(workerId);
    this.workerTurnLineage.delete(workerId);
    // Delayed removal: wait for UI to unmount
    setTimeout(() => {
      this.permissionResolvers.get(workerId)?.cleanup();
      this.permissionResolvers.delete(workerId);
      this.cleanupInquiryRegistry(workerId);
      this.workers.delete(workerId);
      this.workerTaskMap.delete(workerId);
    }, 0);
  }
}
