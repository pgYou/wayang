/**
 * Pure access-decision policy: "may this access be allowed?"
 *
 * This module is deliberately side-effect free apart from read-only filesystem
 * lookups used for path canonicalization (`realpath`) — it does not read
 * config, does not consult session state, does not prompt, and does not cache.
 * Callers pass every relevant input in and get a decision back:
 *
 *   1. sensitive list      → ask (both directions; deny under sensitiveMode: 'deny')
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
 * Sensitive paths: TOUCHING one — reading or writing — requires approval
 * (`ask`). The approval request and the audit trail carry the matched entry,
 * the matched source, the canonical target and the judged direction, so the
 * decision is explainable and reviewable, and the file content itself never
 * leaks into them.
 *
 * Hard-refusal semantics (0.8.4): NO path is ever allowed because it is
 * sensitive — every allow rule below is outranked by this one, so a sensitive
 * hit can only ask or be refused, never pass silently. It is also no longer
 * TRUE that a sensitive hit is unapprovable: the user who owns the machine can
 * approve one write to `authorized_keys` the same way they approve one read of
 * `id_rsa`, and the audit trail records it. What the rule guarantees is the
 * absence of a SILENT path, not the absence of an approval. `sensitiveMode:
 * 'deny'` is the escape hatch for users who do not want to be prompted at all:
 * it restores the pre-0.8.1 "refuse without asking" behaviour for BOTH
 * directions.
 *
 * Wayang's OWN paths are deliberately NOT on the list (0.8.3): neither the
 * `~/.wayang` data directory (sessions, logs, worker temp files) nor the
 * `~/.wayang.config.json` config file is a user credential — the worker needs
 * to read its own config and session, so both are released and judged by the
 * ordinary scope rules. "Released" is not "silently trusted": a read inside
 * home is still downgraded to `ask` at the worker layer, and a write outside
 * the workspace still asks. Third-party credentials (`.ssh`, `.aws`, `.npmrc`,
 * `.docker/config.json`, …) keep their sensitive handling.
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
 * - `pair`       — a two-segment rule (`.docker/config.json`)
 * - `home-default` — a home-anchored built-in relative entry (e.g. `.config/gh`)
 * - `config-dir` — a user-configured `permission.sensitiveDirs` entry
 *
 * The former `filename` source (`.wayang.config.json`) is gone since 0.8.3:
 * that file is wayang's own config, not a third-party credential.
 */
export type SensitiveMatchSource = 'segment' | 'pair' | 'home-default' | 'config-dir';

/** A sensitive-list hit: the entry itself plus which rule produced it. */
export interface SensitiveMatch {
  /** The matched entry: a segment (`.ssh`), a relative path or a configured dir. */
  entry: string;
  source: SensitiveMatchSource;
}

/**
 * How sensitive paths are handled: `ask` (default) requests approval for a hit
 * in EITHER direction — read or write — and `deny` refuses both without ever
 * asking (the pre-0.8.1 behaviour). Neither mode can turn a sensitive hit into
 * an allow: the list outranks every allow rule, so the only question the mode
 * answers is "ask, or refuse outright?".
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
  /**
   * The user's home directory — the POLICY BOUNDARY. Required: both the
   * sensitive list and the read scope are anchored here. In production it is
   * the process home (`os.homedir()`); it is a separate concept from `~`
   * EXPANSION (see `expandHome` in the tool layer), which always anchors on
   * the process home so tools open what a shell would.
   */
  userHome: string;
  /** The task's workspace directory (writable scope for that task). */
  taskWorkspace?: string;
  /** Extra directories allowed for that one task. Relative entries resolve against `taskWorkspace`. */
  taskAllowedDirs?: string[];
  /** User-config `permission.allowedDirs`. Relative entries resolve against `userHome`. */
  configAllowedDirs?: string[];
  /** User-config `permission.autoAllowRoots`. Relative entries resolve against `userHome`. */
  autoAllowRoots?: string[];
  /**
   * User-config `permission.sensitiveDirs` (plus the deprecated `deniedDirs`
   * alias, already merged by the caller). Appended to the built-in sensitive
   * list; relative entries resolve against `userHome`.
   */
  extraSensitiveDirs?: string[];
  /**
   * User-config `permission.sensitiveMode`. `ask` (default) → a sensitive hit
   * asks for approval in either direction; `deny` → refused outright, no
   * prompt. Neither mode can make a sensitive hit pass silently.
   */
  sensitiveMode?: SensitiveMode;
  /**
   * May a read inside the home directory run silently (rule 6)? The default
   * `true` keeps the policy's own scope. A caller whose silent scope is
   * narrower than home — the worker gates, whose silence-worthy scope is the
   * workspace / task allowedDirs / configured roots — passes `false` and rule 6
   * returns its ask directly, so no caller ever needs to post-hoc downgrade an
   * allow. The flag ONLY touches rule 6: every other rule (sensitive list,
   * allowedDirs, autoAllowRoots, workspace) is unchanged either way.
   */
  allowReadWithinHome?: boolean;
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
   * True exactly when rule 6 ("read inside home") decided the verdict: by
   * default that is an `allow` whose ONLY justification is the home read
   * scope; with `allowReadWithinHome: false` it is the ask the rule escalates
   * to. Consumers key off this boolean instead of the `matchedRule` string
   * literal, so a future rename of the rule cannot silently widen access.
   * Optional for backward compatibility: absent (undefined/falsy) on every
   * result any other rule produced.
   */
  withinReadScope?: boolean;
}

