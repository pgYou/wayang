/**
 * Pure access-decision policy: "may this access be allowed?"
 *
 * This module is deliberately side-effect free apart from read-only filesystem
 * lookups used for path canonicalization (`realpath`) — it does not read
 * config, does not consult session state, does not prompt, and does not cache.
 * Callers pass every relevant input in and get a decision back:
 *
 *   1. denylist            → deny   (wins over everything else)
 *   2. config allowedDirs  → allow
 *   3. config autoAllowRoots → allow
 *   4. task allowedDirs    → allow
 *   5. task workspace      → allow
 *   6. read inside home    → allow (read only; never sufficient for writes)
 *   7. nothing matched     → ask
 *
 * Read vs write: the home directory is readable (minus the denylist), but it is
 * NOT writable as a whole — writes are only allowed inside the task workspace /
 * task allowedDirs / explicitly configured dirs. "Inside home" must never be
 * enough to justify a write.
 *
 * This module is intentionally NOT wired into the existing permission
 * middleware / worker tool paths; it only exists so those paths can adopt one
 * shared policy later.
 */

import { realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

/** What the caller wants to do with the path. */
export type AccessMode = 'read' | 'write';

/** The policy verdict. `ask` means "no rule covers this — request approval". */
export type AccessDecision = 'allow' | 'deny' | 'ask';

/**
 * Which rule produced the decision. Kept human-readable so it can be surfaced
 * verbatim in approval prompts / logs.
 */
export type MatchedRule =
  | 'denylist'
  | 'config-allowed'
  | 'auto-allow-root'
  | 'task-allowed'
  | 'task-workspace'
  | 'read-within-home'
  | 'outside-all';

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
  /** The user's home directory. Required — both the denylist and the read scope are anchored here. */
  homeDir: string;
  /** The task's workspace directory (writable scope for that task). */
  taskWorkspace?: string;
  /** Extra directories allowed for that one task. Relative entries resolve against `taskWorkspace`. */
  taskAllowedDirs?: string[];
  /** User-config `permission.allowedDirs`. Relative entries resolve against `homeDir`. */
  configAllowedDirs?: string[];
  /** User-config `permission.autoAllowRoots`. Relative entries resolve against `homeDir`. */
  autoAllowRoots?: string[];
  /** User-config `permission.deniedDirs`. Appended to the built-in denylist; relative entries resolve against `homeDir`. */
  extraDeniedDirs?: string[];
}

export interface DecideAccessResult {
  decision: AccessDecision;
  matchedRule: MatchedRule;
  /** Canonical path the decision was made about. */
  resolvedPath: string;
}

/**
 * Paths (relative to the user's home directory) that are always denied — even
 * when they would otherwise match an allowed or auto-allowed root. Credentials
 * and tool configs live here: an agent should never silently read or write them.
 */
const DEFAULT_DENIED_RELATIVE_PATHS = [
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
  '.wayang',
] as const;

/**
 * Canonicalize a path: `realpath` first (resolves `..`, trailing slashes and
 * symlinks), falling back to the lexical `path.resolve` result when the path
 * does not exist (or is otherwise unreadable). Never throws.
 */
export function normalizePath(p: string, opts: NormalizePathOptions = {}): string {
  const base = opts.base ?? process.cwd();
  const lexical = isAbsolute(p) ? resolve(p) : resolve(base, p);
  try {
    return realpathSync(lexical);
  } catch {
    // Path does not exist (or a component is unreadable): keep the lexical
    // resolution so callers still get a stable absolute path.
    return lexical;
  }
}

/** Built-in denylist for a given home directory, as absolute paths. */
export function defaultDeniedPaths(homeDir: string): string[] {
  return DEFAULT_DENIED_RELATIVE_PATHS.map((rel) => resolve(homeDir, rel));
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
 * Does `absPath` fall into any denied directory? `deniedPaths` are expected to
 * be absolute; a denied entry also covers everything beneath it
 * (`.ssh` denies `.ssh/id_rsa`).
 */
export function isDenied(absPath: string, deniedPaths: string[]): boolean {
  return deniedPaths.some((denied) => isPathWithin(denied, absPath));
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
  const deniedPaths = [
    ...defaultDeniedPaths(homeDir),
    ...normalizeDirs(input.extraDeniedDirs, homeDir),
  ].map((d) => normalizePath(d));

  // 1. Denylist — highest priority, not overridable by any allow rule.
  if (isDenied(resolvedPath, deniedPaths)) {
    return { decision: 'deny', matchedRule: 'denylist', resolvedPath };
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

  // 6. Reads inside home are fine (minus the denylist). Writes are not:
  //    "inside home" must never be sufficient to justify a write.
  if (input.access === 'read' && isPathWithin(homeDir, resolvedPath)) {
    return { decision: 'allow', matchedRule: 'read-within-home', resolvedPath };
  }

  // 7. Nothing matched — ask the user.
  return { decision: 'ask', matchedRule: 'outside-all', resolvedPath };
}
