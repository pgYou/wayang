/**
 * General workspace — where tasks that belong to no codebase run.
 *
 * Every task executes in a workspace directory: it is the worker's cwd, its
 * file-tool root and the boundary of its permission checks. Most work happens
 * inside a project, but not all of it — research, collecting material, looking
 * something up, drafting a document. Those tasks have no repository to run in,
 * so they get one stable directory of their own under the Wayang data dir:
 *
 *   `<wayangDir>/workspace`   (i.e. ~/.wayang/workspace by default)
 *
 * Monorepo-design 4.2 改造二: the path is no longer reverse-derived from the
 * session layout (the old parent walk above `sessions/` with a homedir
 * fallback). It is the INJECTED `WorkspacePolicy.defaultWorkerWorkspace` the
 * host (or the Supervisor's CLI-default assembly) resolved — core makes no
 * assumption about where the data dir sits.
 *
 * Why here and not /tmp or the home directory:
 * - It sits inside the wayang data dir (under the user's home by default), so
 *   the path policy's ordinary scope rules cover it and a task needs no extra
 *   grant to run there.
 * - It is NOT on the sensitive list (released in 0.8.3 along with the rest of
 *   ~/.wayang): its whole point is that a worker can read and write there.
 * - It is stable. A per-session temp dir disappears with the session; this one
 *   keeps what the previous task produced, which is what "collect material,
 *   then draft from it" actually needs.
 *
 * Resolution is pure (no filesystem access), so building a prompt can never
 * fail on a read-only or exotic home. Creation is opt-in via `ensure…` and
 * idempotent (`mkdir -p`).
 */

import { mkdirSync } from 'node:fs';

/**
 * What resolving the general workspace needs: the injected workspace policy
 * (monorepo-design 4.2 改造二). `SystemContext` satisfies this shape directly
 * (`ctx.workspacePolicy`).
 */
export interface GeneralWorkspaceContext {
  /** Injected workspace anchors. */
  workspacePolicy: { defaultWorkerWorkspace: string };
}

/**
 * Absolute path of the general workspace — never touches the filesystem.
 *
 * Callers that only advertise or compare the path (prompts, tool
 * descriptions) use this; callers about to use the directory use
 * `ensureGeneralWorkspace` instead.
 */
export function resolveGeneralWorkspace(ctx: GeneralWorkspaceContext): string {
  return ctx.workspacePolicy.defaultWorkerWorkspace;
}

/**
 * Resolve the general workspace and make sure it exists (`mkdir -p`,
 * idempotent). Returns the absolute path; a directory that already exists is
 * left untouched, and a failure (read-only home, path blocked by a file)
 * propagates to the caller — silently falling back to another directory would
 * run the task somewhere it was never meant to run.
 */
export function ensureGeneralWorkspace(ctx: GeneralWorkspaceContext): string {
  const dir = resolveGeneralWorkspace(ctx);
  mkdirSync(dir, { recursive: true });
  return dir;
}
