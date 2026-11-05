/**
 * Wayang CLI entry point
 *
 * Usage:
 *   wayang                       New session (or resume latest for this workspace)
 *   wayang --resume              List sessions, interactive select
 *   wayang --resume <id>         Resume specific session
 *   wayang --resume --all        List all sessions (cross-workspace)
 *   wayang server                Headless logic process (RPC over stdio)
 *   wayang --verbose             Verbose logging
 *
 * Options (short forms in parentheses):
 *   --wayang-root <path>         Root for wayang state: data at <path>/.wayang,
 *                                config at <path>/.wayang.config.json
 *                                (default: $HOME). NEVER the OS user home the
 *                                permission policy anchors on.
 *   --workspace-dir, -w <path>   Working directory for tools (default: pwd);
 *                                alias: --workspace. For a new session it is
 *                                recorded as the initial workspace. With
 *                                --resume it does not rewrite the session's
 *                                recorded workspaces: it only filters the
 *                                picker and supplies the default workspace.
 *   --config, -c <path>          Config file path
 *   --new, -n                    Start a new session (do not inherit prior context)
 *   --fresh                      Deprecated alias of --new
 *   --home-dir <path>            Deprecated alias of --wayang-root
 *   --resume, -r                 Resume a previous session
 *   --all                        Show all sessions (with --resume)
 *   --verbose                    Enable debug logging (long-only)
 *   --help, -h                   Show help
 *   --version, -v                Show version
 *
 * Server-only options (with `wayang server`):
 *   --session <new|resume:<id>>  Session decision made by the client
 *   --inject-previous-tasks      Surface unfinished tasks on sessionless resume
 *   --log-level <level>          Log level for the server process
 *
 * Unknown flags, flags with missing/illegal values, etc. are rejected with an
 * error on stderr plus the help text, exiting non-zero (see src/cli-args.ts).
 */

import * as path from 'node:path';
import { parseCliArgs, resolveWayangRoot } from './cli-args';
import { bootstrap } from './bootstrap';
import { normalizeWorkspacePath } from './infra/workspace-registry';
import { SessionLockedError, formatSessionLockHint } from './infra/session-lock';
import { serverMain } from './server/main';

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
  console.log(result.help);
  process.exit(1);
}

const { input, flags } = result;

// The wayang ROOT: where runtime state lives (data at `<root>/.wayang`,
// config at `<root>/.wayang.config.json`). It has NOTHING to do with the user
// home the permission policy and `~` expansion anchor on — that is always the
// process `$HOME`, wherever wayang keeps its data.
const { root: wayangRoot, usedDeprecatedHomeDir } = resolveWayangRoot(flags);
if (usedDeprecatedHomeDir) {
  console.error(
    `Warning: --home-dir is deprecated (the name never meant the OS user home); use --wayang-root instead.${
      flags.wayangRoot !== undefined ? ' --home-dir was ignored: --wayang-root takes precedence.' : ' The behavior is unchanged.'
    }`,
  );
}
// Canonicalize the process workspace exactly like a task workspace: add_task
// stamps `task.workspace.path` through the same helper, and the permission
// gate compares string prefixes. Resolving symlinks only on one side would
// flip allow/deny decisions and make the prompt's WorkspaceDir disagree with
// the tool cwd. Non-existent paths fall back to a plain resolve.
const workspaceDir = normalizeWorkspacePath(flags.workspaceDir ?? process.cwd());
const configPath = flags.config
  ? path.resolve(flags.config)
  : path.join(wayangRoot, '.wayang.config.json');

function fatal(err: unknown): never {
  if (err instanceof SessionLockedError) {
    // Not a crash but a conflict the user can resolve: print the explanation
    // and next steps. The marker inside the message is what the client process
    // scans this stderr for when the server exits before becoming ready.
    console.error(formatSessionLockHint(err));
    process.exit(1);
  }
  console.error('Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
}

if (input[0] === 'server') {
  serverMain({
    configPath,
    dataDir: path.join(wayangRoot, '.wayang'),
    workspaceDir,
    session: flags.session ?? 'new',
    injectPreviousTasks: flags.injectPreviousTasks,
    logLevel: flags.logLevel ?? (flags.verbose ? 'debug' : 'info'),
  }).catch(fatal);
} else {
  // --resume [id]: id is the first positional argument
  const resumeFlag = flags.resume;
  const resumeId = resumeFlag ? (input.at(0) || undefined) : undefined;

  bootstrap({
    configPath,
    wayangRootDir: wayangRoot,
    workspaceDir,
    logLevel: flags.verbose ? 'debug' : 'info',
    new: flags.new,
    resume: resumeFlag ? (resumeId ?? '') : undefined,
    showAll: flags.all,
  }).catch(fatal);
}
