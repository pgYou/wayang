// WorkerDispatchEngine: scheduling (direct calls, no hooks), abort, worker
// spawn / idle reuse, and the done/fail resolution handlers. Extends
// WorkerWiringEngine.

import type { IWorkerInstance, TaskDetail, WorkerResult } from '@/types/index';
import { WorkerAgent } from '@/services/agents/worker-agent';
import { ClaudeCodeWorker } from '@/services/agents/claude-code-worker';
import { CodebuddyAcpWorker } from '@/services/agents/acp/codebuddy-acp-worker';
import { OpenCodeAcpWorker } from '@/services/agents/acp/opencode-acp-worker';
import { getWorkerMeta } from '@/services/agents/worker-defaults';
import { formatLlmError } from '@/utils/llm-error';
import { generateId } from '@/utils/id';
import { WorkerWiringEngine } from './worker-wiring';
import { PUPPET_WORKER_TYPE } from './engine-base';

export class WorkerDispatchEngine extends WorkerWiringEngine {
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
  // Private: worker spawn + lifecycle
  // ---------------------------------------------------------------------------

  protected createWorker(workerType: string, task: TaskDetail): IWorkerInstance {
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
      // ACP workers: same constructor shape as ClaudeCodeWorker (freeze §7 ①).
      // Construction never spawns — a missing CLI fails fast in run() (C1
      // preflight), so the createWorker stage cannot crash on it.
      case 'codebuddy-acp':
        return new CodebuddyAcpWorker(config, this.ctx.sessionDir, workspaceDir, this.ctx, this.skills);
      case 'opencode-acp':
        return new OpenCodeAcpWorker(config, this.ctx.sessionDir, workspaceDir, this.ctx, this.skills);
      default: {
        // Exhaustiveness: a new WORKER_TYPES entry without a case above fails
        // lint here (05 §1). The runtime guard stays for configs that never
        // went through validateConfig (engine used directly in tests).
        const _exhaustive: never = config.type;
        throw new Error(`Unsupported worker type: "${_exhaustive}"`);
      }
    }
  }

  protected async spawnWorker(task: TaskDetail, workerId: string): Promise<WorkerResult> {
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
  protected buildProgressEmitter(
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

  protected handleDone(workerId: string, task: TaskDetail, result: WorkerResult): void {
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

  protected handleFail(workerId: string, task: TaskDetail, error: string): void {
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
  protected consumeCancelled(taskId: string): boolean {
    if (!this.cancelledTaskIds.has(taskId)) return false;
    this.cancelledTaskIds.delete(taskId);
    this.logger.info({ taskId }, 'Worker resolution for cancelled task suppressed');
    return true;
  }
}
