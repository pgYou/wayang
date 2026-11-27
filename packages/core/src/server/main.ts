/**
 * `wayang server` entry — headless logic process.
 *
 * All session/config decisions were already made by the client and are
 * passed as options; this process never prompts. The config arrives as a
 * `WayangConfig` OBJECT (monorepo-design 4.1 改造一) — the host (cli /
 * desktop) owns locating, reading and validating the config; a missing
 * config is a structured boot error, never an interactive prompt.
 */

import type { Readable, Writable } from 'node:stream';
import { runWayangServer } from './wayang-server';
import type { StoragePaths, WayangConfig, WorkspacePolicy } from '@wayang-ai/protocol';

/** The `--session` argv value parsed into its structured form. */
export type SessionDecision = { mode: 'new' } | { mode: 'resume'; sessionId: string };

/**
 * Parse the `--session` argv value (`new` | `resume:<id>`). Pure argv-level
 * validation, no I/O: hosts run it BEFORE config resolution so a bad value
 * fails fast with the flag echoed (0.9.9 order) — otherwise the config-missing
 * fatal fires first in config-less environments (CI runners) and masks the
 * usage error. `serverMain` re-runs the same function, so there is no drift.
 */
export function parseSessionArg(value: string): SessionDecision {
  if (value === 'new') {
    return { mode: 'new' };
  }
  if (value.startsWith('resume:')) {
    const sessionId = value.slice('resume:'.length);
    if (!sessionId) throw new Error('Invalid --session: resume: requires a session id');
    return { mode: 'resume', sessionId };
  }
  throw new Error(`Invalid --session "${value}" (expected "new" or "resume:<id>")`);
}

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
  /**
   * Injected storage paths (monorepo-design 4.2 改造二): data root, session
   * log dir, session cache dir. Optional — omitted, the Supervisor applies
   * the CLI defaults (log/cache = session dir, the 0.9.9 layout). Hosts with
   * different locations (desktop) inject them here.
   */
  storagePaths?: StoragePaths;
  /**
   * Injected workspace anchors (monorepo-design 4.2 改造二): controller
   * dispatch baseline / controller tool cwd, and the default worker
   * workspace. Optional — omitted, the Supervisor applies the CLI defaults
   * (controllerWorkspace = `workspaceDir`, defaultWorkerWorkspace =
   * `<dataDir>/workspace`).
   */
  workspacePolicy?: WorkspacePolicy;
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
  // Zero prompts, zero file reads: an absent config object is a structured
  // error the host can render however it wants (desktop takeover premise).
  if (typeof options.config !== 'object' || options.config === null || Array.isArray(options.config)) {
    throw new ServerBootError(
      'CONFIG_MISSING',
      'serverMain requires a resolved WayangConfig object (design 4.1: the host owns config loading; the server never reads files, env or prompts)',
    );
  }

  const session = parseSessionArg(options.session);

  await runWayangServer({
    config: options.config,
    dataDir: options.dataDir,
    workspaceDir: options.workspaceDir,
    storagePaths: options.storagePaths,
    workspacePolicy: options.workspacePolicy,
    session,
    injectPreviousTasks: options.injectPreviousTasks,
    logLevel: options.logLevel,
  }, io);

  // The RPC transport, supervisor loop and logger keep the event loop alive.
}
