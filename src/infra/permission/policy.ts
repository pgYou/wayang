/**
 * Pure access-decision policy: "may this access be allowed?"
 *
 * This module is deliberately side-effect free apart from read-only filesystem
 * lookups used for path canonicalization (`realpath`) — it does not read
 * config, does not consult session state, does not prompt, and does not cache.
 * Callers pass every relevant input in and get a decision back:
 *
 *   1. sensitive list      → ask for reads, deny for writes (wins over all)
 *      - anchor-independent "sensitive segment" rule (any `.ssh`/`.aws`/…),
 *      - home-anchored built-in entries + configurable sensitiveDirs.
 *   2. config allowedDirs  → allow
 *   3. config autoAllowRoots → allow
 *   4. task allowedDirs    → allow
 *   5. task workspace      → allow
 *   6. read inside home    → allow (read only; never sufficient for writes)
 *   7. nothing matched     → ask
 *
 * Read vs write: the home directory is readable (minus the sensitive list), but
 * it is NOT writable as a whole — writes are only allowed inside the task
 * workspace / task allowedDirs / explicitly configured dirs. "Inside home" must
 * never be enough to justify a write.
 *
 * Sensitive paths: READING one requires approval (`ask`) — the approval request
 * and the audit trail carry the matched entry and the canonical target, so the
 * decision is explainable, and the file content itself never leaks into them.
 * WRITING one is a hard `deny` with no approval round-trip: letting an agent
 * rewrite `authorized_keys` (or `~/.wayang.config.json`) is a persistence risk
 * with no legitimate task behind it. `sensitiveMode: 'deny'` restores the
 * pre-0.8.1 behaviour for BOTH directions, as an escape hatch.
 *
 * The `~/.wayang` DATA DIRECTORY is deliberately NOT on the list (0.8.3): the
 * worker needs to drop temp files there and read its own session, so the
 * directory is released while the API-key-bearing CONFIG FILE
 * (`.wayang.config.json`) stays sensitive.
 *
 * `access: 'unknown'` means "the caller could not classify the operation"
 * (bash, today). It is treated as a potential write for scope purposes (never
 * gets the read-inside-home allow) but as a read for the sensitive list (so a
 * `cat ~/.ssh/id_rsa` asks instead of being refused outright).
 */

import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

/**
 * What the caller wants to do with the path.
 *
 * `unknown` is for callers that cannot tell (a bash command line: `cat` reads,
 * `rm` writes, redirections write). See the module doc for how it is judged.
 */
export type AccessMode = 'read' | 'write' | 'unknown';

/** The policy verdict. `ask` means "no rule covers this — request approval". */
export type AccessDecision = 'allow' | 'deny' | 'ask';

/**
 * Which rule produced the decision. Kept human-readable so it can be surfaced
 * verbatim in approval prompts / logs.
 */
export type MatchedRule =
  | 'sensitive-list'
  | 'sensitive-list-write'
  | 'config-allowed'
  | 'auto-allow-root'
  | 'task-allowed'
  | 'task-workspace'
  | 'read-within-home'
  | 'outside-all';

/**
 * How a sensitive-list entry can match. Reported alongside the entry so the
 * approval request and the audit trail say WHICH rule fired, not just "some
 * protected path".
 *
 * - `segment`    — an anchor-independent name matching one whole path segment
 * - `filename`   — an anchor-independent FILE name (`SENSITIVE_FILENAMES`)
 * - `pair`       — a two-segment rule (`.docker/config.json`)
 * - `home-default` — a home-anchored built-in relative entry (e.g. `.config/gh`)
 * - `config-dir` — a user-configured `permission.sensitiveDirs` entry
 */
export type SensitiveMatchSource = 'segment' | 'filename' | 'pair' | 'home-default' | 'config-dir';

/** A sensitive-list hit: the entry itself plus which rule produced it. */
export interface SensitiveMatch {
  /** The matched entry: a segment (`.ssh`), a relative path or a configured dir. */
  entry: string;
  source: SensitiveMatchSource;
}

/**
 * How sensitive paths are handled: `ask` (default) requests approval for reads
 * and refuses writes; `deny` refuses both without ever asking (pre-0.8.1).
 */
