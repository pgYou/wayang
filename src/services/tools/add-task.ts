import { z } from 'zod';
import type { TaskDetail } from '@/types/index';
import { generateId } from '@/utils/id';
import { defineTool, safeExecute } from './common';

export interface AddTaskToolDeps {
  addTask: (task: TaskDetail) => void;
  /** Validate workerType. Returns null if valid, error message if invalid. */
  validateWorkerType?: (workerType: string) => string | null;
  /** Assign a task to an existing idle worker. Returns true if assigned. */
  assignToWorker?: (workerId: string, task: TaskDetail) => boolean;
  /** Validate that a worker exists and is idle. Returns error message or null. */
  validateIdleWorker?: (workerId: string) => string | null;
  /** Current controller turn lineage — stamped onto the created task. */
  getTurnContext?: () => { turnId?: string; rootTurnId?: string; causationId?: string } | undefined;
  /** Notify the agent that this call dispatched a task (toolCall→task audit link). */
  onTaskDispatched?: (info: { toolCallId?: string; taskId: string }) => void;
}

export function addTaskTool(deps: AddTaskToolDeps) {
  return defineTool({
    description: 'Add a new task to the queue. A Worker will execute it automatically.',
    parameters: z.object({
      title: z.string().max(50).describe('Brief task title, max 50 characters'),
      description: z.string().describe('Detailed task description for the Worker'),
      priority: z.enum(['normal', 'high']).default('normal').describe('Priority level'),
      workerType: z.string().optional().describe('Worker type: "puppet" (default, built-in LLM) or a configured worker ID (e.g. "claude-code")'),
      multiStage: z.boolean().default(false).describe(
        'Set true for multi-stage work: the worker parks in idle after completion so a follow-up task can be assigned to it with full context. Use for work that proceeds in stages with review in between (e.g. plan → review → implement).',
      ),
      assignToWorker: z.string().optional().describe(
        'Dispatch this task to an existing idle worker (the workerId returned from a prior multiStage task). The worker resumes with its accumulated context. Omit for a fresh worker.',
      ),
    }),
    execute: safeExecute('add_task', async ({ title, description, priority, workerType, multiStage, assignToWorker }, options) => {
      const resolvedType = workerType || 'puppet';

      // Pre-validate workerType before adding task
      if (deps.validateWorkerType) {
        const err = deps.validateWorkerType(resolvedType);
        if (err) return err;
      }

      // If assigning to an existing idle worker, validate it first
      if (assignToWorker) {
        if (!deps.validateIdleWorker || !deps.assignToWorker) {
          return `Cannot assign to worker: worker reuse is not available.`;
        }
        const err = deps.validateIdleWorker(assignToWorker);
        if (err) return err;
      }

      const toolCallId: string | undefined = options?.toolCallId;
      // Turn lineage of the controller run that is creating this task. The
      // direct cause of the task is the add_task tool call itself; fall back
      // to the turn's own cause (e.g. the triggering signal id).
      const turnCtx = deps.getTurnContext?.();

      const task: TaskDetail = {
        id: generateId('t'),
        title,
        description,
        priority,
        workerType: resolvedType,
        status: 'pending',
        createdAt: Date.now(),
        multiStage,
        assignToWorker,
        ...(turnCtx?.turnId !== undefined && { turnId: turnCtx.turnId }),
        ...(turnCtx?.rootTurnId !== undefined && { rootTurnId: turnCtx.rootTurnId }),
        ...((toolCallId ?? turnCtx?.causationId) !== undefined && { causationId: toolCallId ?? turnCtx?.causationId }),
      };

      if (assignToWorker && deps.assignToWorker) {
        const ok = deps.assignToWorker(assignToWorker, task);
        if (ok) deps.onTaskDispatched?.({ toolCallId, taskId: task.id });
        else return `Worker ${assignToWorker} could not accept the task (no longer idle?).`;
        return `Task ${task.id} assigned to worker ${assignToWorker} (reusing its context, priority: ${priority}, worker: ${resolvedType}). You will be notified when the task completes.`;
      }

      deps.addTask(task);
      deps.onTaskDispatched?.({ toolCallId, taskId: task.id });
      const stageNote = multiStage ? ' [multi-stage: worker will idle after completion]' : '';
      return `Task ${task.id} added (priority: ${priority}, worker: ${task.workerType})${stageNote}. You will be notified when the task completes.`;
    }),
  });
}
