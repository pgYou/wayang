import { SystemContext } from '@/infra/system-context';
import { LifecycleHooks } from '@/services/lifecycle-hooks';
import { TaskPool } from '@/services/task/task-pool';
import { SignalQueue } from '@/services/signal/signal-queue';
import { TaskScheduler, type SchedulerContext } from '@/services/task/task-scheduler';
import { getWorkerMeta } from '@/services/agents/worker-defaults';
import { ControllerAgentState } from './agents/controller-state';
import { TaskPoolState } from './task/task-pool-state';
import { SignalState } from './signal/signal-state';
import { SessionManager } from '@/services/session/session-manager';
import { ControllerAgent } from './agents/controller-agent';
import { createWorkerTools } from '@/services/tools/index';
import { WorkerFactory } from '@/services/worker-factory';
import type { WayangConfig, TaskDetail, WorkerResult, ProviderConfig, IWorkerInstance } from '@/types/index';
import type { ActiveWorkerInfo } from './agents/controller-state';
import type { TaskWithWorkerId } from '@/services/task/task-scheduler';

/** Parameters for Supervisor initialization. */
export interface SupervisorOptions {
  config: WayangConfig;
  workspaceDir: string;
  logLevel?: string;
  /** Resume a specific session. Omit for new session. */
  resume?: { sessionId: string; sessionDir: string };
  /** Home directory for sessions storage. Required for new sessions. */
  homeDir?: string;
}

export class Supervisor implements SchedulerContext {
  readonly ctx: SystemContext;
  readonly hooks: LifecycleHooks;
  readonly controllerState: ControllerAgentState;
  readonly taskPool: TaskPool;
  readonly signalQueue: SignalQueue;
  readonly scheduler: TaskScheduler;
  readonly controllerAgent: ControllerAgent;
  readonly sessionManager: SessionManager;
  readonly workerFactory: WorkerFactory;

  private workers = new Map<string, IWorkerInstance>();
  /** Reverse mapping: workerId → taskId, for reliable abort lookup. */
  private workerTaskMap = new Map<string, string>();
  private readonly controllerProvider: ProviderConfig;
  private readonly workerProvider: ProviderConfig;
  private readonly config: WayangConfig;

  constructor(options: SupervisorOptions) {
    const { config, workspaceDir, logLevel } = options;

    // Create session manager
    if (options.resume) {
      this.sessionManager = SessionManager.resume(options.resume.sessionId, options.resume.sessionDir);
    } else {
      if (!options.homeDir) throw new Error('homeDir is required for new sessions');
      this.sessionManager = SessionManager.create(options.homeDir, workspaceDir);
    }

    // Create system context (logger, providers, abort controller)
    this.ctx = new SystemContext(
      config,
      this.sessionManager.sessionId,
      this.sessionManager.sessionDir,
      workspaceDir,
      logLevel,
    );

    this.controllerProvider = this.ctx.controllerProvider;
    this.workerProvider = this.ctx.workerProvider;
    this.config = config;

    // Create worker factory
    this.workerFactory = new WorkerFactory();

    this.ctx.logger.info(
      { controllerEndpoint: this.controllerProvider.endpoint, controllerModel: this.controllerProvider.modelName },
      'Provider config',
    );

    // Create lifecycle hooks
    this.hooks = new LifecycleHooks();

    // Create states
    this.controllerState = new ControllerAgentState(this.ctx.sessionDir, this.ctx.logger);
    const taskPoolState = new TaskPoolState(this.ctx.sessionDir, this.ctx.logger);
    const signalState = new SignalState(this.ctx.sessionDir, this.ctx.logger);

    // Create services
    this.taskPool = new TaskPool(taskPoolState, this.hooks, this.ctx.logger);
    this.signalQueue = new SignalQueue(signalState, this.ctx.logger, this.hooks);
    this.scheduler = new TaskScheduler(
      this.ctx.logger,
      this.taskPool,
      this.signalQueue,
      this.hooks,
      this, // SchedulerContext
      this.ctx.maxConcurrency,
      config.workers,
    );

    // Create controller agent
    this.controllerAgent = ControllerAgent.create({
      ctx: this.ctx,
      state: this.controllerState,
      provider: this.controllerProvider,
      config,
      taskPool: this.taskPool,
      signalQueue: this.signalQueue,
      abortWorker: (taskId: string) => this.abortWorkerByTaskId(taskId),
    });

    // Wire up scheduler spawn function
    this.scheduler.setSpawnFn((taskWithWorker: TaskWithWorkerId) => {
      return this.spawnWorker(taskWithWorker);
    });
  }

  // --- Lifecycle ---

  async restore(): Promise<void> {
    await Promise.all([
      this.sessionManager.restore(),
      this.controllerState.restore(),
      this.taskPool.restore(),
      this.signalQueue.restore(),
    ]);

    // Crash recovery: clean up stale state
    this.recoverCrashedWorkers();

    this.ctx.logger.info('Supervisor restored');
  }

