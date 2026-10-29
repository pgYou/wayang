/**
 * Wayang — shared bootstrap logic
 *
 * Orchestrates: config loading → session resolution → headless server
 * spawn → TUI render. Interactive flows (onboard, session select) stay
 * in this (client) process; the logic process never prompts.
 */

import * as path from 'node:path';
import { connectRemoteServer } from './client/connect';
import { getSession, getLatestSessionForWorkspace } from './infra/session-helpers';
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
      console.log(`  Resuming session ${latest.sessionId}`);
    }
  } else if (options.resume === '') {
    // Interactive session select (--resume without ID)
    const result = await selectSessionInteractive(wayangHome, options.workspaceDir, options.showAll ?? false);
    workspaceDir = result.meta.workspace;
    session = { resume: result.sessionId };
    console.log(`  Resuming session ${result.sessionId}`);
  } else {
    // Resume specific session (--resume <id>)
    const existing = getSession(wayangHome, options.resume);
    if (!existing) {
      die(`Session "${options.resume}" not found.`);
    }
    workspaceDir = existing.meta.workspace;
    session = { resume: existing.sessionId };
    console.log(`  Resuming session ${existing.sessionId}`);
  }

  const { remote, stop } = await connectRemoteServer({
    configPath: options.configPath,
    // Pass the ROOT dir: the server's `--home-dir` flag expects it and joins
    // `.wayang` itself. Passing the pre-joined dir caused a double join.
    homeDir: options.homeDir,
    workspaceDir,
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
