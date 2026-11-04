/**
 * TaskExecuteEngine — unified task + worker lifecycle manager.
 *
 * Merges TaskPool (task state machine), TaskScheduler (scheduling),
 * WorkerFactory (worker creation), and worker instance tracking into
 * a single cohesive domain object.
 *
 * Responsibilities:
 *   1. Task state machine: pending → running → completed/failed/cancelled
 *   2. Scheduling: dequeue pending tasks up to maxConcurrency, spawn workers
 *   3. Worker lifecycle: create, track, abort, cleanup
 *   4. Signal emission: notify controller of worker completion/failure/progress
 *
 * Scheduling is driven by direct method calls (add → scheduleNext),
 * NOT by lifecycle hooks. This keeps core flow explicit and traceable.
 */

import type { SystemContext } from '@/infra/system-context';
import type { SignalQueue } from '@/services/signal/signal-queue';
import type { Logger } from '@/infra/logger';
import type { TaskDetail, WorkerResult, WorkerConfig, ProviderConfig, IWorkerInstance, ActiveWorkerInfo, WorkerLiveStatus, NewSignalInput, SignalTurnLineage, TaskCancelledSignalPayload, TaskQueuedSignalPayload, WorkerStartedSignalPayload, ConversationEntry } from '@/types/index';
import { summarizeTranscript } from '@/services/worker-transcript';
import { TaskPoolState } from '@/services/task/task-pool-state';
import { BaseWayangState } from '@/infra/state/base-state';
import type { Subscribable } from '@/infra/state/subscribable';
import type { StateEvent } from '@/infra/state/base-state';
import { WorkerAgent } from '@/services/agents/worker-agent';
import type { SkillRegistry } from '@/services/skills/registry';
import type { PermissionConfig } from '@/types/config';