  async start(): Promise<void> {
    // Set controller session info
    this.controllerState.set('runtimeState.session', {
      id: this.ctx.sessionId,
      startedAt: this.ctx.startedAt,
    });

    // Start scheduler
    this.scheduler.start();

    this.ctx.logger.info('Supervisor started');
  }

  // --- Worker management ---

  /**
   * Crash recovery: detect stale workers and orphaned tasks.
   * On resume, running tasks from a crashed session are marked failed,
   * and stale activeWorkers entries are cleared.
   */
  private recoverCrashedWorkers(): void {
    // Clear stale activeWorkers — they're from the previous process
    const activeWorkers = this.controllerState.get<ActiveWorkerInfo[]>('runtimeState.activeWorkers');
    if (activeWorkers.length > 0) {
      this.ctx.logger.info({ count: activeWorkers.length }, 'Clearing stale active workers from crash');
      this.controllerState.set('runtimeState.activeWorkers', []);
    }

    // Mark running tasks as failed (they were interrupted by the crash)
    const running = this.taskPool.list('running');
    for (const task of running) {
      this.ctx.logger.info({ taskId: task.id }, 'Marking crashed running task as failed');
      this.taskPool.fail(task.id, 'Session crashed — task interrupted');
    }
  }

  /** Abort a worker that is running a specific task. */
  abortWorkerByTaskId(taskId: string): void {
    for (const [workerId, tId] of this.workerTaskMap) {
      if (tId === taskId) {
        const worker = this.workers.get(workerId);
        worker?.abort();
        this.ctx.logger.info({ workerId, taskId }, 'Worker aborted');
        return;
      }
    }
    this.ctx.logger.warn({ taskId }, 'No running worker found for task abort');
  }

  private async spawnWorker(taskWithWorker: TaskDetail & { workerId: string }): Promise<WorkerResult> {
    const { workerId, ...task } = taskWithWorker;
    const workerType = task.workerType ?? 'puppet';

    const worker = this.workerFactory.create(workerType, {
      workerProvider: this.workerProvider,
      sessionDir: this.ctx.sessionDir,
      workspaceDir: this.ctx.workspaceDir,
      ctx: this.ctx,
      workerConfigs: this.config.workers,
    });
    this.workers.set(workerId, worker);
    this.workerTaskMap.set(workerId, task.id);
    const workerMeta = getWorkerMeta(workerType, this.config.workers);

    // Puppet workers need Wayang tools; third-party workers don't use them
    const tools = workerType === 'puppet'
      ? createWorkerTools({
        listTasks: (status?: TaskDetail['status']) => this.taskPool.list(status),
        cwd: this.ctx.workspaceDir,
        reportProgress: (msg: string, _percent?: number) => {
          this.signalQueue.enqueue({
            source: 'worker',
            type: 'progress',
            payload: { workerId, taskId: task.id, taskTitle: task.title, workerType, emoji: workerMeta.emoji, message: msg },
          });
        },
        onComplete: (summary: string) => {
          // WorkerAgent.complete — safe cast, only puppet workers reach here
          (worker as any).complete(summary);
        },
        onFail: (error: string) => {
          (worker as any).fail(error);
        },
      })
      : {};

    this.ctx.logger.info({ workerId, taskId: task.id, workerType }, 'Worker starting');

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

  registerWorker(worker: IWorkerInstance): void {
    this.workers.set(worker.id, worker);
  }

  getWorker(id: string): IWorkerInstance | undefined {
    return this.workers.get(id);
  }

  getWorkerState(id: string) {
    return this.workers.get(id)?.getState() ?? null;
  }

  removeWorker(id: string): void {
    // Delayed removal: wait for UI to unmount
    setTimeout(() => {
      this.workers.delete(id);
      this.workerTaskMap.delete(id);
    }, 0);
  }

  // --- SchedulerContext implementation ---

  addActiveWorker(info: { workerId: string; taskId: string; startedAt: number; workerType: string; taskTitle: string; emoji: string }): void {
    this.controllerState.append('runtimeState.activeWorkers', info);
  }

  removeActiveWorker(workerId: string): void {
    const workers = this.controllerState.get<ActiveWorkerInfo[]>('runtimeState.activeWorkers');
    const idx = workers.findIndex((w) => w.workerId === workerId);
    if (idx !== -1) {
      this.controllerState.remove('runtimeState.activeWorkers', idx);
    }
  }

  // --- Shutdown ---

  async shutdown(): Promise<void> {
    // Abort all running workers
    for (const worker of this.workers.values()) {
      worker.abort();
    }

    // Cancel all running tasks
    const running = this.taskPool.list('running');
    for (const task of running) {
      this.taskPool.cancel(task.id);
    }

    // Stop controller loop
    this.ctx.abortController.abort();

    // Clear tracking
    this.workers.clear();
    this.workerTaskMap.clear();

    this.ctx.logger.info('Supervisor shutdown complete');
  }
}
