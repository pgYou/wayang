/**
 * Wayang — shared bootstrap logic
 *
 * Orchestrates: config loading → session resolution → Supervisor startup.
 * Interactive flows (onboard, session select) are in separate modules.
 */

import { Supervisor, type SupervisorOptions } from './services/supervisor';
import { ControllerLoop } from './services/controller-loop';
import { getSession } from './infra/session-helpers';
import { renderInkUI } from './tui/render';
import { loadConfig } from './onboard';
import { selectSessionInteractive } from './session-select';

// --- Types ---

export interface BootstrapOptions {
  configPath: string;
  homeDir: string;
  workspaceDir: string;
  logLevel?: string;
  /**
   * Resume mode:
   * - undefined → new session
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
  const config = await loadConfig(options.configPath);

  const supervisorOpts: SupervisorOptions = {
    config,
    workspaceDir: options.workspaceDir,
    logLevel: options.logLevel,
    homeDir: options.homeDir,
  };

  if (options.resume === undefined) {
    // New session — homeDir already set
  } else if (options.resume === '') {
    // Interactive session select (--resume without ID)
    const result = await selectSessionInteractive(options.homeDir, options.workspaceDir, options.showAll ?? false);
    supervisorOpts.workspaceDir = result.meta.workspace;
    supervisorOpts.resume = { sessionId: result.sessionId, sessionDir: result.sessionDir };
    console.log(`  Resuming session ${result.sessionId}`);
  } else {
    // Resume specific session (--resume <id>)
    const existing = getSession(options.homeDir, options.resume);
    if (!existing) {
      die(`Session "${options.resume}" not found.`);
    }
    supervisorOpts.workspaceDir = existing.meta.workspace;
    supervisorOpts.resume = { sessionId: existing.sessionId, sessionDir: existing.sessionDir };
    console.log(`  Resuming session ${existing.sessionId}`);
  }

  const supervisor = new Supervisor(supervisorOpts);

  await supervisor.restore();
  await supervisor.start();

  const controllerLoop = new ControllerLoop(supervisor);

  controllerLoop.start().catch((err) => {
    supervisor.ctx.logger.error({ error: err.message }, 'Controller loop crashed');
  });

  // Graceful shutdown on SIGTERM (external kill)
  process.on('SIGTERM', () => {
    controllerLoop.shutdown();
    supervisor.shutdown().then(() => process.exit(0));
  });

  await renderInkUI(supervisor);
  controllerLoop.shutdown();
  await supervisor.shutdown();
}
