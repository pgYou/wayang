import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { TaskDetail } from '@/types/index';
import type { PermissionConfig } from '@/types/config';
import type { Logger } from '@/infra/logger';
import { normalizeWorkspacePath, resolveWorkspaceRef } from '@/infra/workspace-registry';
import { defaultSensitivePaths, isDenied, isPathWithin, normalizePath } from '@/infra/permission/policy';
import { mergeSensitiveDirs } from '@/infra/permission/permission-config';
import { generateId } from '@/utils/id';
import { defineTool, safeExecute } from './common';
import { expandHome } from './permission-rules';
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
   * inside, and the anchor of the built-in sensitive list. Injected (never read
   * globally); when absent, a call that declares `allowedDirs` is rejected
   * because the boundary cannot be checked.
   */
  userHome?: string;
  /**
   * User-config permission section. Its `sensitiveDirs` (plus the deprecated
   * `deniedDirs` alias) extend the built-in sensitive list for `allowedDirs`
   * validation. Injected (never read globally).
   */
  permissionConfig?: PermissionConfig;
  /**
   * Absolute path of the general workspace (`<wayangDir>/workspace`), i.e.
   * where tasks with no codebase of their own run. Advertised in the tool
   * description; a task that targets it creates it like any other declared
   * workspace.
   */
  generalWorkspaceDir?: string;
  /**
   * Session logger for workspace-boundary audit records (issue #77): every
   * workspace admitted through `permission.extraWorkspaceRoots` is recorded
   * here. Optional — auditing must never break the dispatch path.
   */
  logger?: Logger;
}

/**
 * Expand a leading `~` or `$HOME` in a declared workspace.
 *
 * No shell sits between the controller and this tool, so `~/notes` would
 * otherwise be taken as a directory literally named `~` next to the process
 * cwd and the task would run somewhere nobody asked for. Expansion goes
 * through the ONE shared expander (`expandHome`) and anchors on the PROCESS
 * home — the same thing a shell means by `~`. `~user` is reported
 * unresolvable: guessing whose home that is would be worse than refusing the
 * task.
 */

/**
 * Make sure a declared workspace exists. A missing directory is created
 * (`mkdir -p`, idempotent); returns an error message when that fails so the
 * call fails loudly instead of silently dropping back to the default
 * workspace.
 */
function ensureWorkspaceDir(dirPath: string): string | null {
  try {
    mkdirSync(dirPath, { recursive: true });
    return null;
  } catch (err) {
    return `Cannot create workspace ${dirPath}: ${(err as Error).message}. The task was NOT created.`;
  }
}

/**
 * Validate a DECLARED workspace against the boundary rules (issue #77).
 *
 * The normalized form — `normalizePath`: realpath when it exists, otherwise
 * the realpath of the deepest existing ancestor plus the missing tail — is
 * what gets judged, so a symlink is judged by where it lands, not by how it
 * is spelled. The normalized path must sit inside the user's home directory
 * or under a configured `permission.extraWorkspaceRoots` entry, and must not
 * match the denied-path/sensitive list (built-in plus configured, exactly the
 * list `allowedDirs` is checked against). Validation runs BEFORE anything is
 * created; a rejected declaration leaves the filesystem untouched.
 *
 * Mirrors `resolveTaskAllowedDirs`: when the home directory is unknown there
 * is no boundary to check, so the declaration is rejected outright instead of
 * silently passing unvalidated.
 */
function validateDeclaredWorkspace(
  declared: string,
  raw: string,
  deps: AddTaskToolDeps,
): { normalized: string } | { error: string } {
  const userHome = deps.userHome;
  if (!userHome) {
    return {
      error: `Cannot validate workspace "${raw}": the home directory is unknown in this context, so the task was NOT created.`,
    };
  }

  const home = normalizePath(userHome);
  const normalized = normalizePath(declared);
  const extraRoots = (deps.permissionConfig?.extraWorkspaceRoots ?? [])
    .filter((root) => typeof root === 'string' && root.trim() !== '')
    .map((root) => normalizePath(root, { base: home }));

  const admittingRoot = [home, ...extraRoots].find((root) => isPathWithin(root, normalized));
  if (admittingRoot === undefined) {
    return {
      error:
        `Invalid workspace "${raw}" (resolved to ${normalized}, reason: outside-home): it is outside the user home ` +
        `(${home}) and not under any permission.extraWorkspaceRoots entry. A task workspace must stay inside the home ` +
        `directory; to grant a task access to directories beyond it, use allowedDirs instead. The task was NOT created.`,
    };
  }

  const sensitivePaths = [
    ...defaultSensitivePaths(home),
    ...mergeSensitiveDirs(deps.permissionConfig).map((d) => normalizePath(d, { base: home })),
  ].map((d) => normalizePath(d));
  const matchedEntry = sensitivePaths.find((sensitive) => isPathWithin(sensitive, normalized));
  if (matchedEntry !== undefined) {
    return {
      error:
        `Invalid workspace "${raw}" (resolved to ${normalized}, reason: denied-path): it matches the denied-path / ` +
        `sensitive list (matched ${matchedEntry} — a protected location such as credentials or tool config). ` +
        `The task was NOT created.`,
    };
  }

  // Audited admission (issue #77): a boundary extension is only as safe as its
  // use is traceable, so every workspace let in by an extra root — not home —
  // leaves a session-log record naming the root and the admitted path.
  if (admittingRoot !== home) {
    deps.logger?.info(
      {
        audit: 'workspace',
        decision: 'allowed',
        matchedRule: 'extra-workspace-roots',
        matchedEntry: admittingRoot,
        resolvedPath: normalized,
        requestedPath: raw,
        ts: new Date().toISOString(),
      },
      'workspace admitted via permission.extraWorkspaceRoots',
    );
  }

  return { normalized };
}

