/**
 * server-entry — the CLI's headless server host.
 *
 * Same argv surface as `wayang server` (`['server', ...flags]`), but as a
 * dedicated slim bundle: the TUI client spawns this file instead of re-using
 * the full cli.js, so the server process never carries ink/react. Argument
 * parsing is shared with cli.ts via parseCliArgs — no drift by construction.
 */

import * as path from 'node:path';
import { parseCliArgs, resolveWayangRoot } from './cli-args';
import { normalizeWorkspacePath } from '@wayang-ai/core/infra/workspace-registry';
import { serverMain } from '@wayang-ai/core/server/main';

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
const configPath = flags.config
  ? path.resolve(flags.config)
  : path.join(wayangRoot, '.wayang.config.json');

serverMain({
  configPath,
  dataDir: path.join(wayangRoot, '.wayang'),
  workspaceDir,
  session: flags.session ?? 'new',
  injectPreviousTasks: flags.injectPreviousTasks,
  logLevel: flags.logLevel ?? (flags.verbose ? 'debug' : 'info'),
}).catch((err: unknown) => {
  console.error('Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
