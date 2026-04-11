import type { Logger } from '@/infra/logger';
import type { TaskPool } from '@/services/task/task-pool';
import type { SignalQueue } from '@/services/signal/signal-queue';
import type { EventBus } from '@/infra/event-bus';
import type { TaskDetail, WorkerConfig, WorkerResult } from '@/types/index';
import { formatLlmError } from '@/utils/llm-error';
import { generateId } from '@/utils/id';
import { getWorkerMeta } from '@/services/agents/worker-defaults';

export interface TaskWithWorkerId extends TaskDetail {
  workerId: string;
}

export interface SchedulerContext {
  addActiveWorker(info: { workerId: string; taskId: string; startedAt: number; workerType: string; taskTitle: string; emoji: string }): void;
  removeActiveWorker(workerId: string): void;
  removeWorker(workerId: string): void;
}

export class TaskScheduler {
  private spawnFn: ((task: TaskWithWorkerId) => Promise<WorkerResult>) | null = null;

  constructor(
    private logger: Logger,
    private taskPool: TaskPool,
    private signalQueue: SignalQueue,
    private eventBus: EventBus,
    private ctx: SchedulerContext,
    private maxConcurrency: number = 3,
    private workerConfigs?: Record<string, WorkerConfig>,
  ) {}

  /** Inject worker spawn function (breaks circular dep) */
  setSpawnFn(fn: (task: TaskWithWorkerId) => Promise<WorkerResult>): void {
    this.spawnFn = fn;
  }

  start(): void {
    this.eventBus.on('task:added', () => this.schedule());
    this.logger.info('Scheduler started');
  }

  schedule(): void {
    while (this.taskPool.hasPending() && this.taskPool.getRunningCount() < this.maxConcurrency) {
      const task = this.taskPool.peekHighestPriority();
      if (!task) break;

      if (!this.spawnFn) {
        this.logger.error('spawnFn not set, cannot schedule task');
        break;
      }

      const workerId = generateId('w');
      const workerType = task.workerType ?? 'puppet';
      const meta = getWorkerMeta(workerType, this.workerConfigs);

      this.taskPool.moveToRunning(task.id, workerId);

      this.ctx.addActiveWorker({
        workerId,
        taskId: task.id,
        startedAt: Date.now(),
        workerType: meta.label,
        taskTitle: task.title,
        emoji: meta.emoji,
      });

      // Fire-and-forget worker run
      this.spawnFn({ ...task, workerId })
        .then((result) => {
          this.handleDone(workerId, task, result);
        })
        .catch((err) => {
          this.handleFail(workerId, task.id, task.title, meta.label, meta.emoji, formatLlmError(err));
        });

      this.logger.info({ taskId: task.id, workerId }, 'Worker spawned');
    }
  }

  private handleDone(workerId: string, task: TaskDetail, result: WorkerResult): void {
    const { id: taskId, title: taskTitle, workerType: wt } = task;
    const workerType = wt ?? 'puppet';
    const meta = getWorkerMeta(workerType, this.workerConfigs);
    if (result.status === 'completed') {
      this.taskPool.complete(taskId, result.summary ?? '');
    } else {
      this.taskPool.fail(taskId, result.error ?? 'Unknown error');
    }

    if (result.status === 'completed') {
      this.signalQueue.enqueue({
        source: 'worker',
        type: 'completed',
        payload: {
          taskId,
          workerId,
          taskTitle,
          workerType,
          emoji: meta.emoji,
          summary: result.summary,
        },
      });
    } else {
      this.signalQueue.enqueue({
        source: 'worker',
        type: 'failed',
        payload: {
          taskId,
          workerId,
          taskTitle,
          workerType,
          emoji: meta.emoji,
          error: result.error ?? 'Unknown error',
        },
      });
    }

    this.ctx.removeActiveWorker(workerId);
    this.ctx.removeWorker(workerId);
    this.schedule();
  }

  private handleFail(workerId: string, taskId: string, taskTitle: string, workerType: string, emoji: string, error: string): void {
    this.taskPool.fail(taskId, error);
    this.signalQueue.enqueue({
      source: 'worker',
      type: 'failed',
      payload: { taskId, workerId, taskTitle, workerType, emoji, error },
    });
    this.ctx.removeActiveWorker(workerId);
    this.ctx.removeWorker(workerId);
    this.schedule();
  }
}
