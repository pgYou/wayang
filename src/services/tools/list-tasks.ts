import { z } from 'zod';
import type { TaskDetail } from '@/types/index';
import { defineTool, safeExecute } from './common';

export function listTasksTool(deps: { listTasks: (status?: TaskDetail['status']) => TaskDetail[] }) {
  return defineTool({
    description: 'View the task list',
    parameters: z.object({
      status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']).optional()
        .describe('Filter by status'),
    }),
    execute: safeExecute('list_tasks', async ({ status }) => {
      const tasks = deps.listTasks(status);
      if (tasks.length === 0) return status ? `No ${status} tasks` : 'No tasks';
      return tasks.map(t =>
        `[${t.status}] ${t.id}: ${t.description}${t.result ? ` → ${t.result}` : ''}${t.error ? ` ✗ ${t.error}` : ''}`,
      ).join('\n');
    }),
  });
}
