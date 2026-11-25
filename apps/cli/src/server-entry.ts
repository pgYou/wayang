/**
 * server-entry — the CLI's headless server host.
 *
 * Same argv surface as `wayang server` (`['server', ...flags]`), but as a
 * dedicated slim bundle: the TUI client spawns this file instead of re-using
 * the full cli.js, so the server process never carries ink/react. Argument
 * parsing is shared with cli.ts via parseCliArgs — no drift by construction.
 *
 * Config handoff (design 4.1 改造一): the spawning client already resolved
 * and validated the config once and passes the object through the child
 * environment (`WAYANG_CONFIG_OBJECT`, a JSON serialization). This entry
 * deserializes it and hands the OBJECT to `serverMain` — no second parse.
 * Standalone invocations (no env object) fall back to reading `--config`
 * non-interactively, so the argv surface keeps working when run by hand.
 */

import * as path from 'node:path';
import { parseCliArgs, resolveWayangRoot } from './cli-args';
import { normalizeWorkspacePath } from '@wayang-ai/core/infra/workspace-registry';
import { serverMain, parseSessionArg } from '@wayang-ai/core/server/main';
import { loadConfig } from './config-loader';
import { CONFIG_OBJECT_ENV } from './config-env';
import type { WayangConfig } from '@wayang-ai/protocol';

const result = parseCliArgs(process.argv.slice(2));

if (result.status === 'version') {
  console.log(result.version);
  process.exit(0);
}
if (result.status === 'help') {
  console.log(result.help);
  process.exit(0);
}
if (result.status === 'error') {
  for (const problem of result.problems) {
    console.error(`Error: ${problem}`);
  }
  process.exit(1);
}

const { input, flags } = result;
if (input[0] !== 'server') {
  console.error('server-entry expects the `server` subcommand as its first argument.');
  process.exit(1);
}

const { root: wayangRoot } = resolveWayangRoot(flags);
const workspaceDir = normalizeWorkspacePath(flags.workspaceDir ?? process.cwd());
const dataDir = path.join(wayangRoot, '.wayang');
const configPath = flags.config
  ? path.resolve(flags.config)
  : path.join(wayangRoot, '.wayang.config.json');

/** The config object, never a path: from the client's env handoff, or a single non-interactive load. */
async function resolveServerConfig(): Promise<WayangConfig> {
  const injected = process.env[CONFIG_OBJECT_ENV];
  if (injected !== undefined) {
    return JSON.parse(injected) as WayangConfig;
  }
  // Standalone run (not spawned by the TUI client): the argv surface keeps
  // its `--config` meaning. Still app-side parsing — core only ever sees the
  // resulting object.
  return loadConfig(configPath, { nonInteractive: true });
}

// argv-level usage validation BEFORE any config resolution (0.9.9 order): a
// bad --session value exits here with the flag echoed; only valid arguments
// may reach config loading, so the config-missing fatal cannot mask the usage
// error when standalone in a config-less environment. The env-object handoff
// path never sees this (the client constructs valid values), but the check is
// pure and cheap. Same shared parser serverMain re-runs — no drift.
try {
  parseSessionArg(flags.session ?? 'new');
} catch (err: unknown) {
  console.error('Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
}

resolveServerConfig()
  .then((config) =>
    serverMain({
      config,
      dataDir,
      workspaceDir,
      // Host-constructed workspace anchors (monorepo-design 4.2 改造二): the
      // controllerWorkspace is the directory the user launched in (0.9.9
      // behavior — resolved by the HOST, which is allowed to read
      // process.cwd), the defaultWorkerWorkspace is the general workspace
      // `<dataDir>/workspace`. StoragePaths stay unset: the CLI default
      // (log/cache = session dir, 0.9.9 layout) resolves in the Supervisor
      // because a NEW session's dir only exists once the server creates it.
      workspacePolicy: {
        controllerWorkspace: workspaceDir,
        defaultWorkerWorkspace: path.join(dataDir, 'workspace'),
      },
      session: flags.session ?? 'new',
      injectPreviousTasks: flags.injectPreviousTasks,
      logLevel: flags.logLevel ?? (flags.verbose ? 'debug' : 'info'),
    }),
  )
  .catch((err: unknown) => {
    console.error('Fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
