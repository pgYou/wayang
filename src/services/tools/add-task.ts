import { z } from 'zod';
import type { TaskDetail } from '@/types/index';
import { normalizeWorkspacePath, resolveWorkspaceRef } from '@/infra/workspace-registry';
import { generateId } from '@/utils/id';
import { defineTool, safeExecute } from './common';

export interface AddTaskToolDeps {
  /**
   * Add a task and attempt to schedule it. Returns the engine worker id when
   * the task was scheduled immediately (a worker_started signal follows), or
   * undefined when every concurrency slot is busy (a task_queued signal is
   * emitted; the task starts automatically when a slot frees).
   */
  addTask: (task: TaskDetail) => string | undefined;
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
  /**
   * The workspace this process executes in (ctx.workspaceDir). Task creation is
   * single-workspace for now: a `workspace` argument is only accepted when it
   * normalizes to this path. Undefined means "unknown context" — then no
   * workspace identity is stamped and a declared workspace is rejected.
   */
  workspaceDir?: string;
  /**
   * Wayang home dir used to resolve the stable workspace identity (path+slug)
   * from the workspace registry. Null/undefined degrades to the rule-based slug.
   */
  wayangDir?: string | null;
}

/**
 * Decide which workspace a new task belongs to.
 *
 * Three states:
 * - no `workspace` argument       → the current workspace (default).
 * - `workspace` == current (after canonicalization) → the current workspace.
 * - `workspace` != current        → error; the task must NOT be created, since
 *   the engine still builds workers, tool cwd and permission gates from the
 *   process-level workspace, so "accepted but executed elsewhere" would be a
 *   silent inconsistency.
 */
function resolveTaskWorkspace(
  requested: string | undefined,
  deps: AddTaskToolDeps,
): { workspace?: TaskDetail['workspace'] } | { error: string } {
  const current = deps.workspaceDir;
  const requestedPath = requested !== undefined && requested.trim() !== ''
    ? normalizeWorkspacePath(requested)
    : undefined;

  if (!current) {
    if (requestedPath !== undefined) {
      return {
        error: `Cannot resolve workspace ${requestedPath}: the current workspace is unknown in this context, so the task was NOT created.`,
      };
    }
    return {};
  }

  const currentPath = normalizeWorkspacePath(current);
  if (requestedPath !== undefined && requestedPath !== currentPath) {
    return {
      error: `Workspace ${requestedPath} is not the current workspace (${currentPath}). ` +
        `Cross-workspace execution is not supported in the current version — the task was NOT created. ` +
        `Omit "workspace" (or pass the current workspace path) to run the task here.`,
    };
  }

  // Same workspace (explicitly declared in any equivalent spelling, or the
  // default): stamp its canonical identity. resolveWorkspaceRef never throws —
  // without a readable registry it degrades to the rule-based slug.
  const ref = resolveWorkspaceRef(deps.wayangDir ?? null, currentPath);
  return { workspace: { path: ref.path, slug: ref.slug } };
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
      workspace: z.string().optional().describe(
        'Target workspace path; defaults to the current workspace. The current version only accepts a path that resolves to the same workspace as the current one — cross-workspace execution is not supported yet.',
      ),
    }),
    execute: safeExecute('add_task', async (
      { title, description, priority, workerType, multiStage, assignToWorker, workspace },
      options,
    ) => {
      const resolvedType = workerType || 'puppet';

      // Workspace gate: declared workspace must be the one this process runs
      // in. A mismatch fails the call before anything is created.
      const workspaceResolution = resolveTaskWorkspace(workspace, deps);
      if ('error' in workspaceResolution) return workspaceResolution.error;

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
        ...(workspaceResolution.workspace !== undefined && { workspace: workspaceResolution.workspace }),
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

      const workerId = deps.addTask(task);
      deps.onTaskDispatched?.({ toolCallId, taskId: task.id });
      const stageNote = multiStage ? ' [multi-stage: worker will idle after completion]' : '';
      if (workerId !== undefined) {
        return `Task ${task.id} added (priority: ${priority}, workerType: ${task.workerType}, workerId: ${workerId})${stageNote}. The worker has started; you will be notified of progress and completion.`;
      }
      return `Task ${task.id} added (priority: ${priority}, workerType: ${task.workerType})${stageNote}. All concurrency slots are busy — the task is queued and will start automatically when a slot frees (a STARTED signal will name its worker). You will be notified when the task completes.`;
    }),
  });
}
