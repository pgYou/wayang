import { z } from 'zod';
import type { TaskDetail } from '@/types/index';
import { defineTool, safeExecute } from './common';

export interface UpdateTaskDeps {
  /** Update a pending task — returns true if found and updated. */
  updateTask: (taskId: string, updates: Partial<Pick<TaskDetail, 'description' | 'priority'>>) => boolean;
}

export function updateTaskTool(deps: UpdateTaskDeps) {
  return defineTool({
    description: 'Update a pending task description or priority',
    parameters: z.object({
      taskId: z.string().describe('Task ID to update'),
      description: z.string().optional().describe('New task description'),
      priority: z.enum(['normal', 'high']).optional().describe('New priority'),
    }),
    execute: safeExecute('update_task', async ({ taskId, description, priority }) => {
      if (!description && !priority) {
        return 'Nothing to update — provide description or priority';
      }
      const updated = deps.updateTask(taskId, { description, priority } as Partial<Pick<TaskDetail, 'description' | 'priority'>>);
      if (!updated) return `Task ${taskId} not found or not in pending status`;
      return `Task ${taskId} updated`;
    }),
  });
}