/** Runtime-only observable state — no file persistence, no restore needed. */
class RuntimeState extends BaseWayangState {
  constructor(initialData: Record<string, unknown>) {
    super(initialData, []);
  }
  async restore(): Promise<void> { /* no-op: runtime-only */ }
}
import { ClaudeCodeWorker } from '@/services/agents/claude-code-worker';
import { getWorkerMeta } from '@/services/agents/worker-defaults';
import { createWorkerTools } from '@/services/tools/index';
import { askControllerTool } from '@/services/tools/ask-controller';
import { wrapWithPermissionMiddleware, type PermissionMiddlewareResult } from '@/services/tools/permission-middleware';
import { FILE_TOOL_NAMES, decideToolAccess, type WorkerAccessScope } from '@/services/tools/permission-rules';
import { BlockingRequestMap } from '@/infra/blocking-requests';
import { generateId } from '@/utils/id';
import { formatLlmError } from '@/utils/llm-error';
import { basename, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { wayangDirForSessionDir } from '@/infra/session-helpers';
import { normalizeWorkspacePath } from '@/infra/workspace-registry';
import type { WorkspaceRef } from '@/infra/workspace-registry';

const PUPPET_WORKER_TYPE = 'puppet';

/**
 * The user's home directory a session belongs to — the anchor of the path
 * permission policy (sensitive list + read scope).
 *
 * The wayang data dir lives at `<userHome>/.wayang`, so its parent is the home
 * the policy anchors on. Ad-hoc session dirs (hand-built temp dirs in tests)
 * don't follow the `<wayangDir>/sessions/<id>` layout, so fall back to the OS
 * home rather than guessing a parent. Derived ONCE at construction and injected
 * into every policy call — the decision code never reads it globally.
 */
function resolveUserHomeDir(sessionDir: string): string {
  const wayangDir = wayangDirForSessionDir(sessionDir);
  return wayangDir && basename(wayangDir) === '.wayang' ? dirname(wayangDir) : homedir();
}

/** Construction options for TaskExecuteEngine. */
export interface TaskExecuteEngineOptions {
  /**
   * The user's home directory the path permission policy anchors on (sensitive
   * list and read scope). Derived from `ctx.sessionDir` when omitted; inject it
   * explicitly in tests (which use temp home dirs) or whenever the session
   * layout does not follow `<userHome>/.wayang/sessions/<id>`.
   */
  homeDir?: string;
  /**
   * User-config permission section (`allowedDirs` / `autoAllowRoots` /
   * `sensitiveDirs`, plus the deprecated `deniedDirs` alias and
   * `sensitiveMode`) the policy consults. Defaults to `ctx.config.permission`;
   * injectable so a caller can hand the engine the exact policy it should
   * enforce instead of relying on ambient config.
   */
  permission?: PermissionConfig;
  /**
   * Notified when a task is accepted for a workspace, so the owning session
   * can accumulate every workspace it dispatches work into. The engine stays
   * unaware of session persistence — Supervisor supplies an implementation
   * that appends to the session's `meta.workspaces` (idempotent by canonical
   * path). Optional: without it, workspace accumulation simply does not
   * happen (used by tests and by direct engine construction).
   */
  onTaskWorkspace?: (workspace: WorkspaceRef) => void;
}

/** Default idle timeout: idle workers are reaped after 30 minutes if not reused. */
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** How long a worker waits for a controller answer before continuing on its own. */
const INQUIRY_TIMEOUT_MS = 300_000;

/** Resolution of a pending ask_controller call, settled via the registry. */
export type WorkerInquiryResolution =
  | { kind: 'answer'; answer: string }
  | { kind: 'timeout' }
  | { kind: 'aborted' };

/**
 * Outcome of delivering a controller message to a worker.
 * - 'delivered' / 'queued': the worker accepted the message (it reads it at
 *   its next step / turn boundary / stage start).
 * - 'finished': the worker is still listed as running but can no longer take
 *   input (a third-party worker's session ended) — the message was NOT
 *   delivered and the caller must report failure.
 * - 'not_running': no such active worker.
 */
export type WorkerMessageDelivery = 'delivered' | 'queued' | 'finished' | 'not_running';

// ---------------------------------------------------------------------------
// TaskExecuteEngine
// ---------------------------------------------------------------------------

export class TaskExecuteEngine implements Subscribable {
  private taskState: TaskPoolState;
  private workerState: RuntimeState;

  private readonly logger: Logger;
  private readonly maxConcurrency: number;
  private readonly workerProvider: ProviderConfig;
  private readonly workerConfigs?: Record<string, WorkerConfig>;
  private readonly skills: SkillRegistry;

  /** Worker instance tracking. */
  private workers = new Map<string, IWorkerInstance>();
  /** Reverse mapping: workerId → taskId. */
  private workerTaskMap = new Map<string, string>();
  /** Permission middleware resolvers keyed by workerId. */
  private permissionResolvers = new Map<string, PermissionMiddlewareResult>();
  /** ask_controller blocking-request registries keyed by workerId. */
  private inquiryRegistries = new Map<string, BlockingRequestMap<WorkerInquiryResolution>>();
  /**
   * Inquiry ids aborted by worker shutdown/cancel. Lets a late respond_inquiry
   * distinguish "worker gone" from "timed out" even while other workers'
   * registries are still alive.
   */
  private abortedInquiryIds = new Set<string>();
  /**
   * Turn lineage of each active worker's current run: the execution turn id
   * (also handed to the worker for stamping its entries), the chain's root
   * turn, and the task id (used as signals' causationId).
   */
  private workerTurnLineage = new Map<string, { turnId: string; rootTurnId?: string; taskId: string }>();
  /**
   * Running tasks cancelled via cancel(): their (aborted) worker resolution
   * must not re-classify the task or emit a worker_failed signal — the
   * task_cancelled signal was already emitted at cancel time. Cleared when
   * the worker's run promise settles (handleDone/handleFail).
   */
  private cancelledTaskIds = new Set<string>();
  /** Idle-reaping timers keyed by workerId (multi-stage workers only). */
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Idle TTL (ms). Idle workers are disposed after this if not reused. */
  private readonly idleTimeoutMs: number;
  /** The user's home directory the path permission policy anchors on. */
  private readonly homeDir: string;
  /** User-config permission section applied to this run's worker tools. */
  private readonly permission?: PermissionConfig;
  /** Session-side hook: remember every workspace a task is accepted for. */
  private readonly onTaskWorkspace?: (workspace: WorkspaceRef) => void;

  constructor(
    private readonly ctx: SystemContext,
    private readonly signalQueue: SignalQueue,
    skills: SkillRegistry,
    options: TaskExecuteEngineOptions = {},
  ) {
    this.logger = ctx.logger;
    this.homeDir = options.homeDir ?? resolveUserHomeDir(ctx.sessionDir);
    this.permission = options.permission ?? ctx.config.permission;
    this.onTaskWorkspace = options.onTaskWorkspace;
    this.maxConcurrency = ctx.maxConcurrency;
    this.workerProvider = ctx.workerProvider;
    this.workerConfigs = ctx.config.workers;
    this.skills = skills;
    this.idleTimeoutMs = ctx.config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

    // Internal state objects
    this.taskState = new TaskPoolState(ctx);
    this.workerState = new RuntimeState({ activeWorkers: [] as ActiveWorkerInfo[] });
  }

  // ---------------------------------------------------------------------------
  // Subscribable
  // ---------------------------------------------------------------------------

  subscribe(path: string, callback: (event: StateEvent) => void): () => void {
    if (path.startsWith('tasks.')) return this.taskState.on(path, callback);
    if (path === 'activeWorkers' || path.startsWith('activeWorkers.')) return this.workerState.on(path, callback);
    throw new Error(`TaskExecuteEngine: unknown subscription path "${path}"`);
  }

  getSnapshot<T>(path: string): T {
    if (path.startsWith('tasks.')) return this.taskState.get(path);
    if (path === 'activeWorkers' || path.startsWith('activeWorkers.')) return this.workerState.get(path);
    throw new Error(`TaskExecuteEngine: unknown snapshot path "${path}"`);
  }

  // ---------------------------------------------------------------------------
  // Task management
  // ---------------------------------------------------------------------------

  /**
   * Add a task and immediately attempt to schedule it.
   *
   * Returns the engine worker id when the task was scheduled right away (a
   * worker_started signal follows), or undefined when every concurrency slot
   * is busy — in that case a task_queued signal is emitted exactly once so the
   * controller can tell "waiting for a slot" from "running" (issue #30). The
   * task starts automatically when a slot frees.
   */
  add(task: TaskDetail): string | undefined {
    this.taskState.append('tasks.pending', task);
    this.recordTaskWorkspace(task);
    this.logger.info({ taskId: task.id }, 'Task added');
    this.ctx.hooks.emit('task:added', task);
    this.scheduleNext();

    // Synchronous scheduling: the task either moved to running (spawn is
    // fire-and-forget, so the running entry exists already) or is still
    // pending because all slots are occupied.
    const running = this.taskState.get<TaskDetail[]>('tasks.running');
    const started = running.find(t => t.id === task.id);
    if (started?.workerSessionId) return started.workerSessionId;

    this.emitTaskQueued(task);
    return undefined;
  }

  get(id: string): TaskDetail | undefined {
    const all = [
      ...this.taskState.get<TaskDetail[]>('tasks.pending'),
      ...this.taskState.get<TaskDetail[]>('tasks.running'),
      ...this.taskState.get<TaskDetail[]>('tasks.history'),
    ];
    return all.find(t => t.id === id);
  }

  list(status?: TaskDetail['status']): TaskDetail[] {
    if (!status) {
      return [
        ...this.taskState.get<TaskDetail[]>('tasks.pending'),
        ...this.taskState.get<TaskDetail[]>('tasks.running'),
        ...this.taskState.get<TaskDetail[]>('tasks.history'),
      ];
    }
    if (status === 'pending') return [...this.taskState.get<TaskDetail[]>('tasks.pending')];
    if (status === 'running') return [...this.taskState.get<TaskDetail[]>('tasks.running')];
    return this.taskState.get<TaskDetail[]>('tasks.history').filter(t => t.status === status);
  }

  cancel(id: string): boolean {
    // Try running first — abort the worker
    const running = this.taskState.get<TaskDetail[]>('tasks.running');
    const runIdx = running.findIndex(t => t.id === id);
    if (runIdx !== -1) {
      const task = running[runIdx];
      const workerId = [...this.workerTaskMap.entries()].find(([, tId]) => tId === id)?.[0];
      this.abortByTaskId(id);
      this.moveToHistory(id, 'cancelled', {});
      // Suppress the spurious worker_failed signal the aborted worker's
      // resolution would otherwise emit (handleDone/handleFail consult the
      // cancelled set) and announce the cancellation with its own subtype.
      this.cancelledTaskIds.add(id);
      this.emitTaskCancelled(task, workerId);
      this.logger.info({ taskId: id }, 'Running task cancelled');
      this.ctx.hooks.emit('task:cancelled', { taskId: id });
      return true;
    }

    // Then try pending
    const pending = [...this.taskState.get<TaskDetail[]>('tasks.pending')];
    const pendIdx = pending.findIndex(t => t.id === id);
    if (pendIdx !== -1) {
      const [task] = pending.splice(pendIdx, 1);
      this.taskState.set('tasks.pending', pending);
      this.taskState.append('tasks.history', {
        ...task,
        status: 'cancelled',
        completedAt: Date.now(),
      });
      // No worker was ever spawned — announce directly so the dispatching
      // controller turn resolves as cancelled instead of running forever.
      this.emitTaskCancelled(task);
      this.logger.info({ taskId: id }, 'Pending task cancelled');
      this.ctx.hooks.emit('task:cancelled', { taskId: id });
      return true;
    }

    this.logger.warn({ taskId: id }, 'Task not found for cancel');
    return false;
  }

  /**
   * Announce a task cancellation on the signal queue (subtype
   * task_cancelled — terminal for the dispatched task, but not a failure).
   * Running tasks carry their worker's lineage; pending tasks fall back to
   * the task's own chain fields.
   */
  private emitTaskCancelled(task: TaskDetail, workerId?: string): void {
    const workerType = task.workerType ?? PUPPET_WORKER_TYPE;
    const meta = getWorkerMeta(workerType, this.workerConfigs);
    const payload: TaskCancelledSignalPayload = {
      taskId: task.id,
      ...(workerId !== undefined && { workerId }),
      taskTitle: task.title,
      workerType,
      emoji: meta.emoji,
    };
    if (workerId !== undefined) {
      this.enqueueWorkerSignal(workerId, { source: 'system', type: 'task_cancelled', payload });
      return;
    }
    this.signalQueue.enqueue({
      source: 'system',
      type: 'task_cancelled',
      payload,
      ...((task.rootTurnId ?? task.turnId) !== undefined && { rootTurnId: task.rootTurnId ?? task.turnId }),
      causationId: task.id,
    } as NewSignalInput);
  }

  /**
   * Announce that a task is stuck in the pending queue — every concurrency
   * slot is busy (issue #30). Emitted at most once per task (from add(), the
   * only entry point into the pending queue). No worker exists yet, so the
   * payload carries task identity only; a later worker_started signal names
   * the worker that eventually picks the task up.
   */
  private emitTaskQueued(task: TaskDetail): void {
    const workerType = task.workerType ?? PUPPET_WORKER_TYPE;
    const meta = getWorkerMeta(workerType, this.workerConfigs);
    const payload: TaskQueuedSignalPayload = {
      taskId: task.id,
      taskTitle: task.title,
      workerType,
      emoji: meta.emoji,
      message: `All concurrency slots are busy — the task is queued and will start automatically when a slot frees.`,
    };
    this.signalQueue.enqueue({
      source: 'system',
      type: 'task_queued',
      payload,
      ...((task.rootTurnId ?? task.turnId) !== undefined && { rootTurnId: task.rootTurnId ?? task.turnId }),
      causationId: task.id,
    } as NewSignalInput);
  }

  /**
   * Announce that a worker actually began a task (issue #30): fresh spawn or
   * idle-worker reuse (`reused`). Called after the worker is registered and
   * its execution turn recorded, so the signal carries the worker's lineage.
   * If creating the worker instance throws, no started signal is emitted —
   * the existing failed signal (handleFail) is the only outcome.
   */
  private emitWorkerStarted(
    task: TaskDetail,
    workerId: string,
    workerType: string,
    reused: boolean,
  ): void {
    const meta = getWorkerMeta(workerType, this.workerConfigs);
    const payload: WorkerStartedSignalPayload = {
      taskId: task.id,
      workerId,
      taskTitle: task.title,
      workerType,
      emoji: meta.emoji,
      message: reused
        ? 'Idle multi-stage worker reused for this stage (it kept its context).'
        : 'Worker spawned and started the task.',
      reused,
    };
    this.enqueueWorkerSignal(workerId, {
      source: 'worker',
      type: 'worker_started',
      payload,
    });
  }

  updatePending(id: string, updates: Partial<Pick<TaskDetail, 'description' | 'priority'>>): boolean {
    const pending = [...this.taskState.get<TaskDetail[]>('tasks.pending')];
    const idx = pending.findIndex(t => t.id === id);
    if (idx === -1) {
      this.logger.warn({ taskId: id }, 'Task not found in pending for update');
      return false;
    }
    pending[idx] = { ...pending[idx], ...updates };
    this.taskState.set('tasks.pending', pending);
    this.logger.info({ taskId: id, updates }, 'Pending task updated');
    return true;
  }

  /** Validate that a worker type is known. Returns error message or null. */
  validateWorkerType(type: string): string | null {
    if (type === PUPPET_WORKER_TYPE) return null;
    const config = this.workerConfigs?.[type];
    if (!config) return `Unknown worker type: "${type}". Available: puppet${Object.keys(this.workerConfigs ?? {}).map(k => `, ${k}`).join('')}`;
    if (config.enable === false) return `Worker "${type}" is disabled`;
    return null;
  }

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

  /** Resolve a pending permission request. Returns false if not found. */
  resolvePermission(requestId: string, approved: boolean, reason?: string): boolean {
    for (const resolver of this.permissionResolvers.values()) {
      if (resolver.resolvePermission(requestId, approved, reason)) {
        return true;
      }
    }
    return false;
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
  private cleanupInquiryRegistry(workerId: string): void {
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
  private emitUndeliveredIfAny(
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

  // ---------------------------------------------------------------------------
  // Worker turn lineage
  // ---------------------------------------------------------------------------

  /**
   * Register the execution turn for a worker run and return it. The id is
   * handed to the worker (stamped on its entries) and reused on every signal
   * the engine emits for this worker, so the worker's conversation file and
   * the controller's signal records share the same turn id.
   */
  private registerWorkerTurn(workerId: string, task: TaskDetail): string {
    const executionTurnId = generateId('turn');
    this.workerTurnLineage.set(workerId, {
      turnId: executionTurnId,
      ...(task.rootTurnId !== undefined && { rootTurnId: task.rootTurnId }),
      ...(task.rootTurnId === undefined && task.turnId !== undefined && { rootTurnId: task.turnId }),
      taskId: task.id,
    });
    return executionTurnId;
  }

  /** Turn lineage to attach to signals emitted for a worker. */
  private workerLineage(workerId: string): SignalTurnLineage {
    const lin = this.workerTurnLineage.get(workerId);
    if (!lin) return {};
    return {
      turnId: lin.turnId,
      ...(lin.rootTurnId !== undefined && { rootTurnId: lin.rootTurnId }),
      causationId: lin.taskId,
    };
  }

  /** Enqueue a worker signal with the worker's turn lineage attached. */
  private enqueueWorkerSignal(workerId: string, sig: NewSignalInput): void {
    this.signalQueue.enqueue({ ...sig, ...this.workerLineage(workerId) } as NewSignalInput);
  }

  // ---------------------------------------------------------------------------
  // Scheduling (direct calls, no hooks)
  // ---------------------------------------------------------------------------

  /** Attempt to schedule pending tasks up to maxConcurrency. */
  scheduleNext(): void {
    // Idle workers also occupy a concurrency slot, so they count here.
    while (this.hasPending() && this.getOccupiedSlots() < this.maxConcurrency) {
      const task = this.peekHighestPriority();
      if (!task) break;

      const workerId = generateId('w');
      const workerType = task.workerType ?? PUPPET_WORKER_TYPE;
      const meta = getWorkerMeta(workerType, this.workerConfigs);

      this.moveToRunning(task.id, workerId);
      this.addActiveWorker({
        workerId,
        taskId: task.id,
        startedAt: Date.now(),
        workerType: meta.label,
        taskTitle: task.title,
        emoji: meta.emoji,
        status: 'running',
      });

      // Fire-and-forget worker run
      this.spawnWorker(task, workerId)
        .then((result) => this.handleDone(workerId, task, result))
        .catch((err) => this.handleFail(workerId, task, formatLlmError(err)));

      this.logger.info({ taskId: task.id, workerId }, 'Worker spawned');
    }
  }

  // ---------------------------------------------------------------------------
  // Worker abort
  // ---------------------------------------------------------------------------

  abortByTaskId(taskId: string): void {
    for (const [workerId, tId] of this.workerTaskMap) {
      if (tId === taskId) {
        const worker = this.workers.get(workerId);
        worker?.abort();
        this.permissionResolvers.get(workerId)?.cleanup();
        this.cleanupInquiryRegistry(workerId);
        this.logger.info({ workerId, taskId }, 'Worker aborted');
        return;
      }
    }
    this.logger.warn({ taskId }, 'No running worker found for task abort');
  }

  /**
   * Dispose a worker directly by id. Handles both running and idle workers.
   * Used to manually reap an idle multi-stage worker.
   */
  abortByWorkerId(workerId: string): boolean {
    const info = this.getActiveWorkers().find(w => w.workerId === workerId);
    if (!info) return false;

    if (info.status === 'idle') {
      this.disposeIdleWorker(workerId, 'manual dispose');
      return true;
    }

    const worker = this.workers.get(workerId);
    worker?.abort();
    this.permissionResolvers.get(workerId)?.cleanup();
    this.cleanupInquiryRegistry(workerId);
    this.logger.info({ workerId }, 'Worker aborted by id');
    return true;
  }

  /** Abort all workers. Used during shutdown. */
  abortAll(): void {
    // Cancel any pending permission resolvers + blocking inquiries
    for (const resolver of this.permissionResolvers.values()) {
      resolver.cleanup();
    }
    this.permissionResolvers.clear();
    for (const workerId of this.inquiryRegistries.keys()) {
      this.cleanupInquiryRegistry(workerId);
    }
    this.inquiryRegistries.clear();
    // Clear all idle reapers
    for (const workerId of this.idleTimers.keys()) {
      this.clearIdleTimer(workerId);
    }
    for (const worker of this.workers.values()) {
      worker.abort();
    }
    // Cancel all running tasks
    const running = this.list('running');
    for (const task of running) {
      this.cancel(task.id);
    }
    this.workers.clear();
    this.workerTaskMap.clear();
    // Drop all active worker entries (idle + running)
    this.workerState.set('activeWorkers', []);
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  /**
   * Restore persisted tasks and recover from a crashed run.
   *
   * @param fallbackWorkspace  The resumed session's workspace identity. Tasks
   *   written before workspace attribution existed have no `workspace`, so it
   *   is filled in from here (memory only) before dispatch — otherwise
   *   `taskWorkspaceDir` would fall back to the process workspace, which for a
   *   resumed session may be an entirely different directory.
   */
  async restore(fallbackWorkspace?: WorkspaceRef): Promise<void> {
    await this.taskState.restore();
    if (fallbackWorkspace) {
      this.taskState.fillWorkspaceInMemory(fallbackWorkspace);
    }
    // Crash recovery: mark stale running tasks as failed
    this.recoverCrashedTasks();
  }

  // ---------------------------------------------------------------------------
  // Private: task state helpers
  // ---------------------------------------------------------------------------

  private hasPending(): boolean {
    return this.taskState.get<TaskDetail[]>('tasks.pending').length > 0;
  }

  private peekHighestPriority(): TaskDetail | null {
    const pending = this.taskState.get<TaskDetail[]>('tasks.pending');
    if (pending.length === 0) return null;
    const highIdx = pending.findIndex(t => t.priority === 'high');
    return pending[highIdx !== -1 ? highIdx : 0];
  }

  private moveToRunning(id: string, workerSessionId: string): void {
    const pending = [...this.taskState.get<TaskDetail[]>('tasks.pending')];
    const idx = pending.findIndex(t => t.id === id);
    if (idx === -1) {
      this.logger.warn({ taskId: id }, 'Task not found in pending');
      return;
    }
    const [task] = pending.splice(idx, 1);
    const updated = {
      ...task,
      status: 'running' as const,
      startedAt: Date.now(),
      workerSessionId,
    };
    this.taskState.set('tasks.pending', pending);
    this.taskState.append('tasks.running', updated);
    this.logger.info({ taskId: id, workerId: workerSessionId }, 'Task moved to running');
  }

  /**
   * Record the worker instance's own id (the on-disk transcript directory
   * name) on the running task. Called right after the worker instance is
   * created, before its run starts, so the link is on disk even if the
   * process crashes mid-run.
   */
  private stampWorkerTranscriptId(taskId: string, transcriptId: string): void {
    const running = [...this.taskState.get<TaskDetail[]>('tasks.running')];
    const idx = running.findIndex(t => t.id === taskId);
    if (idx === -1) return;
    if (running[idx].workerTranscriptId === transcriptId) return;
    running[idx] = { ...running[idx], workerTranscriptId: transcriptId };
    this.taskState.set('tasks.running', running);
  }

  private completeTask(id: string, result: string): void {
    this.moveToHistory(id, 'completed', { result });
    this.logger.info({ taskId: id }, 'Task completed');
    this.ctx.hooks.emit('task:completed', { taskId: id });
  }

  private failTask(id: string, error: string): void {
    this.moveToHistory(id, 'failed', { error });
    this.logger.info({ taskId: id, error }, 'Task failed');
    this.ctx.hooks.emit('task:failed', { taskId: id, error });
  }

  private moveToHistory(id: string, status: TaskDetail['status'], extra: Partial<TaskDetail>): void {
    const running = this.taskState.get<TaskDetail[]>('tasks.running');
    const idx = running.findIndex(t => t.id === id);
    if (idx === -1) {
      this.logger.warn({ taskId: id }, 'Task not found in running');
      return;
    }
    const updated = [...running];
    const [task] = updated.splice(idx, 1);
    this.taskState.set('tasks.running', updated);
    this.taskState.append('tasks.history', {
      ...task,
      ...extra,
      status,
      completedAt: Date.now(),
    });
  }

  // ---------------------------------------------------------------------------
  // Private: active workers state
  // ---------------------------------------------------------------------------

  private addActiveWorker(info: ActiveWorkerInfo): void {
    this.workerState.append('activeWorkers', info);
  }

  private updateActiveWorker(workerId: string, updates: Partial<ActiveWorkerInfo>): void {
    const workers = this.workerState.get<ActiveWorkerInfo[]>('activeWorkers');
    const idx = workers.findIndex(w => w.workerId === workerId);
    if (idx === -1) return;
    workers[idx] = { ...workers[idx], ...updates };
    this.workerState.set('activeWorkers', [...workers]);
  }

  private removeActiveWorker(workerId: string): void {
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
  private moveToIdle(workerId: string, task: TaskDetail, summary: string): void {
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
  private startIdleTimer(workerId: string): void {
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

  private clearIdleTimer(workerId: string): void {
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
  private disposeIdleWorker(workerId: string, reason: string): void {
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

  // ---------------------------------------------------------------------------
  // Private: worker spawn + lifecycle
  // ---------------------------------------------------------------------------

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
  private taskWorkspaceDir(task: TaskDetail): string {
    return task.workspace?.path ?? this.ctx.workspaceDir;
  }

  /**
   * Tell the session a task was accepted for `task.workspace`, so a session
   * accumulates every workspace it dispatches work into. Best-effort: recording
   * the identity is bookkeeping, never a precondition for running the task, so
   * a failure (e.g. an unreadable registry) is logged and swallowed rather than
   * failing an accepted task. Tasks without a workspace stamp run in the
   * process workspace, which the session already records — nothing to add.
   */
  private recordTaskWorkspace(task: TaskDetail): void {
    if (!this.onTaskWorkspace || !task.workspace) return;
    try {
      this.onTaskWorkspace(task.workspace);
    } catch (err) {
      this.logger.warn({ taskId: task.id, err }, 'Failed to record task workspace on the session');
    }
  }

  private createWorker(workerType: string, task: TaskDetail): IWorkerInstance {
    const type = workerType ?? PUPPET_WORKER_TYPE;
    const workspaceDir = this.taskWorkspaceDir(task);

    if (type === PUPPET_WORKER_TYPE) {
      return new WorkerAgent(this.workerProvider, this.ctx, this.skills, this.ctx.config.worker.toolChoice, workspaceDir);
    }

    const config = this.workerConfigs?.[type];
    if (!config) {
      throw new Error(`Unknown worker type: "${type}".`);
    }
    if (config.enable === false) {
      throw new Error(`Worker type "${type}" is disabled`);
    }

    switch (config.type) {
      case 'claude-code':
        return new ClaudeCodeWorker(config, this.ctx.sessionDir, workspaceDir, this.ctx, this.skills);
      default:
        throw new Error(`Unsupported worker type: "${config.type}"`);
    }
  }

  private async spawnWorker(task: TaskDetail, workerId: string): Promise<WorkerResult> {
    const workerType = task.workerType ?? PUPPET_WORKER_TYPE;
    const worker = this.createWorker(workerType, task);

    this.workers.set(workerId, worker);
    this.workerTaskMap.set(workerId, task.id);

    // The worker's transcript lives under its OWN id (agent-…/cw-…), not the
    // engine worker id — stamp it on the running task so the on-disk file
    // stays locatable after the worker finished and left this map.
    this.stampWorkerTranscriptId(task.id, worker.id);

    // Execution turn for this worker run — stamped on the worker's entries
    // and on every signal the engine emits for it.
    const executionTurnId = this.registerWorkerTurn(workerId, task);

    // Announce the start (issue #30) — after registration so the signal
    // carries the worker's lineage. A createWorker failure above throws
    // before this point and lands in handleFail (failed signal) instead.
    this.emitWorkerStarted(task, workerId, workerType, false);

    const onProgress = this.buildProgressEmitter(workerId, task, workerType);
    const tools = this.wireWorker(worker, task, workerId, workerType);
    this.logger.info({ workerId, taskId: task.id, workerType, executionTurnId }, 'Worker starting');

    return worker.run({ ...task, workerId, executionTurnId }, tools, onProgress);
  }

  /**
   * Dispatch a follow-up task to an existing idle (multi-stage) worker.
   * Reuses the worker instance + its accumulated conversation context.
   * Returns false if the worker is missing, not idle, or was created in a
   * different workspace than the task executes in.
   */
  assignToExistingWorker(workerId: string, task: TaskDetail): boolean {
    const err = this.validateIdleWorker(workerId);
    if (err) {
      this.logger.warn({ workerId, taskId: task.id, err }, 'Cannot assign to worker');
      return false;
    }

    const worker = this.workers.get(workerId);
    if (!worker) {
      this.logger.warn({ workerId }, 'Idle worker instance missing');
      return false;
    }

    // Reuse is workspace-bound — enforced here, the single choke point every
    // reuse goes through, so a caller that skipped the add_task pre-check
    // (direct engine call, future dispatch path) cannot cross workspaces.
    const taskWorkspace = this.taskWorkspaceDir(task);
    const workspaceErr = this.validateWorkerWorkspace(workerId, taskWorkspace);
    if (workspaceErr) {
      this.logger.warn(
        { workerId, taskId: task.id, taskWorkspace, err: workspaceErr },
        'Refusing to reuse a worker across workspaces',
      );
      return false;
    }

    const workerType = task.workerType ?? PUPPET_WORKER_TYPE;
    const meta = getWorkerMeta(workerType, this.workerConfigs);

    // Cancel the idle reaper — worker is being reused
    this.clearIdleTimer(workerId);

    // Transition task → running. This task never went through `add()` (it was
    // assigned straight to the idle worker), so append to running directly —
    // moveToRunning would no-op on the pending-list miss and the task would
    // stay invisible to every view (list_tasks, TUI, history).
    const taskWithOrigin: TaskDetail = {
      ...task,
      assignedFromWorkerId: workerId,
      status: 'running' as const,
      startedAt: Date.now(),
      workerSessionId: workerId,
      // Same instance keeps writing the same conversation.jsonl.
      workerTranscriptId: worker.id,
    };
    this.taskState.append('tasks.running', taskWithOrigin);
    this.recordTaskWorkspace(taskWithOrigin);
    this.workerTaskMap.set(workerId, task.id);
    // New stage, new execution turn (the worker's conversation accumulates,
    // but each run is its own agent activation).
    const executionTurnId = this.registerWorkerTurn(workerId, taskWithOrigin);

    // Announce the reuse as a start event (issue #30) — same lifecycle
    // signal as a fresh spawn, marked reused.
    this.emitWorkerStarted(task, workerId, workerType, true);

    this.updateActiveWorker(workerId, {
      status: 'running',
      taskId: task.id,
      taskTitle: task.title,
      workerType: meta.label,
      emoji: meta.emoji,
      startedAt: Date.now(),
      lastStageSummary: undefined,
      idleSinceMs: undefined,
    });

    const onProgress = this.buildProgressEmitter(workerId, task, workerType);
    const tools = this.wireWorker(worker, task, workerId, workerType);
    this.logger.info({ workerId, taskId: task.id, workerType, executionTurnId }, 'Idle worker reused');

    // Fire-and-forget, same lifecycle as spawnWorker
    worker.run({ ...taskWithOrigin, workerId, executionTurnId }, tools, onProgress)
      .then((result) => this.handleDone(workerId, taskWithOrigin, result))
      .catch((err) => this.handleFail(workerId, taskWithOrigin, formatLlmError(err)));

    return true;
  }

  /**
   * Build the onProgress callback that emits a worker progress signal.
   * Shared between spawn and assign paths.
   */
  private buildProgressEmitter(
    workerId: string,
    task: TaskDetail,
    workerType: string,
  ): (msg: string) => void {
    const meta = getWorkerMeta(workerType, this.workerConfigs);
    return (msg: string) => {
      const activity = this.getWorkerActivity(workerId);
      this.enqueueWorkerSignal(workerId, {
        source: 'worker',
        type: 'progress',
        payload: {
          workerId, taskId: task.id, taskTitle: task.title, workerType, emoji: meta.emoji, message: msg,
          // Activity rides along (issue #16) so the controller sees liveness
          // from the signal itself instead of polling.
          lastActivityAt: activity.lastActivityAt,
          currentTool: activity.currentTool,
        },
      });
    };
  }

  /**
   * Wire Wayang tools + permission middleware + signal context onto a worker.
   * Shared between fresh-spawn and idle-reuse paths.
   * Returns the tool set ready for `worker.run()`.
   */
  private wireWorker(
    worker: IWorkerInstance,
    task: TaskDetail,
    workerId: string,
    workerType: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous zod-inferred tool set feeding IWorkerInstance.run (see common.ts relaxation boundary)
  ): Record<string, any> {
    const workerMeta = getWorkerMeta(workerType, this.workerConfigs);
    // Single source of truth for this run's filesystem boundary: the task's
    // own workspace (canonical), falling back to the process workspace only
    // for tasks without an identity. Derived once so the tool cwd, the
    // permission gate and the call descriptions cannot drift apart.
    const workspace = this.taskWorkspaceDir(task);

    // Everything the shared access policy needs for this run, assembled once:
    // the task's workspace is the cwd and the writable boundary, the user's
    // home anchors the sensitive list / read scope, the task's allowedDirs are
    // the per-task grant and the config section supplies user allow/sensitive
    // roots.
    const accessScope: WorkerAccessScope = {
      homeDir: this.homeDir,
      workspace,
      taskAllowedDirs: task.taskAllowedDirs,
      permission: this.permission,
    };

    // Blocking-request registry for this worker run's ask_controller calls.
    const inquiryRegistry = new BlockingRequestMap<WorkerInquiryResolution>();
    this.inquiryRegistries.set(workerId, inquiryRegistry);
    const askAndWait = async (question: string, context?: string): Promise<string> => {
      const inquiryId = generateId('inq');
      this.enqueueWorkerSignal(workerId, {
        source: 'worker',
        type: 'worker_inquiry',
        payload: {
          inquiryId, workerId,
          taskId: task.id, taskTitle: task.title,
          workerType, emoji: workerMeta.emoji,
          question,
          ...(context !== undefined && { context }),
        },
      });
      const resolution = await inquiryRegistry.wait(inquiryId, INQUIRY_TIMEOUT_MS, () => {
        // Timed out — the worker continues on its own; tell the controller.
        this.enqueueWorkerSignal(workerId, {
          source: 'system',
          type: 'inquiry_timeout',
          payload: { inquiryId, workerId, taskId: task.id, taskTitle: task.title, workerType, emoji: workerMeta.emoji, question },
        });
        return { kind: 'timeout' as const };
      });
      if (resolution.kind === 'answer') return `[Controller] ${resolution.answer}`;
      if (resolution.kind === 'timeout') {
        return '[TIMEOUT] No answer from the controller within 5 minutes. Use your best judgment to continue and report the decision via update_progress or done.';
      }
      return '[ABORTED] Worker is shutting down.';
    };

    // Puppet workers need Wayang tools; third-party workers don't use them
    let tools = workerType === PUPPET_WORKER_TYPE
      ? {
          ...createWorkerTools({
          listTasks: (status?: TaskDetail['status']) => this.list(status),
          cwd: workspace,
          tavilyApiKey: this.ctx.config.tavilyApiKey,
          registry: this.skills,
          reportProgress: (msg: string, _percent?: number) => {
            const activity = this.getWorkerActivity(workerId);
            this.enqueueWorkerSignal(workerId, {
              source: 'worker',
              type: 'progress',
              payload: {
                workerId, taskId: task.id, taskTitle: task.title, workerType, emoji: workerMeta.emoji, message: msg,
                lastActivityAt: activity.lastActivityAt,
                currentTool: activity.currentTool,
              },
            });
          },
          onComplete: (summary: string) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- WorkerAgent's terminal methods are not on the IWorkerInstance interface; dispatch by concrete worker type
            (worker as any).complete(summary);
          },
          onFail: (error: string) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see onComplete above
            (worker as any).fail(error);
          },
        }),
          ask_controller: askControllerTool({ ask: askAndWait }),
        }
      : {};

    // Third-party workers get ask_controller through their own channel
    // (ClaudeCodeWorker exposes it as an in-process SDK MCP tool).
    if (worker instanceof ClaudeCodeWorker) {
      worker.setInquirySupport(askAndWait);
    }

    // Apply permission middleware for puppet workers
    if (workerType === PUPPET_WORKER_TYPE) {
      const middleware = wrapWithPermissionMiddleware(tools, {
        gatedTools: ['bash', ...FILE_TOOL_NAMES],
        // Single decision source: the shared access policy (sensitive list →
        // config roots → task allowedDirs → task workspace → read-in-home →
        // ask). `deny` refuses here without ever emitting a permission_request;
        // both `deny` and every answered `ask` are audited (see the middleware).
        decide: (toolName, args) => decideToolAccess(accessScope, toolName, args),
        describeCall: (toolName, args) => {
          if (toolName === 'bash') return `Execute shell command: ${args.command}`;
          if ((FILE_TOOL_NAMES as readonly string[]).includes(toolName)) {
            const rawPath = typeof args.path === 'string' ? args.path : '';
            const resolved = rawPath ? resolve(workspace, rawPath) : workspace;
            return `${toolName}: ${rawPath || '(workspace root)'} (resolved: ${resolved})`;
          }
          return `${toolName}: ${JSON.stringify(args)}`;
        },
      }, {
        workerId,
        taskId: task.id,
        taskTitle: task.title,
        workerType,
        emoji: workerMeta.emoji,
        signalQueue: this.signalQueue,
        turnLineage: this.workerLineage(workerId),
        // Permission audit trail (metadata only) shares the session logger.
        logger: this.ctx.logger,
      });
      tools = middleware.wrappedTools;
      this.permissionResolvers.set(workerId, middleware);
    }

    // Wire signal context for ClaudeCodeWorker (canUseTool + acceptMessage).
    // The SAME access scope used for puppet workers is handed over, so
    // canUseTool reaches identical allow/ask/deny verdicts.
    if (worker instanceof ClaudeCodeWorker) {
      worker.setSignalContext({
        signalQueue: this.signalQueue,
        workerId,
        taskId: task.id,
        taskTitle: task.title,
        workerType,
        emoji: workerMeta.emoji,
        turnLineage: this.workerLineage(workerId),
        accessScope,
      });
      this.permissionResolvers.set(workerId, worker.permissionHandler);
    }

    return tools;
  }

  private handleDone(workerId: string, task: TaskDetail, result: WorkerResult): void {
    // Cancelled task: the task_cancelled signal was already emitted by
    // cancel(); the worker's (aborted or race-completed) resolution must not
    // re-classify the task or emit a worker_failed/completed signal.
    if (this.consumeCancelled(task.id)) {
      this.removeActiveWorker(workerId);
      this.removeWorkerTracking(workerId);
      this.scheduleNext();
      return;
    }

    const workerType = task.workerType ?? PUPPET_WORKER_TYPE;
    const meta = getWorkerMeta(workerType, this.workerConfigs);

    // Failure is never a "stage": always dispose, regardless of multiStage.
    if (result.status !== 'completed') {
      this.failTask(task.id, result.error ?? 'Unknown error');
      this.emitUndeliveredIfAny(workerId, { taskId: task.id, taskTitle: task.title, workerType, emoji: meta.emoji }, 'task_finished');
      this.enqueueWorkerSignal(workerId, {
        source: 'worker',
        type: 'failed',
        payload: {
          taskId: task.id, workerId, taskTitle: task.title,
          workerType, emoji: meta.emoji, error: result.error ?? 'Unknown error',
        },
      });
      this.removeActiveWorker(workerId);
      this.removeWorkerTracking(workerId);
      this.scheduleNext();
      return;
    }

    // Completed. Multi-stage workers park in `idle` instead of being disposed.
    if (task.multiStage) {
      this.completeTask(task.id, result.summary ?? '');
      this.enqueueWorkerSignal(workerId, {
        source: 'worker',
        type: 'completed',
        payload: {
          taskId: task.id, workerId, taskTitle: task.title,
          workerType, emoji: meta.emoji, summary: result.summary,
        },
      });
      this.moveToIdle(workerId, task, result.summary ?? '');
      this.scheduleNext();
      return;
    }

    // Default path: completed → dispose
    this.completeTask(task.id, result.summary ?? '');
    this.emitUndeliveredIfAny(workerId, { taskId: task.id, taskTitle: task.title, workerType, emoji: meta.emoji }, 'task_finished');
    this.enqueueWorkerSignal(workerId, {
      source: 'worker',
      type: 'completed',
      payload: {
        taskId: task.id, workerId, taskTitle: task.title,
        workerType, emoji: meta.emoji, summary: result.summary,
      },
    });
    this.removeActiveWorker(workerId);
    this.removeWorkerTracking(workerId);
    this.scheduleNext();
  }

  private handleFail(workerId: string, task: TaskDetail, error: string): void {
    // Cancelled task: same short-circuit as handleDone — no failure signal,
    // no state change (the task is already in history as cancelled).
    if (this.consumeCancelled(task.id)) {
      this.removeActiveWorker(workerId);
      this.removeWorkerTracking(workerId);
      this.scheduleNext();
      return;
    }

    const workerType = task.workerType ?? PUPPET_WORKER_TYPE;
    const meta = getWorkerMeta(workerType, this.workerConfigs);

    this.failTask(task.id, error);
    this.emitUndeliveredIfAny(workerId, { taskId: task.id, taskTitle: task.title, workerType, emoji: meta.emoji }, 'task_finished');
    this.enqueueWorkerSignal(workerId, {
      source: 'worker',
      type: 'failed',
      payload: {
        taskId: task.id, workerId, taskTitle: task.title,
        workerType, emoji: meta.emoji, error,
      },
    });

    this.removeActiveWorker(workerId);
    this.removeWorkerTracking(workerId);
    this.scheduleNext();
  }

  /** Whether the task was cancelled; clears the marker (one-shot). */
  private consumeCancelled(taskId: string): boolean {
    if (!this.cancelledTaskIds.has(taskId)) return false;
    this.cancelledTaskIds.delete(taskId);
    this.logger.info({ taskId }, 'Worker resolution for cancelled task suppressed');
    return true;
  }

  private removeWorkerTracking(workerId: string): void {
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

  // ---------------------------------------------------------------------------
  // Private: crash recovery
  // ---------------------------------------------------------------------------

  private recoverCrashedTasks(): void {
    // activeWorkers is runtime-only, always starts empty — no cleanup needed
    const running = this.list('running');
    for (const task of running) {
      this.logger.info({ taskId: task.id }, 'Marking crashed running task as failed');
      this.failTask(task.id, 'Session crashed — task interrupted');
    }
  }
}
