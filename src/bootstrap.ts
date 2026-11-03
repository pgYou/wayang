/**
 * Wayang — shared bootstrap logic
 *
 * Orchestrates: config loading → session resolution → headless server
 * spawn → TUI render. Interactive flows (onboard, session select) stay
 * in this (client) process; the logic process never prompts.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { connectRemoteServer } from './client/connect';
import type { ConnectOptions, RemoteConnection } from './client/connect';
import { getSession, getLatestSessionForWorkspace } from './infra/session-helpers';
import { normalizeWorkspacePath, resolveWorkspaceRef } from './infra/workspace-registry';
import type { WorkspaceRef } from './infra/workspace-registry';
import { SESSION_LOCKED_MARKER } from './infra/session-lock';
import { SessionManager } from './services/session/session-manager';
import { renderInkUI } from './tui/render';
import { loadConfig } from './onboard';
import { selectSessionInteractive } from './session-select';

// --- Types ---

export interface BootstrapOptions {
  configPath: string;
  /**
   * Root directory containing the `.wayang` data dir (usually $HOME).
   * Matches the `--home-dir` flag semantics so the same value can be
   * forwarded to the server process.
   */
  homeDir: string;
  /**
   * Workspace for this invocation: the initial workspace of a new session.
   * On resume it never rewrites the session's recorded workspaces — it only
   * filters the interactive picker and serves as the fallback for a session
   * that records no workspace at all.
   */
  workspaceDir: string;
  logLevel?: string;
  /**
   * Start a brand-new session, ignoring any prior context for this workspace.
   * Mutually exclusive with `resume`.
   */
  fresh?: boolean;
  /**
   * Resume mode:
   * - undefined → sessionless default: inherit latest session for this workspace
   * - '' (empty string) → interactive session select
   * - '<id>' → resume specific session
   */
  resume?: string;
  /** Show sessions from all workspaces (with --resume). */
  showAll?: boolean;
}

