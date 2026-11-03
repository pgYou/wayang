import { z } from 'zod';
import type { TaskDetail } from '@/types/index';
import type { PermissionConfig } from '@/types/config';
import { normalizeWorkspacePath, resolveWorkspaceRef } from '@/infra/workspace-registry';
import { defaultDeniedPaths, isDenied, isPathWithin, normalizePath } from '@/infra/permission/policy';
import { generateId } from '@/utils/id';
import { defineTool, safeExecute } from './common';
import { buildWorkspaceRulesSummary } from './workspace-rules';

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
  /**
   * The user's home directory — the boundary an `allowedDirs` entry must stay
   * inside, and the anchor of the built-in denylist. Injected (never read
   * globally); when absent, a call that declares `allowedDirs` is rejected
   * because the boundary cannot be checked.
   */
  homeDir?: string;
  /**
   * User-config permission section. Its `deniedDirs` extend the built-in
   * denylist for `allowedDirs` validation. Injected (never read globally).
   */
  permissionConfig?: PermissionConfig;
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

/**
 * Validate and canonicalize an `allowedDirs` declaration for one task.
 *
 * Every entry is normalized through the shared policy (relative entries resolve
 * against the target workspace), must sit inside the user's home directory, and
 * must not match the denied-path list (built-in denylist plus configured
 * `deniedDirs`). A single bad entry fails the WHOLE call — the returned error
 * names the offending entry and the reason — so a task is never created with a
 * partial grant. Valid entries are deduped while preserving declaration order.
 *
 * Absent/empty input means "no extra directories": the task field stays unset
 * (never an empty array).
 */
function resolveTaskAllowedDirs(
  requested: string[] | undefined,
  workspacePath: string | undefined,
  deps: AddTaskToolDeps,
): { allowedDirs?: string[] } | { error: string } {
  if (requested === undefined || requested.length === 0) return {};

  const homeDir = deps.homeDir;
  if (!homeDir) {
    return {
      error: 'Cannot validate allowedDirs: the home directory is unknown in this context, so the task was NOT created.',
    };
  }

  const home = normalizePath(homeDir);
  // Relative entries resolve against the task workspace (the same base the
  // policy uses), falling back to home when the workspace is unknown.
  const base = workspacePath !== undefined ? normalizePath(workspacePath, { base: home }) : home;
  const deniedPaths = [
    ...defaultDeniedPaths(home),
    ...(deps.permissionConfig?.deniedDirs ?? [])
      .filter((d): d is string => typeof d === 'string' && d.length > 0)
      .map((d) => normalizePath(d, { base: home })),
  ].map((d) => normalizePath(d));

  const seen = new Set<string>();
  const allowedDirs: string[] = [];
  for (const raw of requested) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      return {
        error: `Invalid allowedDirs entry ${JSON.stringify(raw)}: expected a non-empty directory path. The task was NOT created.`,
      };
    }

    const resolved = normalizePath(raw, { base });

    if (!isPathWithin(home, resolved)) {
      return {
        error: `Invalid allowedDirs entry "${raw}" (resolved to ${resolved}): it is outside the home directory (${home}). Only directories under home can be granted to a task. The task was NOT created.`,
      };
    }

    if (isDenied(resolved, deniedPaths)) {
      return {
        error: `Invalid allowedDirs entry "${raw}" (resolved to ${resolved}): it matches the denied-path list (a sensitive location such as credentials or tool config). The task was NOT created.`,
      };
    }

    if (!seen.has(resolved)) {
      seen.add(resolved);
      allowedDirs.push(resolved);
    }
  }

  return allowedDirs.length > 0 ? { allowedDirs } : {};
}

/**
 * Append the target workspace's rules summary to a successful result.
 *
 * The controller's system prompt is shared by every task, so it cannot carry a
 * project's rules: they would leak across workspaces. Instead the summary
 * rides along with the dispatch, read fresh from the workspace this task will
 * execute in — never cached, never stored on the controller.
 *
 * A workspace with no rules file appends nothing (no "no rules" noise); a
 * rules file that exists but may not be read appends an "unavailable" note.
 */
