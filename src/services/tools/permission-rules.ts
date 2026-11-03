/**
 * Worker tool permission rules: reduce a tool call to an access verdict.
 *
 * The path boundary itself is NOT defined here — it is delegated to the shared
 * access policy (`@/infra/permission/policy`), which owns:
 *
 *   1. the built-in denylist (highest priority, not overridable by any allow),
 *   2. user-config `allowedDirs` / `autoAllowRoots` / `deniedDirs`,
 *   3. the task's own `allowedDirs`,
 *   4. the task workspace,
 *   5. "reads inside home are fine, writes are not" — DELIBERATELY NARROWED
 *      here (see `evaluateFileAccess`): a worker is auto-allowed only inside
 *      its workspace / task allowedDirs / configured roots. Reading the rest
 *      of the user's home still asks, because the denylist covers credentials
 *      and tool config, not `.env` files, keys or other projects' sources.
 *
 * This module only adds what is tool-specific:
 *
 *   - which access mode a tool implies (read vs write),
 *   - how a bash command string is reduced to path candidates,
 *   - the destructive-command heuristic, which stays a "ask the controller"
 *     tier on top of the policy (the policy only judges paths).
 *
 * Verdicts: `allow` → run immediately, `ask` → controller approval,
 * `deny` → refuse without asking (denylist hit).
 */
import { resolve } from 'node:path';
import { decideAccess, type AccessDecision, type AccessMode, type MatchedRule } from '@/infra/permission/policy';
import type { PermissionConfig } from '@/types/config';

/** File tools gated by the permission middleware for path access. */
export const FILE_TOOL_NAMES = ['read_file', 'write_file', 'edit_file', 'search_files', 'search_content'] as const;

/** File tools that only read. Every other file tool counts as a write. */
const READ_ONLY_FILE_TOOLS: ReadonlySet<string> = new Set(['read_file', 'search_files', 'search_content']);

/**
 * Bash commands matching these patterns always require controller approval.
 * Matches at command start or after shell operators (|, ;, &&) to reduce
 * false positives from quoted strings.
 */
const DANGEROUS_BASH_PATTERN = /(?:^|\||;|&&)\s*(?:rm\s|sudo\b|chmod\b|chown\b|mkfs\b|dd\s|shutdown\b|reboot\b|kill\s+-9)/;

/** URLs (scheme://...) — their path components are not local filesystem paths. */
const URL_RE = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S+/g;

/**
 * Matched rules beyond the policy's own set: the destructive-command tier and
 * the "nothing to judge" case live in this module, not in the policy.
 */
export type WorkerMatchedRule = MatchedRule | 'dangerous-bash' | 'no-path';

/** Everything the shared policy needs to know about ONE worker run's boundary. */
export interface WorkerAccessScope {
  /**
   * The user's home directory — the denylist anchor and the read scope.
   * Injected by the engine (never read globally here).
   */
  homeDir: string;
  /** The task's workspace: the tool cwd and this run's writable boundary. */
  workspace: string;
  /** Extra directories granted to this one task (`task.taskAllowedDirs`). */
  taskAllowedDirs?: string[];
  /** User-config permission section (`config.permission`). */
  permission?: PermissionConfig;
}

export interface ToolAccessDecision {
  decision: AccessDecision;
  matchedRule: WorkerMatchedRule;
  /**
   * Present on `deny`. The message handed back to the worker — it names the
   * path the WORKER supplied and nothing else (no denylist entry, no canonical
   * symlink target), so a refusal discloses nothing the worker didn't know.
   */
  message?: string;
}

/** Expand a leading `~` / `~/` against the given home directory. */
function expandHome(p: string, homeDir: string): string {
  if (p === '~') return homeDir;
  if (p.startsWith('~/')) return resolve(homeDir, p.slice(2));
  return p;
}

/**
 * Extract path candidates from a shell command: whole shell words that START
 * with `/` or `~` (after stripping quotes and operator fragments). Only whole
 * words count — `src/cli.ts` must not be mistaken for the absolute path
 * `/cli.ts`, and URLs are stripped beforehand.
 *
 * Relative spellings are deliberately NOT extracted (historic behaviour: a
 * relative word is not a path candidate, so it never triggers a prompt). Bash
 * resolves those against the task workspace, which is also the tool's cwd.
 */
