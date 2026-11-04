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
import {
  CMDSUBST_PLACEHOLDER,
  classifyRedirections,
  isDiscardRedirectTarget,
  tokenizeShellLite,
  type ShellSegment,
  type ShellSubstitution,
} from '@/services/tools/shell-lexer';
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
 * Commands a command substitution may contain without the substitution itself
 * becoming approval-worthy: `$(command -v waya)`, `$(cat notes.txt)`,
 * `$(readlink -f x)`. This is NOT the read-only command classifier (that is a
 * later change): it is a narrow list for substitution interiors only, and every
 * inner command still goes through the normal path sweep — so
 * `$(cat /etc/passwd)` still asks, for the target rather than for the `$(`.
 *
 * Not listed means `ask`: an inner `rm`, `sed`, `find`, `xargs` or anything
 * else the gate has not been taught to read stays behind an approval.
 */
const CMDSUBST_READONLY_VERBS: ReadonlySet<string> = new Set([
  'cat', 'ls', 'grep', 'head', 'tail', 'wc', 'stat', 'file', 'which', 'command',
  'readlink', 'echo', 'printf', 'date', 'pwd',
]);

/**
 * How deep command substitutions are followed before giving up. A command
 * nested deeper than this asks: past a few levels the intent is more likely
 * generated code than a diagnostic one-liner.
 */
const MAX_CMDSUBST_DEPTH = 5;

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

/**
 * Does this segment certainly write — a write verb, a write flag, or an output
 * redirection into a real file? Read from the lexer's tokens, so a discard
 * (`> /dev/null`) and an fd copy (`2>&1`) are not mistaken for a file write,
 * and a `>` inside quotes is not mistaken for a redirection.
 */
function isWriteSegment(segment: ShellSegment): boolean {
  const words: string[] = [];
  for (const token of segment.tokens) {
    if (token.kind === 'word') {
      words.push(token.word.text);
      continue;
    }
    const { redirect } = token;
    if (redirect.kind !== 'output') continue;
    if (isDiscardRedirectTarget(redirect.target?.text)) continue;
    return true;
  }
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
  /** Present for redirection targets — surfaced on `ask` so the reason is clear. */
  reason?: string;
}

/**
 * Split one unquoted shell word into path candidates. A word only yields a
 * candidate when a piece of it STARTS with `/` or `~`: `src/cli.ts` must not be
 * mistaken for the absolute path `/cli.ts`, and a URL (`https://…`) is not a
 * filesystem path. `--prefix=/usr/local` and `of=$HOME/x` do carry one, so the
 * word is split on `=` as before.
 */
function pathPieces(text: string, access: BashCandidate['access']): BashCandidate[] {
  const candidates: BashCandidate[] = [];
  for (const piece of text.split('=')) {
    if (!piece.startsWith('/') && !piece.startsWith('~')) continue;
    // The discard family is never a file to judge: `tee /dev/null` is not a
    // write outside the workspace.
    if (isDiscardRedirectTarget(piece)) continue;
    candidates.push({ path: piece, access });
  }
  return candidates;
}

/**
 * Extract path candidates from a lexed command line: absolute / `~` words plus
 * the targets of redirections into real files.
 *
 * Relative spellings are deliberately NOT extracted (historic behaviour: a
 * relative word is not a path candidate, so it never triggers a prompt). Bash
 * resolves those against the task workspace, which is also the tool's cwd.
 *
 * Candidates are collected segment by segment so each one carries the strongest
 * access its OWN segment can justify: a `cat` in one segment cannot downgrade
 * the `tee` next to it. A redirection target is always a write, whatever the
 * rest of the segment does.
 */
