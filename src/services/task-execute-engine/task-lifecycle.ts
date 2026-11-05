// TaskLifecycleEngine: the task state machine (pending -> running ->
// completed/failed/cancelled), task CRUD, the task/worker lifecycle signals
// and the turn-lineage signal helper. Extends TaskEngineBase.

import type {
  NewSignalInput,
  SignalTurnLineage,
  TaskCancelledSignalPayload,
  TaskDetail,
  TaskQueuedSignalPayload,
  WorkerStartedSignalPayload,
} from '@/types/index';
import type { WorkspaceRef } from '@/infra/workspace-registry';
import { getWorkerMeta } from '@/services/agents/worker-defaults';
import { TaskEngineBase, PUPPET_WORKER_TYPE } from './engine-base';

export abstract class TaskLifecycleEngine extends TaskEngineBase {
  /**
   * Methods provided by the dispatch layer (a subclass): scheduling and abort
   * are implemented further down the engine chain.
   */
  abstract scheduleNext(): void;
  abstract abortByTaskId(taskId: string): void;

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
      // Pending tasks never pass through `moveToHistory`, so their approval
      // grants are dropped here (usually none — but a re-queued task could
      // still hold one, and a cancelled task must not).
      this.clearApprovalGrants(id);
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
  protected emitTaskCancelled(task: TaskDetail, workerId?: string): void {
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
  protected emitTaskQueued(task: TaskDetail): void {
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
  protected emitWorkerStarted(
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
  // Worker turn lineage
  // ---------------------------------------------------------------------------

  /** Turn lineage to attach to signals emitted for a worker. */
  protected workerLineage(workerId: string): SignalTurnLineage {
    const lin = this.workerTurnLineage.get(workerId);
    if (!lin) return {};
    return {
      turnId: lin.turnId,
      ...(lin.rootTurnId !== undefined && { rootTurnId: lin.rootTurnId }),
      causationId: lin.taskId,
    };
  }

  /** Enqueue a worker signal with the worker's turn lineage attached. */
  protected enqueueWorkerSignal(workerId: string, sig: NewSignalInput): void {
    this.signalQueue.enqueue({ ...sig, ...this.workerLineage(workerId) } as NewSignalInput);
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

  protected hasPending(): boolean {
    return this.taskState.get<TaskDetail[]>('tasks.pending').length > 0;
  }

  protected peekHighestPriority(): TaskDetail | null {
    const pending = this.taskState.get<TaskDetail[]>('tasks.pending');
    if (pending.length === 0) return null;
    const highIdx = pending.findIndex(t => t.priority === 'high');
    return pending[highIdx !== -1 ? highIdx : 0];
  }

  protected moveToRunning(id: string, workerSessionId: string): void {
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
  protected stampWorkerTranscriptId(taskId: string, transcriptId: string): void {
    const running = [...this.taskState.get<TaskDetail[]>('tasks.running')];
    const idx = running.findIndex(t => t.id === taskId);
    if (idx === -1) return;
    if (running[idx].workerTranscriptId === transcriptId) return;
    running[idx] = { ...running[idx], workerTranscriptId: transcriptId };
    this.taskState.set('tasks.running', running);
  }

  protected completeTask(id: string, result: string): void {
    this.moveToHistory(id, 'completed', { result });
    this.logger.info({ taskId: id }, 'Task completed');
    this.ctx.hooks.emit('task:completed', { taskId: id });
  }

  protected failTask(id: string, error: string): void {
    this.moveToHistory(id, 'failed', { error });
    this.logger.info({ taskId: id, error }, 'Task failed');
    this.ctx.hooks.emit('task:failed', { taskId: id, error });
  }

  protected moveToHistory(id: string, status: TaskDetail['status'], extra: Partial<TaskDetail>): void {
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
    // This is the single exit for a RUNNING task into a terminal state
    // (completed / failed / cancelled), so it is also where the task's
    // approval grants die — a grant must never outlive the task it was given
    // in (issue #46).
    this.clearApprovalGrants(id);
  }

  /**
   * Drop every approval grant remembered for one task.
   *
   * A direct call, not a lifecycle hook: the grant store is part of the
   * permission gate's own semantics (the key #46 invariant is "a grant is
   * task-scoped"), and a hook listener that is missing would silently turn
   * task-scoped approvals into session-scoped ones — exactly the kind of
   * failure `LifecycleHooks` is not meant to own.
   *
   * Called from the terminal transitions only: `moveToHistory` (which serves
   * completed / failed / cancelled) and the pending branch of `cancel()`
   * (a pending task never reaches `moveToHistory`). A multi-stage task parked
   * idle keeps its grants — it is the same task.
   */
  protected clearApprovalGrants(taskId: string): void {
    const cleared = this.approvalGrants.clearTask(taskId);
    if (cleared > 0) {
      this.logger.info({ taskId, grants: cleared }, 'Cleared task approval grants');
    }
  }

  /**
   * Tell the session a task was accepted for `task.workspace`, so a session
   * accumulates every workspace it dispatches work into. Best-effort: recording
   * the identity is bookkeeping, never a precondition for running the task, so
   * a failure (e.g. an unreadable registry) is logged and swallowed rather than
   * failing an accepted task. Tasks without a workspace stamp run in the
   * process workspace, which the session already records — nothing to add.
   */
  protected recordTaskWorkspace(task: TaskDetail): void {
    if (!this.onTaskWorkspace || !task.workspace) return;
    try {
      this.onTaskWorkspace(task.workspace);
    } catch (err) {
      this.logger.warn({ taskId: task.id, err }, 'Failed to record task workspace on the session');
    }
  }

  // ---------------------------------------------------------------------------
  // Private: crash recovery
  // ---------------------------------------------------------------------------

  protected recoverCrashedTasks(): void {
    // activeWorkers is runtime-only, always starts empty — no cleanup needed
    const running = this.list('running');
    for (const task of running) {
      this.logger.info({ taskId: task.id }, 'Marking crashed running task as failed');
      this.failTask(task.id, 'Session crashed — task interrupted');
    }
  }
}
