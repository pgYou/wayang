import { z } from 'zod';
import { defineTool, safeExecute } from './common';

export interface CancelTaskDeps {
  /** Cancel a task by id — returns true if found and cancelled. */
  cancelTask: (taskId: string) => boolean;
  /** Abort the worker running the task (if any). */
  abortWorker?: (taskId: string) => void;
}

export function cancelTaskTool(deps: CancelTaskDeps) {
  return defineTool({
    description: 'Cancel a running or pending task',
    parameters: z.object({
      taskId: z.string().describe('Task ID to cancel'),
    }),
    execute: safeExecute('cancel_task', async ({ taskId }) => {
      if (deps.abortWorker) {
        deps.abortWorker(taskId);
      }
      const cancelled = deps.cancelTask(taskId);
      if (!cancelled) return `Task ${taskId} not found or already completed`;
      return `Task ${taskId} cancelled`;
    }),
  });
}