function extractPathCandidates(segments: ShellSegment[]): BashCandidate[] {
  const candidates: BashCandidate[] = [];
  for (const segment of segments) {
    const segmentAccess: BashCandidate['access'] = isWriteSegment(segment) ? 'write' : 'unknown';
    for (const token of segment.tokens) {
      if (token.kind === 'word') {
        candidates.push(...pathPieces(token.word.text, segmentAccess));
        continue;
      }
      const { redirect } = token;
      if (redirect.kind === 'fd-dup' || redirect.kind === 'here-doc' || redirect.kind === 'here-string') continue;
      const target = redirect.target?.text;
      if (target === undefined || isDiscardRedirectTarget(target)) continue;
      // A substitution target is judged through evaluateSubstitutions instead.
      if (target.includes(CMDSUBST_PLACEHOLDER)) continue;
      const access: BashCandidate['access'] = redirect.kind === 'output' ? 'write' : segmentAccess;
      for (const candidate of pathPieces(target, access)) {
        candidates.push(
          redirect.kind === 'output'
            ? { ...candidate, reason: `output redirection to "${target}"` }
            : candidate,
        );
      }
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

/** Every command substitution in a lexed command line, in source order. */
function collectSubstitutions(segments: ShellSegment[]): ShellSubstitution[] {
  const substitutions: ShellSubstitution[] = [];
  for (const segment of segments) {
    for (const token of segment.tokens) {
      const word = token.kind === 'word' ? token.word : token.redirect.target;
      if (word) substitutions.push(...word.substitutions);
    }
  }
  return substitutions;
}

/**
 * Is a substituted command read-only, so that the substitution itself needs no
 * approval? Every command in it must be on `CMDSUBST_READONLY_VERBS` and must
 * not write (write verb, write flag such as `sed -i` / `find -delete`, or a
 * redirection into a real file). Nested substitutions are judged again by the
 * caller's recursion, so `$(echo $(date))` stays exempt while
 * `$(echo $(rm -rf /))` does not.
 */
function checkSubstitutionInner(inner: string): { ok: true } | { ok: false; reason: string } {
  const tokenized = tokenizeShellLite(inner);
  if (!tokenized.ok) return { ok: false, reason: `cannot parse it (${tokenized.error})` };
  if (tokenized.segments.length === 0) return { ok: false, reason: 'it is empty' };
  for (const segment of tokenized.segments) {
    const verb = segment.tokens.find((token) => token.kind === 'word');
    if (!verb || verb.kind !== 'word' || verb.word.text === CMDSUBST_PLACEHOLDER) {
      return { ok: false, reason: 'it has no command word to judge' };
    }
    if (!CMDSUBST_READONLY_VERBS.has(verb.word.text)) {
      return { ok: false, reason: `\`${verb.word.text}\` is not a read-only command` };
    }
    if (isWriteSegment(segment)) return { ok: false, reason: `\`${verb.word.text}\` writes` };
  }
  return { ok: true };
}

/**
 * Decide the command substitutions of one command line.
 *
 * A substitution is exempt when its inner command is read-only (see
 * `checkSubstitutionInner`) AND that inner command passes the ordinary bash
 * rules — so `$(command -v waya)` and `$(cat notes.txt)` run, while
 * `$(cat /etc/passwd)` asks for the path and `$(rm -rf /)` asks for the command.
 * Everything else asks: an inner command outside the read-only list, an empty
 * or unparsable inner command, or nesting deeper than `MAX_CMDSUBST_DEPTH`.
 *
 * Returns `undefined` when the whole command line may continue to be judged.
 */
function evaluateSubstitutions(
  scope: WorkerAccessScope,
  segments: ShellSegment[],
  depth: number,
): ToolAccessDecision | undefined {
  const substitutions = collectSubstitutions(segments);
  if (substitutions.length === 0) return undefined;
  if (depth + 1 > MAX_CMDSUBST_DEPTH) {
    return {
      decision: 'ask',
      matchedRule: 'dynamic-shell',
      reason: `command substitution nested deeper than ${MAX_CMDSUBST_DEPTH} levels`,
    };
  }

  for (const substitution of substitutions) {
    const inner = substitution.inner.trim();
    if (inner.length === 0) {
      return { decision: 'ask', matchedRule: 'dynamic-shell', reason: `empty command substitution ${substitution.raw}` };
    }
    const readOnly = checkSubstitutionInner(inner);
    if (!readOnly.ok) {
      return {
        decision: 'ask',
        matchedRule: 'dynamic-shell',
        reason: `command substitution ${substitution.raw}: ${readOnly.reason}`,
      };
    }
    const verdict = evaluateBashCommand(scope, inner, depth + 1);
    // A sensitive WRITE inside the substitution refuses the whole command.
    if (verdict.decision === 'deny') return verdict;
    if (verdict.decision === 'ask') {
      const detail = verdict.reason ?? (verdict.resolvedPath ? `target ${verdict.resolvedPath}` : verdict.matchedRule);
      return {
        decision: 'ask',
        matchedRule: 'dynamic-shell',
        reason: `command substitution ${substitution.raw} needs approval: ${detail}`,
        // Carry the inner hit through, so an approval request still names the
        // path (and the sensitive entry) the substituted command would touch.
        ...(verdict.resolvedPath !== undefined && { resolvedPath: verdict.resolvedPath }),
        ...(verdict.matchedEntry !== undefined && {
          matchedEntry: verdict.matchedEntry,
          matchedSource: verdict.matchedSource,
          sensitive: true,
        }),
      };
    }
  }
  return undefined;
}

/**
 * Deny-only sweep for a command the lexer rejected.
 *
 * It can only TIGHTEN a verdict, never loosen one: it splits on the coarse
 * delimiters the old extractor used, treats every absolute / `~` word as a
 * WRITE and returns only when the policy refuses one of them. That keeps the
 * "a sensitive path is never writable" invariant when a command is
 * syntactically broken (`tee ~/.ssh/authorized_keys "x`) instead of degrading
 * to an approvable ask.
 */
function fallbackSensitiveWrite(
  scope: WorkerAccessScope,
  expandedCommand: string,
): ToolAccessDecision | undefined {
  for (const raw of expandedCommand.split(/[\s=]+/)) {
    const word = raw.replace(/^['"]+/, '').replace(/['"]+$/, '');
    if (!word.startsWith('/') && !word.startsWith('~')) continue;
    const expanded = expandHome(word, scope.homeDir);
    if (expanded.unresolvable) continue;
    const verdict = decidePath(scope, expanded.path, 'write');
    if (verdict.decision === 'deny') return toToolDecision(verdict, 'write');
  }
  return undefined;
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
 * sweep) → destructive-command tier → dynamic constructs (a command substitution
 * that is not read-only, an output redirection into a real file, a command the
 * lexer cannot parse) → remaining `ask` candidates → allow. A hard deny
 * therefore outranks the destructive-command heuristic.
 *
 * Fallback when the command yields NO path candidate (`ls -la`, `npm test`,
 * `sed -n 1,10p src/cli.ts`): there is nothing for the policy to judge, so the
 * historic rule applies — a dangerous command still asks, anything else runs.
 * Relative spellings are never candidates, so the sensitive list cannot see
 * them; they are confined by the task workspace (the shell's cwd), as before.
 *
 * Discard redirections (`> /dev/null`, `2>&1`) and read-only command
 * substitutions are exempt from the dynamic tier — see `evaluateSubstitutions`
 * and `classifyRedirections`.
 */
export function evaluateBashAccess(scope: WorkerAccessScope, command: string): ToolAccessDecision {
  return evaluateBashCommand(scope, command, 0);
}

/**
 * The recursive body of `evaluateBashAccess`. `depth` counts how many command
 * substitutions deep this command sits: the outer command is 0, so
 * `$(cat $(echo x))` reaches 2 and a sixth nested `$(` asks instead of being
 * followed any further.
 */
function evaluateBashCommand(
  scope: WorkerAccessScope,
  command: string,
  depth: number,
): ToolAccessDecision {
  // `$HOME` / `${HOME}` are expanded BEFORE lexing so the concrete path the
  // shell would open is what gets judged (and the sensitive list can see it).
  const expandedCommand = expandHomeVars(command, scope.homeDir);

  const tokenized = tokenizeShellLite(expandedCommand);
  if (!tokenized.ok) {
    // A command the lexer cannot finish is never a silent allow. A sensitive
    // WRITE still refuses outright: the deny invariant outranks parseability.
    const refusal = fallbackSensitiveWrite(scope, expandedCommand);
    if (refusal) return refusal;
    return {
      decision: 'ask',
      matchedRule: 'dynamic-shell',
      reason: `could not parse the shell command (${tokenized.error})`,
    };
  }

  const segments = tokenized.segments;
  const redirections = classifyRedirections(segments);

  const candidates: BashCandidate[] = [];
  let hasUnresolvableHome = false;
  for (const candidate of extractPathCandidates(segments)) {
    const expanded = expandHome(candidate.path, scope.homeDir);
    if (expanded.unresolvable) {
      hasUnresolvableHome = true;
      continue;
    }
    candidates.push({ ...candidate, path: expanded.path });
  }

  let firstAsk: ToolAccessDecision | undefined;
  let firstAllow: ToolAccessDecision | undefined;
  for (const candidate of candidates) {
    const verdict = decidePath(scope, candidate.path, candidate.access);
    if (verdict.decision === 'deny') return toToolDecision(verdict, candidate.access);
    if (verdict.decision === 'ask') {
      firstAsk ??= {
        ...toToolDecision(verdict, candidate.access),
        ...(candidate.reason !== undefined && { reason: candidate.reason }),
      };
    } else firstAllow ??= toToolDecision(verdict, candidate.access);
  }

  // A hard deny (above) outranks everything. Then the destructive tier.
  if (DANGEROUS_BASH_PATTERN.test(expandedCommand)) {
    return { decision: 'ask', matchedRule: 'dangerous-bash' };
  }

  // Command substitution: the inner command is judged by the same rules
  // (recursively), so `$(cat /etc/passwd)` asks for the path and
  // `$(command -v waya)` does not ask at all.
  const substitution = evaluateSubstitutions(scope, segments, depth);
  if (substitution) return substitution;

  // A redirection whose target cannot be resolved statically asks.
  if (redirections.unresolved !== undefined) {
    return {
      decision: 'ask',
      matchedRule: 'dynamic-shell',
      reason: `output redirection target cannot be determined statically (${redirections.unresolved})`,
    };
  }

  // A redirection into a real file: the policy may well allow the target
  // (inside the workspace), but a redirected write is never silent.
  if (redirections.writeTargets.length > 0 && !firstAsk) {
    return {
      decision: 'ask',
      matchedRule: 'dynamic-shell',
      reason: `output redirection writes a file ("${redirections.writeTargets.join('", "')}")`,
    };
  }

  // Another user's home cannot be resolved — ask, never a silent allow. The
  // reason is surfaced in the approval request so the controller knows WHY.
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
