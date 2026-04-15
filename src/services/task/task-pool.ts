import type { TaskDetail } from '@/types/index';
import type { Logger } from '@/infra/logger';
import type { TaskPoolState } from '@/services/task/task-pool-state';
import type { LifecycleHooks } from '@/services/lifecycle-hooks';

export class TaskPool {
  /** Expose state for UI subscription via useWayangState. */
  get stateRef() { return this.state; }

  constructor(
    private state: TaskPoolState,
    private hooks: LifecycleHooks,
    private logger: Logger,
  ) {}

  add(task: TaskDetail): void {
    this.state.append('tasks.pending', task);
    this.hooks.emit('task:added', task);
    this.logger.info({ taskId: task.id }, 'Task added');
  }

  get(id: string): TaskDetail | undefined {
    const all = [
      ...this.state.get<TaskDetail[]>('tasks.pending'),
      ...this.state.get<TaskDetail[]>('tasks.running'),
      ...this.state.get<TaskDetail[]>('tasks.history'),
    ];
    return all.find(t => t.id === id);
  }

  moveToRunning(id: string, workerSessionId: string): void {
    const pending = [...this.state.get<TaskDetail[]>('tasks.pending')];
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
    this.state.set('tasks.pending', pending);
    this.state.append('tasks.running', updated);
    this.logger.info({ taskId: id, workerId: workerSessionId }, 'Task moved to running');
  }

  complete(id: string, result: string): void {
    this.moveToHistory(id, 'completed', { result });
    this.hooks.emit('task:completed', { taskId: id });
    this.logger.info({ taskId: id }, 'Task completed');
  }

  fail(id: string, error: string): void {
    this.moveToHistory(id, 'failed', { error });
    this.hooks.emit('task:failed', { taskId: id, error });
    this.logger.info({ taskId: id, error }, 'Task failed');
  }

  cancel(id: string): boolean {
    // Try running first, then pending
    const running = this.state.get<TaskDetail[]>('tasks.running');
    const runIdx = running.findIndex(t => t.id === id);
    if (runIdx !== -1) {
      this.moveToHistory(id, 'cancelled', {});
      this.hooks.emit('task:cancelled', { taskId: id });
      this.logger.info({ taskId: id }, 'Running task cancelled');
      return true;
    }

    const pending = [...this.state.get<TaskDetail[]>('tasks.pending')];
    const pendIdx = pending.findIndex(t => t.id === id);
    if (pendIdx !== -1) {
      const [task] = pending.splice(pendIdx, 1);
      this.state.set('tasks.pending', pending);
      this.state.append('tasks.history', {
        ...task,
        status: 'cancelled',
        completedAt: Date.now(),
      });
      this.hooks.emit('task:cancelled', { taskId: id });
      this.logger.info({ taskId: id }, 'Pending task cancelled');
      return true;
    }

    this.logger.warn({ taskId: id }, 'Task not found for cancel');
    return false;
  }

  /** Update a pending task's description or priority. */
  updatePending(id: string, updates: Partial<Pick<TaskDetail, 'description' | 'priority'>>): boolean {
    const pending = [...this.state.get<TaskDetail[]>('tasks.pending')];
    const idx = pending.findIndex(t => t.id === id);
    if (idx === -1) {
      this.logger.warn({ taskId: id }, 'Task not found in pending for update');
      return false;
    }
    pending[idx] = { ...pending[idx], ...updates };
    this.state.set('tasks.pending', pending);
    this.logger.info({ taskId: id, updates }, 'Pending task updated');
    return true;
  }

  list(status?: TaskDetail['status']): TaskDetail[] {
    if (!status) {
      return [
        ...this.state.get<TaskDetail[]>('tasks.pending'),
        ...this.state.get<TaskDetail[]>('tasks.running'),
        ...this.state.get<TaskDetail[]>('tasks.history'),
      ];
    }
    if (status === 'pending') return [...this.state.get<TaskDetail[]>('tasks.pending')];
    if (status === 'running') return [...this.state.get<TaskDetail[]>('tasks.running')];
    return this.state.get<TaskDetail[]>('tasks.history').filter(t => t.status === status);
  }

  hasPending(): boolean {
    return this.state.get<TaskDetail[]>('tasks.pending').length > 0;
  }

  /** Pick the highest priority task without removing it. */
  peekHighestPriority(): TaskDetail | null {
    const pending = this.state.get<TaskDetail[]>('tasks.pending');
    if (pending.length === 0) return null;
    const highIdx = pending.findIndex(t => t.priority === 'high');
    const targetIdx = highIdx !== -1 ? highIdx : 0;
    return pending[targetIdx];
  }

  getRunningCount(): number {
    return this.state.get<TaskDetail[]>('tasks.running').length;
  }

  async restore(): Promise<void> {
    await this.state.restore();
  }

  private moveToHistory(id: string, status: TaskDetail['status'], extra: Partial<TaskDetail>): void {
    const running = this.state.get<TaskDetail[]>('tasks.running');
    const idx = running.findIndex(t => t.id === id);
    if (idx === -1) {
      this.logger.warn({ taskId: id }, 'Task not found in running');
      return;
    }

    const updated = [...this.state.get('tasks.running') as TaskDetail[]];
    const [task] = updated.splice(idx, 1);
    this.state.set('tasks.running', updated);

    this.state.append('tasks.history', {
      ...task,
      ...extra,
      status,
      completedAt: Date.now(),
    });
  }
}