function extractPathCandidates(command: string): string[] {
  const withoutUrls = command.replace(URL_RE, ' ');
  const candidates: string[] = [];
  for (const raw of withoutUrls.split(/[\s=;|&]+/)) {
    const word = raw.replace(/^['"]+/, '').replace(/['",;|&()<>'`]+$/, '');
    if (word.startsWith('/') || word.startsWith('~')) candidates.push(word);
  }
  return candidates;
}

/** Run one path past the shared policy with this run's boundary as context. */
function decidePath(
  scope: WorkerAccessScope,
  path: string,
  access: AccessMode,
): { decision: AccessDecision; matchedRule: MatchedRule } {
  return decideAccess({
    path,
    access,
    cwd: scope.workspace,
    homeDir: scope.homeDir,
    taskWorkspace: scope.workspace,
    taskAllowedDirs: scope.taskAllowedDirs,
    configAllowedDirs: scope.permission?.allowedDirs,
    autoAllowRoots: scope.permission?.autoAllowRoots,
    extraDeniedDirs: scope.permission?.deniedDirs,
  });
}

/**
 * Decide a file tool call. `read_file` / `search_files` / `search_content` are
 * reads; `write_file` / `edit_file` are writes. A call without a usable `path`
 * has nothing to judge and is allowed (the tool then uses its own cwd).
 *
 * NARROWER THAN THE POLICY ON PURPOSE: `read-within-home` is downgraded to
 * `ask`. The controller may read anywhere under home (its own read scope, 4b),
 * but a WORKER's silence-worthy scope is its workspace, its task allowedDirs
 * and the explicitly configured roots. The denylist only covers credentials
 * and tool config — `.env` files, SSH keys inside a project, other projects'
 * sources are all "inside home" and must not be readable without an approval.
 */
export function evaluateFileAccess(
  scope: WorkerAccessScope,
  toolName: string,
  args: Record<string, unknown>,
): ToolAccessDecision {
  const rawPath = args.path;
  if (typeof rawPath !== 'string' || !rawPath) return { decision: 'allow', matchedRule: 'no-path' };

  const access: AccessMode = READ_ONLY_FILE_TOOLS.has(toolName) ? 'read' : 'write';
  const verdict = decidePath(scope, expandHome(rawPath, scope.homeDir), access);
  if (verdict.matchedRule === 'read-within-home') return { decision: 'ask', matchedRule: 'read-within-home' };
  return verdict;
}

/**
 * Decide a bash command.
 *
 * The command string is the unit of execution, so every extractable path
 * candidate is judged separately and ANY denied candidate refuses the whole
 * command — a benign `cat` in the same command line cannot launder a denied
 * `rm`. Bash cannot tell reads from writes, so candidates are judged as writes
 * (the strict mode: "inside home" alone never justifies a write).
 *
 * Ordering: denylist (from the candidate sweep) → destructive-command tier →
 * remaining `ask` candidates → allow. A denylist hit therefore outranks the
 * destructive-command heuristic.
 *
 * Fallback when the command yields NO path candidate (`ls -la`, `npm test`,
 * `sed -n 1,10p src/cli.ts`): there is nothing for the policy to judge, so the
 * historic rule applies — a dangerous command still asks, anything else runs.
 * Relative spellings are never candidates, so the denylist cannot see them;
 * they are confined by the task workspace (the shell's cwd), exactly as before.
 */
export function evaluateBashAccess(scope: WorkerAccessScope, command: string): ToolAccessDecision {
  const candidates = extractPathCandidates(command).map((p) => expandHome(p, scope.homeDir));

  let firstAsk: ToolAccessDecision | undefined;
  let firstAllow: ToolAccessDecision | undefined;
  for (const candidate of candidates) {
    const verdict = decidePath(scope, candidate, 'write');
    if (verdict.decision === 'deny') return verdict;
    if (verdict.decision === 'ask') firstAsk ??= verdict;
    else firstAllow ??= verdict;
  }

  if (DANGEROUS_BASH_PATTERN.test(command)) return { decision: 'ask', matchedRule: 'dangerous-bash' };
  if (firstAsk) return firstAsk;
  return firstAllow ?? { decision: 'allow', matchedRule: 'no-path' };
}

/**
 * Denial message for a denylisted access. Names the tool and, when the worker
 * supplied one, the path IT asked for — never which denylist entry matched.
 */
export function denyMessage(toolName: string, requestedPath?: string): string {
  if (toolName === 'bash') {
    return '[ERROR] bash: refusing to run this command — it touches a path on the deny list (a sensitive location).';
  }
  const target = requestedPath ? ` "${requestedPath}"` : '';
  return `[ERROR] ${toolName}: refusing access to${target} — the path is on the deny list (a sensitive location).`;
}

/**
 * Decide any gated tool call. Unknown tool names are allowed: the middleware
 * only calls this for tools it gates, and a non-path tool has nothing to judge.
 */
export function decideToolAccess(
  scope: WorkerAccessScope,
  toolName: string,
  args: Record<string, unknown>,
): ToolAccessDecision {
  let verdict: ToolAccessDecision;
  if (toolName === 'bash') {
    verdict = evaluateBashAccess(scope, typeof args.command === 'string' ? args.command : '');
  } else if ((FILE_TOOL_NAMES as readonly string[]).includes(toolName)) {
    verdict = evaluateFileAccess(scope, toolName, args);
  } else {
    return { decision: 'allow', matchedRule: 'no-path' };
  }

  if (verdict.decision !== 'deny') return verdict;
  return { ...verdict, message: denyMessage(toolName, typeof args.path === 'string' ? args.path : undefined) };
}
