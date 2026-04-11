import { z } from 'zod';
import type { TaskDetail } from '@/types/index';
import { generateId } from '@/utils/id';
import { defineTool, safeExecute } from './common';

export interface AddTaskToolDeps {
  addTask: (task: TaskDetail) => void;
  /** Validate workerType. Returns null if valid, error message if invalid. */
  validateWorkerType?: (workerType: string) => string | null;
}

export function addTaskTool(deps: AddTaskToolDeps) {
  return defineTool({
    description: 'Add a new task to the queue. A Worker will execute it automatically.',
    parameters: z.object({
      title: z.string().max(10).describe('Brief task title, max 10 characters'),
      description: z.string().describe('Detailed task description for the Worker'),
      priority: z.enum(['normal', 'high']).default('normal').describe('Priority level'),
      workerType: z.string().optional().describe('Worker type: "puppet" (default, built-in LLM) or a configured worker ID (e.g. "claude-code")'),
    }),
    execute: safeExecute('add_task', async ({ title, description, priority, workerType }) => {
      const resolvedType = workerType || 'puppet';

      // Pre-validate workerType before adding task
      if (deps.validateWorkerType) {
        const err = deps.validateWorkerType(resolvedType);
        if (err) return err;
      }

      const task: TaskDetail = {
        id: generateId('t'),
        title,
        description,
        priority,
        workerType: resolvedType,
        status: 'pending',
        createdAt: Date.now(),
      };
      deps.addTask(task);
      return `Task ${task.id} added (priority: ${priority}, worker: ${task.workerType}). You will be notified when the task completes.`;
    }),
  });
}
