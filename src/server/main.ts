/**
 * `wayang server` entry — headless logic process.
 *
 * All session/config decisions were already made by the client and are
 * passed as options; this process never prompts.
 */

import { runWayangServer } from './wayang-server';

export interface ServerMainOptions {
  configPath: string;
  /** Wayang home dir (the `~/.wayang` equivalent). */
  homeDir: string;
  workspaceDir: string;
  /** `'new'` or `'resume:<sessionId>'`. */
  session: string;
  injectPreviousTasks: boolean;
  logLevel?: string;
}

export async function serverMain(options: ServerMainOptions): Promise<void> {
  let session: { mode: 'new' } | { mode: 'resume'; sessionId: string };
  if (options.session === 'new') {
    session = { mode: 'new' };
  } else if (options.session.startsWith('resume:')) {
    const sessionId = options.session.slice('resume:'.length);
    if (!sessionId) throw new Error('Invalid --session: resume: requires a session id');
    session = { mode: 'resume', sessionId };
  } else {
    throw new Error(`Invalid --session "${options.session}" (expected "new" or "resume:<id>")`);
  }

  await runWayangServer({
    configPath: options.configPath,
    homeDir: options.homeDir,
    workspaceDir: options.workspaceDir,
    session,
    injectPreviousTasks: options.injectPreviousTasks,
    logLevel: options.logLevel,
  });

  // The RPC transport, supervisor loop and logger keep the event loop alive.
}
