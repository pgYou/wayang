/**
 * Worker tool permission rules: reduce a tool call to an access verdict.
 *
 * The path boundary itself is NOT defined here — it is delegated to the shared
 * access policy (`@/infra/permission/policy`), which owns:
 *
 *   1. the sensitive list (highest priority, not overridable by any allow):
 *      reads ask for approval, writes are refused,
 *   2. user-config `allowedDirs` / `autoAllowRoots` / `sensitiveDirs`
 *      (plus the deprecated `deniedDirs` alias, merged into the same list),
 *   3. the task's own `allowedDirs`,
 *   4. the task workspace,
 *   5. "reads inside home are fine, writes are not" — DELIBERATELY NARROWED
 *      here (see `evaluateFileAccess`): a worker is auto-allowed only inside
 *      its workspace / task allowedDirs / configured roots. Reading the rest
 *      of the user's home still asks, because the sensitive list covers
 *      credentials and tool config, not `.env` files, keys or other projects'
 *      sources.
 *
 * This module only adds what is tool-specific:
 *
 *   - which access mode a tool implies (read / write / unknown),
 *   - how a bash command string is reduced to path candidates (expanding
 *     `$HOME` / `${HOME}` first) and whether each candidate sits in a
 *     write-capable segment of the command line,
 *   - the destructive-command heuristic, which stays a "ask the controller"
 *     tier on top of the policy (the policy only judges paths),
 *   - escalation to `ask` when a target cannot be determined statically:
 *     `~user` (another user's home), command substitution, output redirection.
 *
 * Verdicts: `allow` → run immediately, `ask` → controller approval,
 * `deny` → refuse without asking (sensitive write, or `sensitiveMode: 'deny'`).
 */
import { resolve } from 'node:path';
import {
  decideAccess,
  type AccessDecision,
  type AccessMode,
  type DecideAccessResult,
  type MatchedRule,
  type SensitiveMatchSource,
} from '@/infra/permission/policy';
import { mergeSensitiveDirs, resolveSensitiveMode } from '@/infra/permission/permission-config';
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
export type WorkerMatchedRule =
  | MatchedRule
  | 'dangerous-bash'
  | 'no-path'
  | 'home-other-user'
  | 'dynamic-shell';

/** Everything the shared policy needs to know about ONE worker run's boundary. */
export interface WorkerAccessScope {
  /**
   * The user's home directory — the sensitive-list anchor and the read scope.
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
   * path the WORKER supplied and nothing else (no sensitive-list entry, no
   * canonical symlink target), so a refusal discloses nothing the worker
   * didn't already know.
   */
  message?: string;
  /**
   * Present on `ask` when the reason is not obvious from the call itself — e.g.
   * a command substitution or output redirection whose target cannot be
   * determined statically. Surfaces in the approval request so the controller
   * understands WHY it is being asked.
   */
  reason?: string;
  /**
   * The sensitive-list entry that matched (`.ssh`, `.docker/config.json`, a
   * configured dir). Present on a sensitive hit — in an approval request and
   * in the audit trail it explains the verdict; in a refusal message it is
   * deliberately omitted.
   */
  matchedEntry?: string;
  /** Which sensitive rule produced the hit (`segment`, `config-dir`, …). */
  matchedSource?: SensitiveMatchSource;
  /** True exactly when the verdict came from the sensitive list. */
  sensitive?: boolean;
  /** Canonical (realpath-normalized) target the verdict was made about. */
  resolvedPath?: string;
  /** How the target was judged: read / write / unknown (bash semantics). */
  access?: AccessMode;
}

/**
 * Result of expanding a leading `~` in a shell word.
 *
 * `~` and `~/...` expand against the injected home directory. `~<name>` (tilde
 * followed by anything other than `/` or end-of-word) names ANOTHER user's
 * home. We deliberately do NOT resolve it — that would mean reading /etc/passwd
 * or guessing the layout — so it is reported as unresolvable and the caller
 * forces an approval. Treating it as a relative path would be wrong: a shell
 * reads `cat ~root/.ssh/x` as `/root/.ssh/x`, not as workspace-relative.
 */
interface HomeExpansion {
  /** Path after `~` / `~/` expansion; unchanged for `~<name>`. */
  path: string;
  /** True for `~<name>` — another user's home, which cannot be resolved safely. */
  unresolvable: boolean;
}

/** Expand a leading `~` / `~/` against `homeDir`; flag `~<name>` as unresolvable. */
function expandHome(p: string, homeDir: string): HomeExpansion {
  if (p === '~') return { path: homeDir, unresolvable: false };
  if (p.startsWith('~/')) return { path: resolve(homeDir, p.slice(2)), unresolvable: false };
  if (p.startsWith('~')) return { path: p, unresolvable: true };
  return { path: p, unresolvable: false };
}

