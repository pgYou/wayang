/**
 * `wayang server` entry — headless logic process.
 *
 * All session/config decisions were already made by the client and are
 * passed as options; this process never prompts. The config arrives as a
 * `WayangConfig` OBJECT (monorepo-design 4.1 改造一) — the host (cli /
 * desktop) owns locating, reading and validating the config; a missing
 * config is a structured boot error, never an interactive prompt.
 */

import { runWayangServer } from './wayang-server';
import type { WayangConfig } from '@wayang-ai/protocol';

/** Structured boot failure — machine-readable for hosts (desktop included). */
export class ServerBootError extends Error {
  constructor(
    /** Boot failure kind: `CONFIG_MISSING` — no config object was injected. */
    readonly code: 'CONFIG_MISSING',
    message: string,
  ) {
    super(message);
    this.name = 'ServerBootError';
  }
}

export interface ServerMainOptions {
  /** Fully resolved config object, produced by the host. Never a file path. */
  config: WayangConfig;
  /** Wayang home dir (the `~/.wayang` equivalent). */
  dataDir: string;
  workspaceDir: string;
  /** `'new'` or `'resume:<sessionId>'`. */
  session: string;
  injectPreviousTasks: boolean;
  logLevel?: string;
}

export async function serverMain(options: ServerMainOptions): Promise<void> {
  // Zero prompts, zero file reads: an absent config object is a structured
  // error the host can render however it wants (desktop takeover premise).
  if (typeof options.config !== 'object' || options.config === null || Array.isArray(options.config)) {
    throw new ServerBootError(
      'CONFIG_MISSING',
      'serverMain requires a resolved WayangConfig object (design 4.1: the host owns config loading; the server never reads files, env or prompts)',
    );
  }

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
    config: options.config,
    dataDir: options.dataDir,
    workspaceDir: options.workspaceDir,
    session,
    injectPreviousTasks: options.injectPreviousTasks,
    logLevel: options.logLevel,
  });

  // The RPC transport, supervisor loop and logger keep the event loop alive.
}