export type SensitiveMode = 'ask' | 'deny';

export interface NormalizePathOptions {
  /** Base directory for relative paths. Defaults to `process.cwd()`. */
  base?: string;
}

export interface DecideAccessInput {
  /** The path being accessed — absolute, or relative to `cwd`. */
  path: string;
  access: AccessMode;
  /** Base for a relative `path`. Defaults to `process.cwd()`. */
  cwd?: string;
  /** The user's home directory. Required — both the sensitive list and the read scope are anchored here. */
  homeDir: string;
  /** The task's workspace directory (writable scope for that task). */
  taskWorkspace?: string;
  /** Extra directories allowed for that one task. Relative entries resolve against `taskWorkspace`. */
  taskAllowedDirs?: string[];
  /** User-config `permission.allowedDirs`. Relative entries resolve against `homeDir`. */
  configAllowedDirs?: string[];
  /** User-config `permission.autoAllowRoots`. Relative entries resolve against `homeDir`. */
  autoAllowRoots?: string[];
  /**
   * User-config `permission.sensitiveDirs` (plus the deprecated `deniedDirs`
   * alias, already merged by the caller). Appended to the built-in sensitive
   * list; relative entries resolve against `homeDir`.
   */
  extraSensitiveDirs?: string[];
  /**
   * User-config `permission.sensitiveMode`. `ask` (default) → sensitive reads
   * request approval; `deny` → sensitive reads are refused outright.
   */
  sensitiveMode?: SensitiveMode;
}

export interface DecideAccessResult {
  decision: AccessDecision;
  matchedRule: MatchedRule;
  /** Canonical path the decision was made about. */
  resolvedPath: string;
  /**
   * Present on a sensitive-list hit: the entry that matched (`.ssh`, `.docker`
   * config pair, a configured dir, …). Consumers surface it in approval
   * requests and in the audit trail — never in a refusal handed to a worker.
   */
  matchedEntry?: string;
  /** Present with `matchedEntry`: which sensitive rule produced the hit. */
  matchedSource?: SensitiveMatchSource;
  /** True exactly when the verdict came from the sensitive list. */
  sensitive?: boolean;
  /**
   * True exactly when the decision is an `allow` whose ONLY justification is
   * rule 6 ("read inside home"). Consumers that deliberately narrow home-wide
   * reads (e.g. the worker file tools) key off this boolean instead of the
   * `matchedRule` string literal, so a future rename of the rule cannot
   * silently widen access. Optional for backward compatibility: it is only set
   * on the read-within-home result, absent (undefined/falsy) everywhere else.
   */
  withinReadScope?: boolean;
}

/**
 * Paths (relative to the user's home directory) that make up the sensitive
 * list under home — they are never read silently and never written. Credentials
 * and tool configs live here.
 *
 * The `~/.wayang` DIRECTORY is not listed on purpose: it is the tool's own data
 * dir (sessions, logs, worker temp files), not user credentials. Only its
 * config file — `.wayang.config.json`, the one holding the API key — stays
 * sensitive (see `SENSITIVE_FILENAMES`).
 */
const DEFAULT_SENSITIVE_RELATIVE_PATHS = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.gcloud',
  '.kube',
  '.docker/config.json',
  '.netrc',
  '.git-credentials',
  '.npmrc',
  '.pypirc',
  '.config/gh',
  '.wayang.config.json',
] as const;

/**
 * Anchor-INDEPENDENT sensitive path segments.
 *
 * The list above is anchored to the injected home directory (`--home-dir`).
 * That is not enough on its own: when the injected home is not the real home
 * (or a task reaches the real home by absolute path / symlink), a credential
 * directory like `/data/home/alice/.ssh` sits *outside* that anchor and would
 * otherwise fall through to "outside-all → ask". These segments are therefore
 * matched against EVERY normalized absolute path, whatever root it lives
 * under, and they outrank every allow rule.
 *
 * Matching is WHOLE-SEGMENT equality (`.sshfoo` and `b.ssh` never match),
 * and — deliberately — case-SENSITIVE, mirroring the Linux filesystem where
 * `.SSH` is a different directory from `.ssh`. Do NOT lowercase here.
 *
 * The wayang data dir (`.wayang`) is intentionally absent since 0.8.3: the
 * directory is released so a worker can keep temp files and read its session
 * there, wherever it appears. Its config file stays sensitive through
 * `SENSITIVE_FILENAMES` below.
 */
