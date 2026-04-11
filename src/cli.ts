/**
 * Wayang CLI entry point
 *
 * Usage:
 *   wayang                       New session
 *   wayang --resume              List sessions, interactive select
 *   wayang --resume <id>         Resume specific session
 *   wayang --resume --all        List all sessions (cross-workspace)
 *   wayang -v                    Verbose logging
 *
 * Options:
 *   --home-dir <path>            Root for sessions & config (default: $HOME)
 *   --workspace-dir, -w <path>   Working directory for tools (default: pwd)
 *   --config, -c <path>          Config file path
 *   --resume, -r                 Resume a previous session
 *   --all                        Show all sessions (with --resume)
 *   --verbose, -v                Enable debug logging
 */

import * as path from 'node:path';
import meow from 'meow';
import { bootstrap } from './bootstrap';

const cli = meow(`
  Usage
    $ wayang                       New session
    $ wayang --resume              Interactive session select
    $ wayang --resume <id>         Resume specific session
    $ wayang --resume --all        Show all workspaces

  Options
    --home-dir <path>       Root directory for sessions & config (default: $HOME)
    --workspace-dir, -w     Working directory for tools (default: pwd)
    --config, -c            Config file path
    --resume, -r            Resume a previous session
    --all                   List sessions across all workspaces (with --resume)
    --verbose, -v           Enable debug logging
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
  },
});

const homeDir = path.resolve(cli.flags.homeDir);
const workspaceDir = path.resolve(cli.flags.workspaceDir);
const configPath = cli.flags.config
  ? path.resolve(cli.flags.config)
  : path.join(homeDir, '.wayang.config.json');

// --resume [id]: id is the first positional argument
const resumeFlag = cli.flags.resume;
const resumeId = resumeFlag ? (cli.input.at(0) || undefined) : undefined;

bootstrap({
  configPath,
  homeDir: path.join(homeDir, '.wayang'),
  workspaceDir,
  logLevel: cli.flags.verbose ? 'debug' : 'info',
  resume: resumeFlag ? (resumeId ?? '') : undefined,
  showAll: cli.flags.all,
}).catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
