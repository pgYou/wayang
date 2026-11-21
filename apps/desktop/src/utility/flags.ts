/**
 * Host flag parsing for the desktop utility entry — 1:1 with
 * ServerMainOptions. Kept dependency-free so the host stays a thin env layer.
 */

export interface HostFlags {
  config: string;
  dataDir: string;
  workspaceDir: string;
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
  return {
    config: str('config'),
    dataDir: str('data-dir'),
    workspaceDir: str('workspace-dir'),
    session: str('session'),
    logLevel: typeof flags['log-level'] === 'string' ? (flags['log-level'] as string) : 'info',
    injectPreviousTasks: flags['inject-previous-tasks'] === true,
  };
}