/**
 * Decide which workspace a new task belongs to.
 *
 * - no `workspace` argument (or an empty/whitespace one) → the current
 *   workspace (default). The default is the directory the user launched
 *   wayang in — a human choice, so it carries no declaration to validate.
 * - a declared `workspace` → that workspace, canonicalized. A leading `~` or
 *   `$HOME` is expanded first (no shell does it for us), the normalized path
 *   must pass the boundary validation above (inside home or a configured
 *   extra root, off the denied-path list), and only THEN is a missing
 *   directory created (`mkdir -p`, idempotent). A different path is a
 *   legitimate target: the engine builds the worker, the tool cwd and the
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

  let declared: string | undefined;
  let declaredRaw = '';
  if (requested !== undefined && requested.trim() !== '') {
    const trimmed = requested.trim();
    const expanded = expandHome(trimmed);
    if (expanded.unresolvable) {
      return {
        error: `Cannot resolve workspace "${requested}": only "~" and "$HOME" expand to the home directory, so no readable path was left. The task was NOT created.`,
      };
    }
    declared = expanded.path;
    declaredRaw = trimmed;
  }

  if (!current) {
    if (declared !== undefined) {
      return {
        error: `Cannot resolve workspace ${normalizeWorkspacePath(declared)}: the current workspace is unknown in this context, so the task was NOT created.`,
      };
    }
    return {};
  }

  // Boundary first, creation second (issue #77): validate the normalized
  // declaration BEFORE materializing anything, so a rejected workspace never
  // leaves a created directory behind. Relative declarations keep their
  // long-standing meaning (resolved against the process workspace by
  // `normalizePath`/`normalizeWorkspacePath`) and go through the same check
  // after resolution.
  if (declared !== undefined) {
    const verdict = validateDeclaredWorkspace(declared, declaredRaw, deps);
    if ('error' in verdict) return { error: verdict.error };

    // An absolute declaration is the directory the task will really run in,
    // so it is materialized here (`mkdir -p`, idempotent) rather than
    // silently dropped back to the default workspace. The VALIDATED path is
    // what gets created — never a spelling that skipped the check. Only an
    // absolute one: a relative declaration keeps its meaning of "the same
    // workspace, spelled differently" and is not created.
    if (path.isAbsolute(declared)) {
      const dirError = ensureWorkspaceDir(verdict.normalized);
      if (dirError !== null) return { error: dirError };
    }
  }

  // Normalized AFTER creation, so the stamped path is the canonical form of the
  // directory that now exists (symlinked parents resolved once, not per check).
  const requestedPath = declared !== undefined ? normalizeWorkspacePath(declared) : undefined;

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
 * must not match the sensitive list (built-in entries plus configured
 * `sensitiveDirs`, `deniedDirs` included). A single bad entry fails the WHOLE
 * call — the returned error
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

  const userHome = deps.userHome;
  if (!userHome) {
    return {
      error: 'Cannot validate allowedDirs: the home directory is unknown in this context, so the task was NOT created.',
    };
  }

  const home = normalizePath(userHome);
  // Relative entries resolve against the task workspace (the same base the
  // policy uses), falling back to home when the workspace is unknown.
  const base = workspacePath !== undefined ? normalizePath(workspacePath, { base: home }) : home;
  const sensitivePaths = [
    ...defaultSensitivePaths(home),
    ...mergeSensitiveDirs(deps.permissionConfig).map((d) => normalizePath(d, { base: home })),
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

    if (isDenied(resolved, sensitivePaths)) {
      return {
        error: `Invalid allowedDirs entry "${raw}" (resolved to ${resolved}): it matches the sensitive list (a protected location such as credentials or tool config). The task was NOT created.`,
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
    userHome: deps.userHome,
    permissionConfig: deps.permissionConfig,
  });
  return summary === '' ? resultText : `${resultText}\n\n${summary}`;
}

export function addTaskTool(deps: AddTaskToolDeps) {
  // The general workspace is advertised by its resolved absolute path: a
  // `~/…` literal would be read differently by every agent that sees it.
  const generalWorkspaceNote = deps.generalWorkspaceDir
    ? ` Tasks that belong to no codebase (research, collecting material, drafting a document) run in the general workspace ${deps.generalWorkspaceDir} — it is created on first use.`
    : '';
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
        `Target workspace path; defaults to the current workspace. A different path runs this task there — the worker, its tools and its permission checks use it as their root. A leading ~ or $HOME expands to the home directory, and a missing directory is created. The normalized path (symlinks resolved) must stay inside the user home directory — or under a root the user configured in permission.extraWorkspaceRoots — and off the denied-path list; to grant a task access to other directories, use allowedDirs instead.${generalWorkspaceNote}`,
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
