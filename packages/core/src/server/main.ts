/**
 * `wayang server` entry — headless logic process.
 *
 * All session/config decisions were already made by the client and are
 * passed as options; this process never prompts.
 */

import type { Readable, Writable } from 'node:stream';
import { runWayangServer } from './wayang-server';

export interface ServerMainOptions {
  configPath: string;
  /** Wayang home dir (the `~/.wayang` equivalent). */
  dataDir: string;
  workspaceDir: string;
  /** `'new'` or `'resume:<sessionId>'`. */
  session: string;
  injectPreviousTasks: boolean;
  logLevel?: string;
}

/**
 * Optional io injection: hosts that are not a plain stdio process (Electron
 * UtilityProcess over a message port) pass their own stream pair; the default
 * (`process`) keeps the CLI behavior unchanged.
 */
export interface ServerIo {
  stdin: Readable;
  stdout: Writable;
}

export async function serverMain(options: ServerMainOptions, io?: ServerIo): Promise<void> {
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
    dataDir: options.dataDir,
    workspaceDir: options.workspaceDir,
    session,
    injectPreviousTasks: options.injectPreviousTasks,
    logLevel: options.logLevel,
  }, io);

  // The RPC transport, supervisor loop and logger keep the event loop alive.
}
