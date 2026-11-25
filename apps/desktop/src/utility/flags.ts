/**
 * Host flag parsing for the desktop utility entry — 1:1 with
 * ServerMainOptions. Kept dependency-free so the host stays a thin env layer.
 *
 * The legacy `--data-dir` / `--workspace-dir` pair is retained only because
 * core's ServerMainOptions still takes both fields; their values now mirror
 * the injected contract members (dataDir = storagePaths.dataDir,
 * workspaceDir = workspacePolicy.controllerWorkspace) so there is a single
 * semantic source. `--log-dir` / `--cache-dir` / `--default-worker-workspace`
 * carry the explicit injection (§2.5); a standalone manual run may omit them
 * and gets the CLI-default layout resolved inside the Supervisor.
 */

export interface HostFlags {
  config: string;
  dataDir: string;
  workspaceDir: string;
  /** storagePaths.logDir — present when the host injects storage paths. */
  logDir?: string;
  /** storagePaths.cacheDir — present when the host injects storage paths. */
  cacheDir?: string;
  /**
   * workspacePolicy.defaultWorkerWorkspace. Falls back to `<dataDir>/workspace`
   * (the CLI default) when a standalone run omits it.
   */
  defaultWorkerWorkspace?: string;
  session: string;
  logLevel: string;
  injectPreviousTasks: boolean;
}

export function parseHostFlags(argv: ReadonlyArray<string>): HostFlags {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  const str = (key: string): string => {
    const value = flags[key];
    if (typeof value !== 'string' || value === '') throw new Error(`Missing --${key}`);
    return value;
  };
  const optStr = (key: string): string | undefined => {
    const value = flags[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value === '') throw new Error(`--${key} requires a value`);
    return value;
  };
  const logDir = optStr('log-dir');
  const cacheDir = optStr('cache-dir');
  if ((logDir === undefined) !== (cacheDir === undefined)) {
    throw new Error('--log-dir and --cache-dir go together (both or neither)');
  }
  return {
    config: str('config'),
    dataDir: str('data-dir'),
    workspaceDir: str('workspace-dir'),
    logDir,
    cacheDir,
    defaultWorkerWorkspace: optStr('default-worker-workspace'),
    session: str('session'),
    logLevel: typeof flags['log-level'] === 'string' ? (flags['log-level'] as string) : 'info',
    injectPreviousTasks: flags['inject-previous-tasks'] === true,
  };
}