const SENSITIVE_SEGMENTS: ReadonlySet<string> = new Set([
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.gcloud',
  '.kube',
  '.netrc',
  '.git-credentials',
  '.npmrc',
  '.pypirc',
]);

/**
 * Sensitive file-name segments that are not themselves directory names. A path
 * is sensitive when any one of its segments equals one of these.
 */
const SENSITIVE_FILENAMES: ReadonlySet<string> = new Set([
  '.wayang.config.json',
]);

/**
 * Two-segment sensitive rules: `[dir, child]`. `.docker` alone is an ordinary
 * config directory (many projects have one), but `.docker/config.json` holds
 * registry credentials, so only the pair counts.
 */
const SENSITIVE_SEGMENT_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['.docker', 'config.json'],
];

/**
 * Upper bound on how many parents we walk up while looking for the deepest
 * existing ancestor of a path. Keeps canonicalization O(1)-ish in the worst
 * case instead of walking to the root for pathological inputs.
 */
const MAX_ANCESTOR_DEPTH = 32;

/**
 * Canonicalize a path: `realpath` first (resolves `..`, trailing slashes and
 * symlinks). When the full path cannot be resolved because it does not exist
 * (or a component is unreadable), resolve the deepest ancestor that DOES exist
 * and re-append the missing tail:
 *
 *   /tmp/link/.ssh/new_key   (/tmp/link -> /home/u, new_key missing)
 *     => /home/u/.ssh/new_key
 *
 * The tail must be re-appended to the *resolved* ancestor, not to the lexical
 * one: a purely lexical fallback would keep the `link` spelling and let a
 * symlinked ancestor smuggle a path past the sensitive list (a lexical test
 * against `/home/u/.ssh` would not match `/tmp/link/.ssh/new_key`).
 *
 * If not even the filesystem root can be resolved, fall back to the lexical
 * `path.resolve` result. Never throws.
 *
 * Complexity: one `realpath` syscall per path segment attempted, bounded by
 * `MAX_ANCESTOR_DEPTH + 1` (33) lookups for a single call; successful lookups
 * exit immediately, so the common case is a single `realpath`.
 */
export function normalizePath(p: string, opts: NormalizePathOptions = {}): string {
  const base = opts.base ?? process.cwd();
  const lexical = isAbsolute(p) ? resolve(p) : resolve(base, p);
  try {
    return realpathSync(lexical);
  } catch {
    return resolveDeepestExistingAncestor(lexical);
  }
}

/**
 * Resolve `lexical` by peeling off trailing segments until one of the prefixes
 * is `realpath`-able, then gluing the peeled segments back onto that realpath.
 * `lexical` is expected to be absolute and already lexically normalized, so the
 * peeled segments never contain `..`.
 */
function resolveDeepestExistingAncestor(lexical: string): string {
  const peeled: string[] = [];
  let candidate = lexical;

  for (let depth = 0; depth <= MAX_ANCESTOR_DEPTH; depth += 1) {
    try {
      const resolved = realpathSync(candidate);
      return peeled.length === 0 ? resolved : resolve(join(resolved, ...peeled));
    } catch {
      // Not resolvable (missing or unreadable) — try the parent.
    }
    const parent = dirname(candidate);
    if (parent === candidate) break; // hit the filesystem root
    peeled.unshift(basename(candidate));
    candidate = parent;
  }

  // Nothing along the chain was resolvable (or the walk limit was reached):
  // keep the previous lexical behaviour rather than inventing a path.
  return lexical;
}

/** Built-in sensitive list for a given home directory, as absolute paths. */
export function defaultSensitivePaths(homeDir: string): string[] {
  return DEFAULT_SENSITIVE_RELATIVE_PATHS.map((rel) => resolve(homeDir, rel));
}

