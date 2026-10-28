/**
 * Wayang CLI entry point
 *
 * Usage:
 *   wayang                       New session
 *   wayang --resume              List sessions, interactive select
 *   wayang --resume <id>         Resume specific session
 *   wayang --resume --all        List all sessions (cross-workspace)
 *   wayang server                Headless logic process (RPC over stdio)
 *   wayang -v                    Verbose logging
 *
 * Options:
 *   --home-dir <path>            Root for sessions & config (default: $HOME)
 *   --workspace-dir, -w <path>   Working directory for tools (default: pwd)
 *   --config, -c <path>          Config file path
 *   --resume, -r                 Resume a previous session
 *   --all                        Show all sessions (with --resume)
 *   --verbose, -v                Enable debug logging
 *
 * Server-only options (with `wayang server`):
 *   --session <new|resume:<id>>  Session decision made by the client
 *   --inject-previous-tasks      Surface unfinished tasks on sessionless resume
 *   --log-level <level>          Log level for the server process
 */

import * as path from 'node:path';
import meow from 'meow';
import { bootstrap } from './bootstrap';
import { serverMain } from './server/main';

const cli = meow(`
  Usage
    $ wayang                       Resume latest session for this workspace (or new)
    $ wayang --fresh               Start a brand-new session (ignore prior context)
    $ wayang --resume              Interactive session select
    $ wayang --resume <id>         Resume specific session
    $ wayang --resume --all        Show all workspaces
    $ wayang server                Run the headless logic process (RPC over stdio)

  Options
    --home-dir <path>       Root directory for sessions and config (default: $HOME)
    --workspace-dir, -w     Working directory for tools (default: pwd)
    --config, -c            Config file path
    --fresh, -n             Start a new session (do not inherit prior context)
    --resume, -r            Pick a session to resume (interactive, or <id>)
    --all                   List sessions across all workspaces (with --resume)
    --verbose, -v           Enable debug logging
    --session <mode>        (server) "new" or "resume:<id>"
    --inject-previous-tasks (server) surface unfinished tasks on resume
    --log-level <level>     (server) log level
`, {
  importMeta: import.meta,
  flags: {
    homeDir: {
      type: 'string',
      default: process.env.HOME || '~',
    },
    workspaceDir: {
      type: 'string',
      shortFlag: 'w',
      default: process.cwd(),
    },
    config: {
      type: 'string',
      shortFlag: 'c',
    },
    fresh: {
      type: 'boolean',
      shortFlag: 'n',
      default: false,
    },
    resume: {
      type: 'boolean',
      shortFlag: 'r',
      default: false,
    },
    all: {
      type: 'boolean',
      default: false,
    },
    verbose: {
      type: 'boolean',
      shortFlag: 'v',
      default: false,
    },
    session: {
      type: 'string',
    },
    injectPreviousTasks: {
      type: 'boolean',
      default: false,
    },
    logLevel: {
      type: 'string',
    },
  },
});

const homeDir = path.resolve(cli.flags.homeDir);
const workspaceDir = path.resolve(cli.flags.workspaceDir);
const configPath = cli.flags.config
  ? path.resolve(cli.flags.config)
  : path.join(homeDir, '.wayang.config.json');

function fatal(err: unknown): never {
  console.error('Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
}

if (cli.input[0] === 'server') {
  serverMain({
    configPath,
    homeDir: path.join(homeDir, '.wayang'),
    workspaceDir,
    session: cli.flags.session ?? 'new',
    injectPreviousTasks: cli.flags.injectPreviousTasks,
    logLevel: cli.flags.logLevel ?? (cli.flags.verbose ? 'debug' : 'info'),
  }).catch(fatal);
} else {
  // --resume [id]: id is the first positional argument
  const resumeFlag = cli.flags.resume;
  const resumeId = resumeFlag ? (cli.input.at(0) || undefined) : undefined;

  bootstrap({
    configPath,
    homeDir: path.join(homeDir, '.wayang'),
    workspaceDir,
    logLevel: cli.flags.verbose ? 'debug' : 'info',
    fresh: cli.flags.fresh,
    resume: resumeFlag ? (resumeId ?? '') : undefined,
    showAll: cli.flags.all,
  }).catch(fatal);
}