function die(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

/**
 * Spawn the server, turning a session-ownership conflict into a plain-language
 * message instead of "server exited before becoming ready".
 *
 * The lock check lives in the server process (it owns the session directory),
 * so a conflict arrives here only as the child's stderr tail, embedded in the
 * transport error. We look for the marker the server prints and re-surface that
 * block verbatim — it already contains the holder pid/start time, the session
 * path, and the --resume / --fresh next steps.
 */
async function connectToServer(options: ConnectOptions): Promise<RemoteConnection> {
  try {
    return await connectRemoteServer(options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const markerAt = message.indexOf(SESSION_LOCKED_MARKER);
    if (markerAt === -1) throw err;
    die(message.slice(markerAt).trim());
  }
}

/**
 * Workspace a session should run in when it is resumed.
 *
 * `meta.workspace` keeps the original spelling of the directory the session
 * was *started* in, and a session may have touched several workspaces since.
 * `SessionManager.startupWorkspace` resolves the canonical entry matching
 * `meta.workspace`, which is the right process workspace for a resume.
 *
 * A session with more than one workspace keeps the remaining entries in its
 * meta, where the server-side controller can still see them
 * (`session.workspaces`) — this helper deliberately does not switch to or
 * expose those others. Only the startup workspace becomes `workspaceDir`.
 */
async function resolveStartupWorkspace(
  sessionId: string,
  sessionDir: string,
  wayangHome: string,
): Promise<WorkspaceRef | undefined> {
  const manager = SessionManager.resume(sessionId, sessionDir, wayangHome);
  await manager.restore();
  return manager.startupWorkspace;
}

/**
 * Guard a resumed session's startup directory.
 *
 * `startupWorkspace` can resolve to a directory that has since been moved or
 * deleted (the session was started there, then the folder was removed or
 * renamed). Adopting that path as the process workspace would point every
 * dispatched task's cwd — and the permission gate's boundary — at a nonexistent
 * directory, so the first restore-dispatch fails with an opaque error. Fail
 * fast instead, telling the user how to recover.
 */
function assertRecoverableWorkspace(resolved: WorkspaceRef, sessionId: string): void {
  if (fs.existsSync(resolved.path)) return;
  die(
    `Cannot resume session "${sessionId}": its startup workspace ${resolved.path} no longer exists ` +
      `(the directory was moved or deleted). Resume a different session with --resume (or --fresh to start a new one).`,
  );
}

/**
 * Canonicalize and de-duplicate a session's workspace list for display.
 *
 * A resumed session's meta can name the same directory through different
 * spellings (symlink vs. realpath) or repeat an entry. The TUI's "first + N"
 * banner counts list length, so leaving variants un-collapsed would overstate
 * the workspace count. Freshly-resolved refs (`resolveWorkspaceRef`) are already
 * canonical, but `workspaces` read back from disk is forwarded verbatim here —
 * normalize each path the same way the process workspace is, and keep only the
 * first occurrence of each canonical path.
 */
function dedupeDisplayWorkspaces(refs: ReadonlyArray<WorkspaceRef>): WorkspaceRef[] {
  const seen = new Set<string>();
  const result: WorkspaceRef[] = [];
  for (const ref of refs) {
    const normalized = normalizeWorkspacePath(ref.path);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push({ ...ref, path: normalized });
  }
  return result;
}

// --- Bootstrap ---

export async function bootstrap(options: BootstrapOptions): Promise<void> {
  // Resolve the actual data dir once; forwarded as-is to the server spawn so
  // the server's `--home-dir` (root semantics) does not double-join `.wayang`.
  const wayangHome = path.join(options.homeDir, '.wayang');

  // Client-side load keeps interactive onboarding in the terminal; the
  // server reloads the (now persisted) config non-interactively.
  await loadConfig(options.configPath);

  let session: 'new' | { resume: string } = 'new';
  let injectPreviousTasks = false;
  let workspaceDir = options.workspaceDir;
  // Workspace identities this session has touched — display-only, forwarded to
  // the TUI so the session banner can render "first + N" for multi-workspace
  // sessions. Resolved from the resumed session's meta when available.
  let sessionWorkspaces: WorkspaceRef[] = [];

  if (options.fresh) {
    // Explicit new session — do not inherit prior context.
  } else if (options.resume === undefined) {
    // Sessionless default: inherit the latest session for this workspace.
    // If none exists, fall through to a new session.
    const latest = getLatestSessionForWorkspace(wayangHome, options.workspaceDir);
    if (latest) {
      session = { resume: latest.sessionId };
      // Only the sessionless path surfaces unfinished tasks as a signal — an
      // explicit --resume means "continue this exact session as-is".
      injectPreviousTasks = true;
      sessionWorkspaces = latest.meta.workspaces ?? [];
      console.log(`  Resuming session ${latest.sessionId}`);
    }
  } else if (options.resume === '') {
    // Interactive session select (--resume without ID)
    const result = await selectSessionInteractive(wayangHome, options.workspaceDir, options.showAll ?? false);
    const startup = await resolveStartupWorkspace(result.sessionId, result.sessionDir, wayangHome);
    // A resumed session whose startup directory is gone cannot be dispatched
    // into — fail with an actionable message instead of an invalid cwd.
    if (startup) assertRecoverableWorkspace(startup, result.sessionId);
    // Fall back to the raw recorded workspace, then to the CLI value, for
    // sessions whose meta carries no usable workspace identity.
    workspaceDir = startup?.path ?? (result.meta.workspace || workspaceDir);
    session = { resume: result.sessionId };
    sessionWorkspaces = result.meta.workspaces ?? [];
    console.log(`  Resuming session ${result.sessionId}`);
  } else {
    // Resume specific session (--resume <id>)
    const existing = getSession(wayangHome, options.resume);
    if (!existing) {
      die(`Session "${options.resume}" not found.`);
    }
    const startup = await resolveStartupWorkspace(existing.sessionId, existing.sessionDir, wayangHome);
    // Same guard as the interactive path: refuse a deleted startup directory.
    if (startup) assertRecoverableWorkspace(startup, existing.sessionId);
    workspaceDir = startup?.path ?? (existing.meta.workspace || workspaceDir);
    session = { resume: existing.sessionId };
    sessionWorkspaces = existing.meta.workspaces ?? [];
    console.log(`  Resuming session ${existing.sessionId}`);
  }

  // Resume paths replace the CLI workspace with the session's startup
  // workspace, which may predate canonicalization (or have been written by
  // another tool). Canonicalize it the same way the CLI does — realpath when it
  // exists, plain resolve otherwise — so the process workspace always matches
  // the normalization used for task workspaces and the permission gate. The
  // session meta itself is read, never rewritten.
  workspaceDir = normalizeWorkspacePath(workspaceDir);

  // Display-only workspace list: mirror the same canonicalization and drop
  // duplicates so the banner's "first + N" counts distinct workspaces, not
  // spelling variants or repeated entries.
  sessionWorkspaces = dedupeDisplayWorkspaces(sessionWorkspaces);

  // A brand-new session (or legacy meta without `workspaces`) still has one
  // workspace: the directory it runs in. Resolve it through the registry so the
  // banner's slug matches the one stamped on tasks.
  if (sessionWorkspaces.length === 0) {
    sessionWorkspaces = [resolveWorkspaceRef(wayangHome, workspaceDir)];
  }

  const { remote, stop } = await connectToServer({
    configPath: options.configPath,
    // Pass the ROOT dir: the server's `--home-dir` flag expects it and joins
    // `.wayang` itself. Passing the pre-joined dir caused a double join.
    homeDir: options.homeDir,
    workspaceDir,
    workspaces: sessionWorkspaces,
    session,
    injectPreviousTasks,
    logLevel: options.logLevel,
  });

  // Graceful shutdown on SIGTERM (external kill)
  process.on('SIGTERM', () => {
    void stop().then(() => process.exit(0));
  });

  await renderInkUI(remote);
  await stop();
}
