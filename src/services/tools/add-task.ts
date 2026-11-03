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
  /**
   * Validate that the idle worker was created in the workspace this task will
   * execute in. Returns an error message or null. A worker's cwd, permission
   * boundary and identity are fixed at creation, so reuse never crosses
   * workspaces — the caller must create a new worker for a different one.
   */
  validateWorkerWorkspace?: (workerId: string, workspacePath: string) => string | null;
  /** Current controller turn lineage — stamped onto the created task. */
  getTurnContext?: () => { turnId?: string; rootTurnId?: string; causationId?: string } | undefined;
  /** Notify the agent that this call dispatched a task (toolCall→task audit link). */
  onTaskDispatched?: (info: { toolCallId?: string; taskId: string }) => void;
  /**
   * The workspace this process runs in (ctx.workspaceDir), used as the default
   * when the call declares none. Undefined means "unknown context" — then no
   * default can be derived, so a declared workspace is rejected (nothing to
   * resolve it against) and no identity is stamped.
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
 * - no `workspace` argument (or an empty/whitespace one) → the current
 *   workspace (default).
 * - a declared `workspace` → that workspace, canonicalized. A different path
 *   is a legitimate target: the engine builds the worker, the tool cwd and the
 *   permission-gate boundary from `task.workspace.path`, so the task really
 *   executes where it says it does.
 * - unknown current workspace + declared one → error; there is nothing to
 *   resolve the request against, so no task is created.
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

  // Declared workspace wins; the process workspace is only the default.
  // Canonicalization keeps `task.workspace.path` the single value the engine
  // later uses for cwd and permission checks (no raw-spelling drift).
  const targetPath = requestedPath ?? normalizeWorkspacePath(current);

  // resolveWorkspaceRef never throws — without a readable registry it degrades
  // to the rule-based slug.
  const ref = resolveWorkspaceRef(deps.wayangDir ?? null, targetPath);
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
        'Target workspace path; defaults to the current workspace. A different path runs this task there — the worker, its tools and its permission checks use it as their root.',
      ),
    }),
    execute: safeExecute('add_task', async (
      { title, description, priority, workerType, multiStage, assignToWorker, workspace },
      options,
    ) => {
      const resolvedType = workerType || 'puppet';

      // Workspace stamp: the declared workspace, or the process workspace when
      // none is given. Only an unresolvable declaration (unknown context) fails.
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

        // Same-workspace requirement: the engine rejects a cross-workspace
        // reuse anyway, but on its own it can only report a generic "could not
        // accept" — this check tells the controller WHY and what to do instead
        // (create a fresh worker). Skipped when the target workspace is unknown
        // here; the engine then falls back to its process workspace.
        const targetWorkspacePath = workspaceResolution.workspace?.path ?? deps.workspaceDir;
        if (targetWorkspacePath !== undefined && deps.validateWorkerWorkspace) {
          const wsErr = deps.validateWorkerWorkspace(assignToWorker, targetWorkspacePath);
          if (wsErr) return wsErr;
        }
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