/**
 * Replace `$HOME` / `${HOME}` with the injected home directory BEFORE path
 * candidate extraction, so `cat $HOME/.ssh/id_rsa` is judged against the same
 * concrete path a shell would open (and the sensitive list can see it). Only
 * these two spellings are rewritten: positional/special parameters (`$1`, `$@`,
 * …) and every other variable are left untouched, so common `awk '{print $1}'`
 * commands never trip the gates.
 */
function expandHomeVars(command: string, homeDir: string): string {
  // `${HOME}` first, then a bare `$HOME` not followed by an identifier char
  // (so `$HOMEDIR` is not partially rewritten).
  return command.replace(/\$\{HOME\}/g, homeDir).replace(/\$HOME(?![A-Za-z0-9_])/g, homeDir);
}

/**
 * Shell constructs whose real target cannot be determined statically: command
 * substitution (backticks / `$(`) and output redirection (`>` / `>>`) to a
 * file. A command containing any of them is escalated to `ask` so the
 * controller can inspect it instead of the gate silently allowing a target it
 * never saw. Ordinary parameters such as `$1` / `${1}` are NOT command
 * substitution and do not trigger this.
 */
function detectUnsafeDynamicTarget(command: string): string | undefined {
  if (command.includes('`')) return 'command substitution (backticks)';
  if (/\$\(/.test(command)) return 'command substitution ($(...))';
  if (hasOutputRedirection(command)) return 'output redirection';
  return undefined;
}

/**
 * Detect a `>` / `>>` writing to a file. File-descriptor duplication
 * (`2>&1`, `>&2`) targets another fd, not a path, and is ignored.
 */
function hasOutputRedirection(command: string): boolean {
  // `>` / `>>` not immediately followed by `&` (fd duplication), with an actual
  // target word after optional spaces.
  return /(?:^|[^<>])>>?\s*(?!&)\S/.test(command);
}

/**
 * Commands that write to the paths they name. A candidate in the same command
 * segment as one of these is judged as a WRITE (so a sensitive target is
 * refused outright, never offered for approval).
 *
 * Deliberately narrow: this is NOT the read-only classifier (that is a later
 * change) — it only separates "this segment certainly writes" from "we cannot
 * tell", so `rm ~/.ssh/x` is a hard deny while `cat ~/.ssh/x` may ask. A
 * command missing from this table loses no safety: it is judged `unknown`,
 * which the policy treats as a write for scope purposes.
 */
const BASH_WRITE_VERBS: ReadonlySet<string> = new Set([
  'rm', 'rmdir', 'mv', 'cp', 'ln', 'tee', 'dd', 'truncate', 'install',
  'mkdir', 'touch', 'chmod', 'chown', 'chgrp', 'shred', 'unlink', 'chattr',
  'mkfs', 'mkswap', 'mount', 'umount',
]);

/**
 * Verbs that write only with a specific flag (`sed -i`, `find -delete`, …).
 * Both the verb and one of its flags must appear in the same segment.
 */
const BASH_FLAGGED_WRITE_VERBS: ReadonlyMap<string, readonly string[]> = new Map([
  ['sed', ['-i', '--in-place']],
  ['perl', ['-i']],
  ['ruby', ['-i']],
  ['find', ['-delete', '-fprint', '-fls', '-fprintf', '-exec', '-execdir', '-ok']],
]);

/** Command-segment separator: shell operators and newlines. */
const BASH_SEGMENT_RE = /[\n;|&]+/;

/** `>` / `>>` with a real target (not fd duplication such as `2>&1`). */
const OUTPUT_REDIRECTION_RE = /(?:^|[^<>])>>?(?!&)/;

/** Strip the quote/operator punctuation that clings to a shell word. */
function cleanShellWord(raw: string): string {
  return raw.replace(/^['"]+/, '').replace(/['",;|&()<>'`]+$/, '');
}

/** Does this command segment certainly write (write verb, flag or redirection)? */
function isWriteSegment(segment: string): boolean {
  if (OUTPUT_REDIRECTION_RE.test(segment)) return true;
  const words = segment.split(/\s+/).map(cleanShellWord).filter((w) => w.length > 0);
  for (const word of words) {
    if (BASH_WRITE_VERBS.has(word)) return true;
    const flags = BASH_FLAGGED_WRITE_VERBS.get(word);
    if (flags && flags.some((flag) => words.includes(flag))) return true;
  }
  return false;
}

/** A path candidate plus how the policy should judge it. */
interface BashCandidate {
  path: string;
  /** `write` when the candidate sits in a write-capable segment, else `unknown`. */
  access: 'write' | 'unknown';
}

/**
 * Extract path candidates from a shell command: whole shell words that START
 * with `/` or `~` (after stripping quotes and operator fragments). Only whole
 * words count — `src/cli.ts` must not be mistaken for the absolute path
 * `/cli.ts` — and URLs are stripped beforehand.
 *
 * Relative spellings are deliberately NOT extracted (historic behaviour: a
 * relative word is not a path candidate, so it never triggers a prompt). Bash
 * resolves those against the task workspace, which is also the tool's cwd.
 *
 * Candidates are collected segment by segment (split on shell operators) so
 * each one carries the strongest access its OWN segment can justify: a `cat`
 * in one segment cannot downgrade the `tee` next to it.
 */
function extractPathCandidates(command: string): BashCandidate[] {
  const withoutUrls = command.replace(URL_RE, ' ');
  const candidates: BashCandidate[] = [];
  for (const segment of withoutUrls.split(BASH_SEGMENT_RE)) {
    const access: BashCandidate['access'] = isWriteSegment(segment) ? 'write' : 'unknown';
    for (const raw of segment.split(/[\s=]+/)) {
      const word = cleanShellWord(raw);
      if (word.startsWith('/') || word.startsWith('~')) candidates.push({ path: word, access });
    }
  }
  return candidates;
}

/** Run one path past the shared policy with this run's boundary as context. */
function decidePath(
  scope: WorkerAccessScope,
  path: string,
  access: AccessMode,
): DecideAccessResult {
  const permission = scope.permission;
  return decideAccess({
    path,
    access,
    cwd: scope.workspace,
    homeDir: scope.homeDir,
    taskWorkspace: scope.workspace,
    taskAllowedDirs: scope.taskAllowedDirs,
    configAllowedDirs: permission?.allowedDirs,
    autoAllowRoots: permission?.autoAllowRoots,
    // `sensitiveDirs` is the current key; `deniedDirs` is its deprecated alias
    // and is merged (deduped) here so a legacy config keeps protecting exactly
    // the directories it declares.
    extraSensitiveDirs: mergeSensitiveDirs(permission),
    sensitiveMode: resolveSensitiveMode(permission),
  });
}

/**
 * Map a policy verdict onto a tool verdict, carrying the explainability fields
 * (matched entry / source / canonical path / judged access) along so approval
 * requests and the audit trail can name the hit.
 */
function toToolDecision(verdict: DecideAccessResult, access: AccessMode): ToolAccessDecision {
  return {
    decision: verdict.decision,
    matchedRule: verdict.matchedRule,
    resolvedPath: verdict.resolvedPath,
    access,
    ...(verdict.matchedEntry !== undefined && {
      matchedEntry: verdict.matchedEntry,
      matchedSource: verdict.matchedSource,
      sensitive: true,
    }),
  };
}

/**
 * Decide a file tool call. `read_file` / `search_files` / `search_content` are
 * reads; `write_file` / `edit_file` are writes. A call without a usable `path`
 * has nothing to judge and is allowed (the tool then uses its own cwd).
 *
 * NARROWER THAN THE POLICY ON PURPOSE: `read-within-home` is downgraded to
 * `ask`. The controller may read anywhere under home (its own read scope, 4b),
 * but a WORKER's silence-worthy scope is its workspace, its task allowedDirs
 * and the explicitly configured roots. The sensitive list only covers
 * credentials and tool config — `.env` files, SSH keys inside a project, other
 * projects' sources are all "inside home" and must not be readable without an
 * approval.
 */
export function evaluateFileAccess(
  scope: WorkerAccessScope,
  toolName: string,
  args: Record<string, unknown>,
): ToolAccessDecision {
  const rawPath = args.path;
  if (typeof rawPath !== 'string' || !rawPath) return { decision: 'allow', matchedRule: 'no-path' };

  const access: AccessMode = READ_ONLY_FILE_TOOLS.has(toolName) ? 'read' : 'write';
  const expanded = expandHome(rawPath, scope.homeDir);
  if (expanded.unresolvable) {
    // `~user`: another user's home. We do not guess it, so we cannot prove it
    // is inside any allowed scope — ask rather than silently allow.
    return {
      decision: 'ask',
      matchedRule: 'home-other-user',
      reason: "`~user` names another user's home directory, which cannot be resolved safely",
    };
  }

  const verdict = decidePath(scope, expanded.path, access);
  // Downgrade when — and only when — the allow rests SOLELY on the policy's
  // "read inside home" rule. Structured check (withinReadScope), not the
  // matchedRule string literal, so renaming the rule cannot widen access.
  if (verdict.decision === 'allow' && verdict.withinReadScope) {
    return { decision: 'ask', matchedRule: 'read-within-home', resolvedPath: verdict.resolvedPath, access };
  }
  return toToolDecision(verdict, access);
}

/**
 * Decide a bash command.
 *
 * The command string is the unit of execution, so every extractable path
 * candidate is judged separately and ANY denied candidate refuses the whole
 * command — a benign `cat` in the same command line cannot launder a denied
 * `rm`. A candidate that sits in a write-capable segment (write verb or
 * redirection) is judged as a WRITE; every other candidate is judged `unknown`
 * (the strict mode: "inside home" alone never justifies a write either).
 *
 * Ordering: sensitive write / `sensitiveMode: 'deny'` deny (from the candidate
 * sweep) → destructive-command tier → remaining `ask` candidates → allow.
 * A hard deny therefore outranks the destructive-command heuristic.
 *
 * Fallback when the command yields NO path candidate (`ls -la`, `npm test`,
 * `sed -n 1,10p src/cli.ts`): there is nothing for the policy to judge, so the
 * historic rule applies — a dangerous command still asks, anything else runs.
 * Relative spellings are never candidates, so the sensitive list cannot see
 * them; they are confined by the task workspace (the shell's cwd), as before.
 */
export function evaluateBashAccess(scope: WorkerAccessScope, command: string): ToolAccessDecision {
  // `$HOME` / `${HOME}` are expanded BEFORE extraction so the concrete path the
  // shell would open is what gets judged (and the sensitive list can see it).
  const expandedCommand = expandHomeVars(command, scope.homeDir);

  const candidates: BashCandidate[] = [];
  let hasUnresolvableHome = false;
  for (const candidate of extractPathCandidates(expandedCommand)) {
    const expanded = expandHome(candidate.path, scope.homeDir);
    if (expanded.unresolvable) {
      hasUnresolvableHome = true;
      continue;
    }
    candidates.push({ path: expanded.path, access: candidate.access });
  }

  let firstAsk: ToolAccessDecision | undefined;
  let firstAllow: ToolAccessDecision | undefined;
  for (const candidate of candidates) {
    const verdict = decidePath(scope, candidate.path, candidate.access);
    if (verdict.decision === 'deny') return toToolDecision(verdict, candidate.access);
    if (verdict.decision === 'ask') firstAsk ??= toToolDecision(verdict, candidate.access);
    else firstAllow ??= toToolDecision(verdict, candidate.access);
  }

  // A hard deny (above) outranks everything. Then the destructive tier.
  if (DANGEROUS_BASH_PATTERN.test(expandedCommand)) {
    return { decision: 'ask', matchedRule: 'dangerous-bash' };
  }

  // Targets that cannot be determined statically — and another user's home —
  // escalate to ask, never a silent allow. The reason is surfaced in the
  // approval request so the controller knows WHY.
  const dynamic = detectUnsafeDynamicTarget(expandedCommand);
  if (dynamic) return { decision: 'ask', matchedRule: 'dynamic-shell', reason: dynamic };
  if (hasUnresolvableHome) {
    return {
      decision: 'ask',
      matchedRule: 'home-other-user',
      reason: "`~user` names another user's home directory, which cannot be resolved safely",
    };
  }

  if (firstAsk) return firstAsk;
  return firstAllow ?? { decision: 'allow', matchedRule: 'no-path' };
}

/**
 * Denial message for a sensitive-list refusal. Names the tool and, when the
 * worker supplied one, the path IT asked for — never which sensitive entry
 * matched and never the canonical (possibly symlinked) target, so a refusal
 * discloses nothing the worker didn't already know.
 *
 * Write refusals get the "never writable" wording: they cannot be approved, so
 * the message states the boundary instead of inviting a retry.
 */
export function denyMessage(
  toolName: string,
  requestedPath?: string,
  matchedRule?: WorkerMatchedRule,
): string {
  const write = matchedRule === 'sensitive-list-write';
  if (toolName === 'bash') {
    return write
      ? '[ERROR] bash: refusing to run this command — it would write to a path on the sensitive list (sensitive paths are never writable).'
      : '[ERROR] bash: refusing to run this command — it touches a path on the sensitive list (a protected location).';
  }
  const target = requestedPath ? ` "${requestedPath}"` : '';
  return write
    ? `[ERROR] ${toolName}: refusing to write${target} — the path is on the sensitive list (sensitive paths are never writable).`
    : `[ERROR] ${toolName}: refusing access to${target} — the path is on the sensitive list (a protected location).`;
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
  return {
    ...verdict,
    message: denyMessage(toolName, typeof args.path === 'string' ? args.path : undefined, verdict.matchedRule),
  };
}