/**
 * Segment-boundary containment: is `child` equal to or below `parent`?
 *
 * String prefixing is not enough — `/a/b` must not match `/a/bc`. Both inputs
 * are expected to be absolute, normalized paths (see `normalizePath`).
 */
export function isPathWithin(parent: string, child: string): boolean {
  if (parent === sep) return child.startsWith(sep); // root '/' contains every absolute path
  if (child === parent) return true;
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(prefix);
}

/**
 * Does `absPath` fall into any listed directory? `sensitivePaths` are expected
 * to be absolute; an entry also covers everything beneath it
 * (`.ssh` covers `.ssh/id_rsa`).
 */
export function isDenied(absPath: string, sensitivePaths: string[]): boolean {
  return sensitivePaths.some((sensitive) => isPathWithin(sensitive, absPath));
}

/**
 * Anchor-independent sensitive-entry check. `absPath` is expected to be an
 * absolute, normalized path (see `normalizePath`). Returns the matching ENTRY
 * (the segment or `dir/child` pair) — not a boolean — so approval requests and
 * the audit trail can name what matched, regardless of which directory the
 * path lives under.
 *
 * Intentionally strict: a `.ssh` directory *inside* a task workspace also
 * matches. The point is that credentials never get read or written silently,
 * even when they happen to live inside an otherwise allowed tree; this is a
 * deliberate trade-off (false positives are acceptable, silent credential
 * access is not).
 */
export function matchSensitiveEntry(absPath: string): SensitiveMatch | undefined {
  const segments = absPath.split(sep).filter((s) => s.length > 0);
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (SENSITIVE_SEGMENTS.has(segment)) return { entry: segment, source: 'segment' };
    if (SENSITIVE_FILENAMES.has(segment)) return { entry: segment, source: 'filename' };
    // Two-segment rules (`.docker/config.json`) keep their pair semantics.
    for (const [dir, child] of SENSITIVE_SEGMENT_PAIRS) {
      if (segment === dir && segments[i + 1] === child) {
        return { entry: `${dir}/${child}`, source: 'pair' };
      }
    }
  }
  return undefined;
}

/** Boolean form of `matchSensitiveEntry` (see it for the matching rules). */
export function isSensitiveSegmentPath(absPath: string): boolean {
  return matchSensitiveEntry(absPath) !== undefined;
}

/** One entry of the home-anchored part of the sensitive list. */
interface SensitivePathEntry {
  /** Absolute, normalized target covered by the entry. */
  absPath: string;
  /** The entry as it should be reported (relative path or configured value). */
  entry: string;
  source: SensitiveMatchSource;
}

/**
 * Home-anchored sensitive candidates: the built-in entries plus the
 * user-configured `permission.sensitiveDirs`. The reported entry stays in its
 * configured spelling (`.ssh`, `.config/gh`, `private/notes`) so an approval
 * prompt names something the user can look up in their config.
 */
function sensitivePathEntries(homeDir: string, extraSensitiveDirs: string[] | undefined): SensitivePathEntry[] {
  const builtIn: SensitivePathEntry[] = DEFAULT_SENSITIVE_RELATIVE_PATHS.map((rel) => ({
    absPath: normalizePath(resolve(homeDir, rel)),
    entry: rel,
    source: 'home-default',
  }));
  const configured: SensitivePathEntry[] = (extraSensitiveDirs ?? [])
    .filter((d): d is string => typeof d === 'string' && d.length > 0)
    .map((d) => ({
      absPath: normalizePath(d, { base: homeDir }),
      entry: d,
      source: 'config-dir' as const,
    }));
  return [...builtIn, ...configured];
}

/** First home-anchored sensitive entry covering `absPath`, or undefined. */
function matchSensitivePath(homeDir: string, absPath: string, extraSensitiveDirs?: string[]): SensitiveMatch | undefined {
  const hit = sensitivePathEntries(homeDir, extraSensitiveDirs).find((entry) => isPathWithin(entry.absPath, absPath));
  return hit ? { entry: hit.entry, source: hit.source } : undefined;
}

/** Normalize a list of configured directories; relative entries resolve against `base`. */
function normalizeDirs(dirs: string[] | undefined, base: string): string[] {
  if (!dirs) return [];
  return dirs.filter((d) => typeof d === 'string' && d.length > 0).map((d) => normalizePath(d, { base }));
}

