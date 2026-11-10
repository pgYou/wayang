// Types shared across the permission-rules modules: the worker-side verdict shape, the run boundary and the matched-rule union.

import type {
  AccessDecision,
  AccessMode,
  MatchedRule,
  SensitiveMatchSource,
} from '@/infra/permission/policy';
import type { PermissionConfig } from '@/types/config';

/**
 * Matched rules beyond the policy's own set: the destructive-command tier and
 * the "nothing to judge" case live in this module, not in the policy.
 */
export type WorkerMatchedRule =
  | MatchedRule
  | 'dangerous-bash'
  | 'no-path'
  | 'home-other-user'
  | 'dynamic-shell'
  | 'read-only-unverified'
  // #51 layer 2 — the capability gate's escalation classes.
  | 'unknown-capability'
  | 'exec-capability'
  | 'network-capability'
  | 'write-scope';

/** Everything the shared policy needs to know about ONE worker run's boundary. */
export interface WorkerAccessScope {
  /**
   * The user's home directory — the POLICY BOUNDARY (sensitive-list anchor and
   * read scope). Injected by the engine (never read globally here). In
   * production it is the process home (`os.homedir()`), but it is a separate
   * concept from `~` EXPANSION: `expandHome` always anchors on the process
   * home so a tool opens exactly what a shell would, while this field decides
   * whether that path is inside the scope a worker may touch.
   */
  userHome: string;
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
  /**
   * True when a sensitive-list entry was hit. For a sensitive verdict that IS
   * the reason (`matchedRule: 'sensitive-list'`); a stronger rule can still
   * raise the verdict — `dangerous-bash` sets this flag too, because the call
   * touches the entry whether or not the danger rule also fired.
   */
  sensitive?: boolean;
  /** Canonical (realpath-normalized) target the verdict was made about. */
  resolvedPath?: string;
  /**
   * How the target was judged: read / write / unknown (bash semantics). On a
   * command-level verdict this is the STRICTEST access its candidates justify
   * (`write` > `read` > `unknown`) — see `commandAccess`.
   */
  access?: AccessMode;
  /**
   * Canonical paths this call would need approval FOR — one entry per asking
   * candidate, and only on an `ask` reached by judging path candidates (a
   * `dangerous-bash`, `dynamic-shell`, `home-other-user` or
   * `read-only-unverified` escalation carries none: those asks are not "one
   * path, once" decisions).
   *
   * Exists for the task approval memory (issue #46): a grant is per
   * `direction:path`, so a reuse decision must know EVERY path the call asks
   * about. Checking just `resolvedPath` (the first asking candidate) would let
   * an approved `cat /etc/a /etc/b` silently cover `/etc/b` on the second run.
   */
  askPaths?: string[];
}
