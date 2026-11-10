/**
 * Worker tool permission rules: reduce a tool call to an access verdict.
 *
 * The path boundary itself is NOT defined here — it is delegated to the shared
 * access policy (`@/infra/permission/policy`), which owns:
 *
 *   1. the sensitive list (highest priority, not overridable by any allow):
 *      a read AND a write both ask for approval; `sensitiveMode: 'deny'`
 *      refuses both without asking instead,
 *   2. user-config `allowedDirs` / `autoAllowRoots` / `sensitiveDirs`
 *      (plus the deprecated `deniedDirs` alias, merged into the same list),
 *   3. the task's own `allowedDirs`,
 *   4. the task workspace,
 *   5. "reads inside home are fine, writes are not" — DELIBERATELY NARROWED
 *      here (see `evaluateFileAccess` and `narrowHomeRead`): a worker is
 *      auto-allowed only inside its workspace / task allowedDirs / configured
 *      roots. Reading the rest of the user's home still asks, because the
 *      sensitive list covers credentials and tool config, not `.env` files,
 *      keys or other projects' sources.
 *
 * This module only adds what is tool-specific:
 *
 *   - which access mode a tool implies (read / write / unknown),
 *   - how a bash command string is reduced to path candidates (expanding
 *     `$HOME` / `${HOME}` first) and whether each candidate sits in a
 *     read-only, write-capable or unclassifiable command segment (see
 *     the command table's `read` capability and `segmentAccess`),
 *   - the destructive-command heuristic, which stays an "ask the controller"
 *     tier on top of the policy (the policy only judges paths) and is read at
 *     the SAME command position the path rules use (wrapper prefixes stripped),
 *     so `nohup rm -rf x` / `env FOO=1 rm -rf x` ask exactly like `rm -rf x`,
 *   - a shell `-c` script (`bash -c`, `sh -lc`, `--command`), which is judged
 *     recursively by these same rules instead of being seen as a bare `bash`,
 *   - escalation to `ask` when a target cannot be determined statically:
 *     `~user` (another user's home), command substitution, output redirection,
 *     and a read-only-table command that FAILED its own deferred condition
 *     (`sed -f`, a script that executes or writes — `read-only-unverified`).
 *
 * Verdicts: `allow` → run immediately, `ask` → controller approval,
 * `deny` → refuse without asking (`sensitiveMode: 'deny'` on a sensitive hit).
 *
 * The implementation lives in the `./permission-rules/` modules; this file is
 * the stable import surface (`@/services/tools/permission-rules`).
 */
export { FILE_TOOL_NAMES, evaluateFileAccess } from './permission-rules/file-access';
export { expandHome, processHomeDir } from './permission-rules/home-expansion';
export type { HomeExpansion } from './permission-rules/home-expansion';
export { evaluateBashAccess } from './permission-rules/bash-access';
export { decideToolAccess, denyMessage } from './permission-rules/tool-access';
export type {
  ToolAccessDecision,
  WorkerAccessScope,
  WorkerMatchedRule,
} from './permission-rules/types';