/** First directory (already normalized) that contains `target`, or undefined. */
function findContaining(dirs: string[], target: string): string | undefined {
  return dirs.find((dir) => isPathWithin(dir, target));
}

/**
 * Decide whether an access is allowed, denied, or needs approval.
 * Rules are evaluated in order; the first match wins.
 */
export function decideAccess(input: DecideAccessInput): DecideAccessResult {
  const resolvedPath = normalizePath(input.path, { base: input.cwd });
  const homeDir = normalizePath(input.homeDir);

  const taskWorkspace = input.taskWorkspace ? normalizePath(input.taskWorkspace, { base: homeDir }) : undefined;
  const taskAllowedDirs = normalizeDirs(input.taskAllowedDirs, taskWorkspace ?? homeDir);
  const configAllowedDirs = normalizeDirs(input.configAllowedDirs, homeDir);
  const autoAllowRoots = normalizeDirs(input.autoAllowRoots, homeDir);
  const sensitiveMode: SensitiveMode = input.sensitiveMode ?? 'ask';

  // 1. Sensitive list — highest priority, not overridable by any allow rule
  //    (a `.ssh` directory inside the workspace is still sensitive).
  //
  // 1a. Anchor-independent entries first: this catches credential locations
  //     even when the injected home is not the real home (a single-anchor rule
  //     would miss `/real/home/.ssh` and merely ask).
  // 1b. Then the home-anchored entries (built-ins + `permission.sensitiveDirs`,
  //     which may be relative to home).
  const sensitive = matchSensitiveEntry(resolvedPath) ?? matchSensitivePath(homeDir, resolvedPath, input.extraSensitiveDirs);
  if (sensitive) {
    const hit = { matchedEntry: sensitive.entry, matchedSource: sensitive.source, sensitive: true };
    // Writes into a sensitive location are refused outright, with no approval
    // round-trip: "let the agent rewrite authorized_keys" has no legitimate
    // use, and an approval prompt would make it a one-word decision.
    if (input.access === 'write') {
      return { decision: 'deny', matchedRule: 'sensitive-list-write', resolvedPath, ...hit };
    }
    // Escape hatch: restore the pre-0.8.1 "never even ask" behaviour.
    if (sensitiveMode === 'deny') {
      return { decision: 'deny', matchedRule: 'sensitive-list', resolvedPath, ...hit };
    }
    // Reads (and commands whose semantics are unknown) may be approved once;
    // the approval request carries the matched entry + canonical path.
    return { decision: 'ask', matchedRule: 'sensitive-list', resolvedPath, ...hit };
  }

  // 2. User config: allowedDirs.
  if (findContaining(configAllowedDirs, resolvedPath) !== undefined) {
    return { decision: 'allow', matchedRule: 'config-allowed', resolvedPath };
  }

  // 3. User config: autoAllowRoots.
  if (findContaining(autoAllowRoots, resolvedPath) !== undefined) {
    return { decision: 'allow', matchedRule: 'auto-allow-root', resolvedPath };
  }

  // 4. Task-level allowedDirs (this task only).
  if (findContaining(taskAllowedDirs, resolvedPath) !== undefined) {
    return { decision: 'allow', matchedRule: 'task-allowed', resolvedPath };
  }

  // 5. Task workspace.
  if (taskWorkspace !== undefined && isPathWithin(taskWorkspace, resolvedPath)) {
    return { decision: 'allow', matchedRule: 'task-workspace', resolvedPath };
  }

  // 6. Reads inside home are fine (minus the sensitive list). Writes are not,
  //    and `unknown` does not qualify either: "inside home" must never be
  //    sufficient to justify a write, and a caller that cannot prove the
  //    operation is a read has not proven it either.
  if (input.access === 'read' && isPathWithin(homeDir, resolvedPath)) {
    return { decision: 'allow', matchedRule: 'read-within-home', resolvedPath, withinReadScope: true };
  }

  // 7. Nothing matched — ask the user.
  return { decision: 'ask', matchedRule: 'outside-all', resolvedPath };
}
