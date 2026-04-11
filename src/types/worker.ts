// --- Worker ---

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
}

/** Unified interface for all worker types (puppet, third-party). */
export interface IWorkerInstance {
  readonly id: string;
  /** Execute the task. Returns the final result. */
  run(
    task: import('./task').TaskDetail & { workerId: string },
    tools: Record<string, any>,
    onProgress?: (msg: string) => void,
  ): Promise<WorkerResult>;
  /** Abort the current execution. */
  abort(): void;
  /** Get state for UI rendering (may return null if worker has no state). */
  getState(): import('@/infra/state/base-state').BaseWayangState | null;
}
