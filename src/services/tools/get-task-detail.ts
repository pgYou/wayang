import { z } from 'zod';
import type { TaskDetail } from '@/types/index';
import { defineTool, safeExecute } from './common';

export interface GetTaskDetailDeps {
  /** Get a single task by id. */
  getTask: (taskId: string) => TaskDetail | undefined;
  /** Get worker conversation entries for a running/completed task. */
  getWorkerConversation?: (taskId: string) => any[];
}

export function getTaskDetailTool(deps: GetTaskDetailDeps) {
  return defineTool({
    description: 'Get detailed information about a specific task',
    parameters: z.object({
      taskId: z.string().describe('Task ID'),
    }),
    execute: safeExecute('get_task_detail', async ({ taskId }) => {
      const task = deps.getTask(taskId);
      if (!task) return `Task ${taskId} not found`;

      const lines = [
        `ID: ${task.id}`,
        `Status: ${task.status}`,
        `Priority: ${task.priority}`,
        `Description: ${task.description}`,
        `Created: ${new Date(task.createdAt).toISOString()}`,
      ];
      if (task.startedAt) lines.push(`Started: ${new Date(task.startedAt).toISOString()}`);
      if (task.completedAt) lines.push(`Completed: ${new Date(task.completedAt).toISOString()}`);
      if (task.result) lines.push(`Result: ${task.result}`);
      if (task.error) lines.push(`Error: ${task.error}`);
      if (task.workerSessionId) lines.push(`Worker: ${task.workerSessionId}`);

      if (deps.getWorkerConversation) {
        const entries = deps.getWorkerConversation(taskId);
        if (entries.length > 0) {
          lines.push(`\nConversation (${entries.length} entries):`);
          for (const entry of entries.slice(-10)) {
            lines.push(`  [${entry.type}] ${entry.message?.content ?? entry.content ?? ''}`.slice(0, 200));
          }
        }
      }

      return lines.join('\n');
    }),
  });
}