function withWorkspaceRules(
  resultText: string,
  workspacePath: string | undefined,
  deps: AddTaskToolDeps,
): string {
  const summary = buildWorkspaceRulesSummary({
    workspacePath,
    homeDir: deps.homeDir,
    permissionConfig: deps.permissionConfig,
  });
  return summary === '' ? resultText : `${resultText}\n\n${summary}`;
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
      allowedDirs: z.array(z.string()).optional().describe(
        'Extra directories this task may access, in addition to its workspace. Only this task is affected — the grant is NOT inherited by other tasks. Each entry must be inside the user home and off the denied-path list (credentials, tool config); an invalid entry fails the whole call and no task is created. Paths are normalized; relative entries resolve against the task workspace.',
      ),
    }),
    execute: safeExecute('add_task', async (
      { title, description, priority, workerType, multiStage, assignToWorker, workspace, allowedDirs },
      options,
    ) => {
      const resolvedType = workerType || 'puppet';

      // Workspace stamp: the declared workspace, or the process workspace when
      // none is given. Only an unresolvable declaration (unknown context) fails.
      const workspaceResolution = resolveTaskWorkspace(workspace, deps);
      if ('error' in workspaceResolution) return workspaceResolution.error;

      // Extra directories for this task only. Validated before anything else
      // happens so an invalid entry can never yield a half-created task.
      const allowedDirsResolution = resolveTaskAllowedDirs(
        allowedDirs,
        workspaceResolution.workspace?.path ?? deps.workspaceDir,
        deps,
      );
      if ('error' in allowedDirsResolution) return allowedDirsResolution.error;

      // The workspace this task will really run in: the declared one, or the
      // process workspace. Used for worker-reuse validation, the rules summary
      // and (via task.workspace) the engine's cwd/permission boundary.
      const targetWorkspacePath = workspaceResolution.workspace?.path ?? deps.workspaceDir;

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
        ...(allowedDirsResolution.allowedDirs !== undefined && { taskAllowedDirs: allowedDirsResolution.allowedDirs }),
        ...(turnCtx?.turnId !== undefined && { turnId: turnCtx.turnId }),
        ...(turnCtx?.rootTurnId !== undefined && { rootTurnId: turnCtx.rootTurnId }),
        ...((toolCallId ?? turnCtx?.causationId) !== undefined && { causationId: toolCallId ?? turnCtx?.causationId }),
      };

      if (assignToWorker && deps.assignToWorker) {
        const ok = deps.assignToWorker(assignToWorker, task);
        if (ok) deps.onTaskDispatched?.({ toolCallId, taskId: task.id });
        else return `Worker ${assignToWorker} could not accept the task (no longer idle?).`;
        return withWorkspaceRules(
          `Task ${task.id} assigned to worker ${assignToWorker} (reusing its context, priority: ${priority}, worker: ${resolvedType}). You will be notified when the task completes.`,
          targetWorkspacePath,
          deps,
        );
      }

      const workerId = deps.addTask(task);
      deps.onTaskDispatched?.({ toolCallId, taskId: task.id });
      const stageNote = multiStage ? ' [multi-stage: worker will idle after completion]' : '';
      if (workerId !== undefined) {
        return withWorkspaceRules(
          `Task ${task.id} added (priority: ${priority}, workerType: ${task.workerType}, workerId: ${workerId})${stageNote}. The worker has started; you will be notified of progress and completion.`,
          targetWorkspacePath,
          deps,
        );
      }
      return withWorkspaceRules(
        `Task ${task.id} added (priority: ${priority}, workerType: ${task.workerType})${stageNote}. All concurrency slots are busy — the task is queued and will start automatically when a slot frees (a STARTED signal will name its worker). You will be notified when the task completes.`,
        targetWorkspacePath,
        deps,
      );
    }),
  });
}