/**
 * Paths (relative to the user's home directory) that make up the sensitive
 * list under home — they are never read silently and never written. Credentials
 * and third-party tool configs live here.
 *
 * Wayang's own paths are not listed on purpose (0.8.3): the `~/.wayang` data
 * dir (sessions, logs, worker temp files) and the `~/.wayang.config.json`
 * config file are the tool's own state, not user credentials, and the worker
 * needs to read them. They fall through to the ordinary scope rules instead
 * (read-inside-home → ask at the worker layer, out-of-workspace write → ask),
 * while real third-party credentials stay sensitive.
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
 * Wayang's own directory (`.wayang`) is intentionally absent since 0.8.3: it is
 * released so a worker can keep temp files and read its session there, wherever
 * it appears. Its config file (`.wayang.config.json`) is released in the same
 * release for the same reason — the worker must be able to read the config, and
 * neither path is a third-party credential.
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

/** Built-in sensitive list for a given user home directory, as absolute paths. */
export function defaultSensitivePaths(userHome: string): string[] {
  return DEFAULT_SENSITIVE_RELATIVE_PATHS.map((rel) => resolve(userHome, rel));
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
function sensitivePathEntries(userHome: string, extraSensitiveDirs: string[] | undefined): SensitivePathEntry[] {
  const builtIn: SensitivePathEntry[] = DEFAULT_SENSITIVE_RELATIVE_PATHS.map((rel) => ({
    absPath: normalizePath(resolve(userHome, rel)),
    entry: rel,
    source: 'home-default',
  }));
  const configured: SensitivePathEntry[] = (extraSensitiveDirs ?? [])
    .filter((d): d is string => typeof d === 'string' && d.length > 0)
    .map((d) => ({
      absPath: normalizePath(d, { base: userHome }),
      entry: d,
      source: 'config-dir' as const,
    }));
  return [...builtIn, ...configured];
}

/** First home-anchored sensitive entry covering `absPath`, or undefined. */
function matchSensitivePath(userHome: string, absPath: string, extraSensitiveDirs?: string[]): SensitiveMatch | undefined {
  const hit = sensitivePathEntries(userHome, extraSensitiveDirs).find((entry) => isPathWithin(entry.absPath, absPath));
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
  const userHome = normalizePath(input.userHome);

  const taskWorkspace = input.taskWorkspace ? normalizePath(input.taskWorkspace, { base: userHome }) : undefined;
  const taskAllowedDirs = normalizeDirs(input.taskAllowedDirs, taskWorkspace ?? userHome);
  const configAllowedDirs = normalizeDirs(input.configAllowedDirs, userHome);
  const autoAllowRoots = normalizeDirs(input.autoAllowRoots, userHome);
  const sensitiveMode: SensitiveMode = input.sensitiveMode ?? 'ask';

  // 1. Sensitive list — highest priority, not overridable by any allow rule
  //    (a `.ssh` directory inside the workspace is still sensitive).
  //
  // 1a. Anchor-independent entries first: this catches credential locations
  //     even when the injected home is not the real home (a single-anchor rule
  //     would miss `/real/home/.ssh` and merely ask).
  // 1b. Then the home-anchored entries (built-ins + `permission.sensitiveDirs`,
  //     which may be relative to home).
  const sensitive = matchSensitiveEntry(resolvedPath) ?? matchSensitivePath(userHome, resolvedPath, input.extraSensitiveDirs);
  if (sensitive) {
    const hit = { matchedEntry: sensitive.entry, matchedSource: sensitive.source, sensitive: true };
    // Escape hatch: `deny` restores the pre-0.8.1 behaviour and refuses
    // without ever asking. It is the ONLY way a sensitive hit becomes a hard
    // refusal — see the mode doc on `SensitiveMode`.
    if (sensitiveMode === 'deny') {
      return { decision: 'deny', matchedRule: 'sensitive-list', resolvedPath, ...hit };
    }
    // Otherwise both directions ask. A write is not "approved" by the rule —
    // it is escalated like a read, with the same explainability fields, and
    // may only proceed if the controller approves it. Nothing here can be
    // reached by an allow rule (this branch comes first).
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
  //    operation is a read has not proven it either. With
  //    `allowReadWithinHome: false` the rule returns its ask DIRECTLY — the
  //    worker gates ask for exactly this verdict shape, so no caller ever
  //    downgrades a home-read allow after the fact.
  if (input.access === 'read' && isPathWithin(userHome, resolvedPath)) {
    if (input.allowReadWithinHome === false) {
      return { decision: 'ask', matchedRule: 'read-within-home', resolvedPath, withinReadScope: true };
    }
    return { decision: 'allow', matchedRule: 'read-within-home', resolvedPath, withinReadScope: true };
  }

  // 7. Nothing matched — ask the user.
  return { decision: 'ask', matchedRule: 'outside-all', resolvedPath };
}
