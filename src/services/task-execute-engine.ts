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
import type { TaskDetail, WorkerResult, WorkerConfig, ProviderConfig, IWorkerInstance, ActiveWorkerInfo } from '@/types/index';
import { TaskPoolState } from '@/services/task/task-pool-state';
import { BaseWayangState } from '@/infra/state/base-state';
import type { Subscribable } from '@/infra/state/subscribable';
import type { StateEvent } from '@/infra/state/base-state';
import { WorkerAgent } from '@/services/agents/worker-agent';

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
import { wrapWithPermissionMiddleware, type PermissionMiddlewareResult } from '@/services/tools/permission-middleware';
import { generateId } from '@/utils/id';
import { formatLlmError } from '@/utils/llm-error';

const PUPPET_WORKER_TYPE = 'puppet';

/**
 * Bash commands matching these patterns require controller approval.
 * Matches at command start or after shell operators (|, ;, &&) to reduce
 * false positives from quoted strings.
 */
const DANGEROUS_BASH_PATTERN = /(?:^|\||;|&&)\s*(?:rm\s|sudo\b|chmod\b|chown\b|mkfs\b|dd\s|shutdown\b|reboot\b|kill\s+-9)/;

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

  /** Worker instance tracking. */
  private workers = new Map<string, IWorkerInstance>();
  /** Reverse mapping: workerId → taskId. */
  private workerTaskMap = new Map<string, string>();
  /** Permission middleware resolvers keyed by workerId. */
  private permissionResolvers = new Map<string, PermissionMiddlewareResult>();

  constructor(
    private readonly ctx: SystemContext,
    private readonly signalQueue: SignalQueue,
  ) {
    this.logger = ctx.logger;
    this.maxConcurrency = ctx.maxConcurrency;
    this.workerProvider = ctx.workerProvider;
    this.workerConfigs = ctx.config.workers;

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

  /** Add a task and immediately attempt to schedule it. */
  add(task: TaskDetail): void {
    this.taskState.append('tasks.pending', task);
    this.logger.info({ taskId: task.id }, 'Task added');
    this.ctx.hooks.emit('task:added', task);
    this.scheduleNext();
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
      this.abortByTaskId(id);
      this.moveToHistory(id, 'cancelled', {});
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
      this.logger.info({ taskId: id }, 'Pending task cancelled');
      this.ctx.hooks.emit('task:cancelled', { taskId: id });
      return true;
    }

    this.logger.warn({ taskId: id }, 'Task not found for cancel');
    return false;
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

  getWorkerState(workerId: string): Subscribable | null {
    const worker = this.workers.get(workerId);
    return worker ?? null;
  }

  /** Send a message to a running worker. Returns false if worker not found. */
  sendMessageToWorker(workerId: string, message: string): boolean {
    const worker = this.workers.get(workerId);
    if (!worker) return false;
    worker.acceptMessage(message);
    return true;
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

  getWorkerConversation(taskId: string): any[] {
    for (const [workerId, tId] of this.workerTaskMap) {
      if (tId === taskId) {
        const worker = this.workers.get(workerId);
        return worker?.getConversation() ?? [];
      }
    }
    return [];
  }

  getRunningCount(): number {
    return this.taskState.get<TaskDetail[]>('tasks.running').length;
  }

  // ---------------------------------------------------------------------------
  // Scheduling (direct calls, no hooks)
  // ---------------------------------------------------------------------------

  /** Attempt to schedule pending tasks up to maxConcurrency. */
  scheduleNext(): void {
    while (this.hasPending() && this.getRunningCount() < this.maxConcurrency) {
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
        this.logger.info({ workerId, taskId }, 'Worker aborted');
        return;
      }
    }
    this.logger.warn({ taskId }, 'No running worker found for task abort');
  }

  /** Abort all workers. Used during shutdown. */
  abortAll(): void {
    for (const worker of this.workers.values()) {
      worker.abort();
    }
    // Clean up all pending permission resolvers
    for (const resolver of this.permissionResolvers.values()) {
      resolver.cleanup();
    }
    this.permissionResolvers.clear();
    // Cancel all running tasks
    const running = this.list('running');
    for (const task of running) {
      this.cancel(task.id);
    }
    this.workers.clear();
    this.workerTaskMap.clear();
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  async restore(): Promise<void> {
    await this.taskState.restore();
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

  private removeActiveWorker(workerId: string): void {
    const workers = this.workerState.get<ActiveWorkerInfo[]>('activeWorkers');
    const idx = workers.findIndex(w => w.workerId === workerId);
    if (idx !== -1) {
      this.workerState.remove('activeWorkers', idx);
    }
  }

  // ---------------------------------------------------------------------------
  // Private: worker spawn + lifecycle
  // ---------------------------------------------------------------------------

  private createWorker(workerType: string): IWorkerInstance {
    const type = workerType ?? PUPPET_WORKER_TYPE;

    if (type === PUPPET_WORKER_TYPE) {
      return new WorkerAgent(this.workerProvider, this.ctx);
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
        return new ClaudeCodeWorker(config, this.ctx.sessionDir, this.ctx.workspaceDir, this.ctx);
      default:
        throw new Error(`Unsupported worker type: "${config.type}"`);
    }
  }

  private async spawnWorker(task: TaskDetail, workerId: string): Promise<WorkerResult> {
    const workerType = task.workerType ?? PUPPET_WORKER_TYPE;
    const worker = this.createWorker(workerType);

    this.workers.set(workerId, worker);
    this.workerTaskMap.set(workerId, task.id);

    const workerMeta = getWorkerMeta(workerType, this.workerConfigs);

    // Puppet workers need Wayang tools; third-party workers don't use them
    let tools = workerType === PUPPET_WORKER_TYPE
      ? createWorkerTools({
          listTasks: (status?: TaskDetail['status']) => this.list(status),
          cwd: this.ctx.workspaceDir,
          tavilyApiKey: this.ctx.config.tavilyApiKey,
          reportProgress: (msg: string, _percent?: number) => {
            this.signalQueue.enqueue({
              source: 'worker',
              type: 'progress',
              payload: { workerId, taskId: task.id, taskTitle: task.title, workerType, emoji: workerMeta.emoji, message: msg },
            });
          },
          onComplete: (summary: string) => {
            (worker as any).complete(summary);
          },
          onFail: (error: string) => {
            (worker as any).fail(error);
          },
        })
      : {};

    // Apply permission middleware for puppet workers
    if (workerType === PUPPET_WORKER_TYPE) {
      const middleware = wrapWithPermissionMiddleware(tools, {
        gatedTools: ['bash'],
        needsPermission: (toolName, args) => {
          if (toolName === 'bash') {
            const cmd: string = args.command ?? '';
            return DANGEROUS_BASH_PATTERN.test(cmd);
          }
          return false;
        },
        describeCall: (toolName, args) => {
          if (toolName === 'bash') return `Execute shell command: ${args.command}`;
          return `${toolName}: ${JSON.stringify(args)}`;
        },
      }, {
        workerId,
        taskId: task.id,
        taskTitle: task.title,
        workerType,
        emoji: workerMeta.emoji,
        signalQueue: this.signalQueue,
      });
      tools = middleware.wrappedTools;
      this.permissionResolvers.set(workerId, middleware);
    }

    // Wire signal context for ClaudeCodeWorker (canUseTool + acceptMessage)
    if (worker instanceof ClaudeCodeWorker) {
      worker.setSignalContext({
        signalQueue: this.signalQueue,
        workerId,
        taskId: task.id,
        taskTitle: task.title,
        workerType,
        emoji: workerMeta.emoji,
      });
      this.permissionResolvers.set(workerId, worker.permissionHandler);
    }

    this.logger.info({ workerId, taskId: task.id, workerType }, 'Worker starting');

    return worker.run(
      { ...task, workerId },
      tools,
      (msg: string) => {
        this.signalQueue.enqueue({
          source: 'worker',
          type: 'progress',
          payload: { workerId, taskId: task.id, taskTitle: task.title, workerType, emoji: workerMeta.emoji, message: msg },
        });
      },
    );
  }

  private handleDone(workerId: string, task: TaskDetail, result: WorkerResult): void {
    const workerType = task.workerType ?? PUPPET_WORKER_TYPE;
    const meta = getWorkerMeta(workerType, this.workerConfigs);

    if (result.status === 'completed') {
      this.completeTask(task.id, result.summary ?? '');
      this.signalQueue.enqueue({
        source: 'worker',
        type: 'completed',
        payload: {
          taskId: task.id, workerId, taskTitle: task.title,
          workerType, emoji: meta.emoji, summary: result.summary,
        },
      });
    } else {
      this.failTask(task.id, result.error ?? 'Unknown error');
      this.signalQueue.enqueue({
        source: 'worker',
        type: 'failed',
        payload: {
          taskId: task.id, workerId, taskTitle: task.title,
          workerType, emoji: meta.emoji, error: result.error ?? 'Unknown error',
        },
      });
    }

    this.removeActiveWorker(workerId);
    this.removeWorkerTracking(workerId);
    this.scheduleNext();
  }

  private handleFail(workerId: string, task: TaskDetail, error: string): void {
    const workerType = task.workerType ?? PUPPET_WORKER_TYPE;
    const meta = getWorkerMeta(workerType, this.workerConfigs);

    this.failTask(task.id, error);
    this.signalQueue.enqueue({
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

  private removeWorkerTracking(workerId: string): void {
    // Delayed removal: wait for UI to unmount
    setTimeout(() => {
      this.permissionResolvers.get(workerId)?.cleanup();
      this.permissionResolvers.delete(workerId);
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
