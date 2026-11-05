/**
 * Task-scoped approval memory — "read this path again in the same task without
 * asking me twice" (issue #46, the minimal usable slice of #44).
 *
 * WHAT IS REMEMBERED, and what deliberately is not:
 *
 *   - Direction: ONLY `read`. A write is not reversible by the controller
 *     afterwards, so a single approval must never cover a later write. Typing
 *     `ApprovalDirection` as the literal `'read'` keeps that rule at compile
 *     time instead of in a comment.
 *   - Identity: the CANONICAL path the policy already produced
 *     (`resolvedPath` is realpath-normalized, so `./x`, `../x` and a symlinked
 *     ancestor collapse onto one key). No command templates, no bash parsing:
 *     the key is made of quantities the policy has already computed (see the
 *     issue: "key 只用策略已经算出来的确定量"). A bash command contributes one
 *     key PER candidate path, never a key for the command string.
 *   - Sensitive hits are never remembered, in either mode: `~/.ssh` must be
 *     asked about every single time, otherwise a task-scoped grant would mean
 *     "this task may now read the credential directory freely".
 *   - Denials are never remembered either (out of scope for #46): a refusal is
 *     a decision about one request, and remembering it would turn a transient
 *     "not now" into a silent wall.
 *
 * LIFETIME: a grant lives exactly as long as the task it was approved in.
 * `TaskExecuteEngine` calls `clearTask(taskId)` on the terminal transitions
 * (completed / failed / cancelled) with a DIRECT call — the grant store is core
 * gate behaviour, not a peripheral side effect, so it must not ride on a
 * lifecycle hook. Nothing is persisted: the store is process memory, and a
 * `--resume`d session starts empty by design (a grant that outlives the process
 * would be a long-term silent authorization nobody reviewed).
 *
 * Only metadata is stored — task, key, canonical path, the request that
 * approved it, a timestamp. Never file content, never tool output.
 */

import { generateId } from '@/utils/id';

/**
 * Directions a grant can cover. Deliberately a one-member union: writes are
 * never remembered, so `approvalKey('write', …)` must not even compile.
 */
export type ApprovalDirection = 'read';

/** Everything remembered about one approved read. */
export interface ApprovalGrant {
  /** Stable id quoted in the audit trail when the grant is reused. */
  grantId: string;
  /** Task the grant belongs to — the whole scope of this feature. */
  taskId: string;
  /** `${direction}:${normalizedPath}` — the lookup key. */
  key: string;
  /** Canonical path the grant covers (the key without its direction prefix). */
  path: string;
  /** Direction of the approval (always `read`). */
  access: ApprovalDirection;
  /** The `permission_request` the controller approved, for traceability. */
  requestId?: string;
  /** Epoch ms the grant was created. */
  createdAt: number;
}

/** Metadata attached to a grant when it is written. */
export interface ApprovalGrantMeta {
  /** Canonical path; defaults to the key with its direction prefix stripped. */
  path?: string;
  /** The `permission_request` that was approved. */
  requestId?: string;
}

/**
 * Build the lookup key for one grant: direction + canonical path.
 *
 * The canonical path comes from the policy (`resolvedPath`), so two spellings
 * of the same file share a key — and, on purpose, a `bash` candidate and a
 * file-tool argument that resolve to the same file share it too (see the
 * design note in `docs/design/permission-policy-0.8.1.md`): the thing being
 * approved is "read this file", not "run this tool".
 */
export function approvalKey(direction: ApprovalDirection, normalizedPath: string): string {
  return `${direction}:${normalizedPath}`;
}

/** Strip the direction prefix from a key, for display / meta defaulting. */
function pathOf(key: string): string {
  const idx = key.indexOf(':');
  return idx === -1 ? key : key.slice(idx + 1);
}

/**
 * Per-task grants. Shape: `taskId → key → grant`.
 *
 * The store is intentionally tiny: `remember` / `has` / `get` / `clearTask` /
 * `size`. Anything richer (denial memory, scopes, statistics) belongs to the
 * full #44 design, not here.
 */
export class ApprovalMemory {
  private readonly byTask = new Map<string, Map<string, ApprovalGrant>>();

  /**
   * Remember an approved READ. Idempotent: an existing grant is returned
   * untouched, so a repeated approval keeps the ORIGINAL `grantId` (the audit
   * trail then points at the decision that actually opened the door).
   */
  remember(taskId: string, key: string, meta: ApprovalGrantMeta = {}): ApprovalGrant {
    let grants = this.byTask.get(taskId);
    if (!grants) {
      grants = new Map<string, ApprovalGrant>();
      this.byTask.set(taskId, grants);
    }
    const existing = grants.get(key);
    if (existing) return existing;

    const grant: ApprovalGrant = {
      grantId: generateId('grant'),
      taskId,
      key,
      path: meta.path ?? pathOf(key),
      access: 'read',
      ...(meta.requestId !== undefined && { requestId: meta.requestId }),
      createdAt: Date.now(),
    };
    grants.set(key, grant);
    return grant;
  }

  /** True when this task holds a grant for exactly this key. */
  has(taskId: string, key: string): boolean {
    return this.byTask.get(taskId)?.has(key) ?? false;
  }

  /** The grant behind a hit, or `undefined`. */
  get(taskId: string, key: string): ApprovalGrant | undefined {
    return this.byTask.get(taskId)?.get(key);
  }

  /**
   * Drop every grant of a task. Called from the engine's terminal task
   * transitions; returns the number of grants dropped so the caller can log it.
   */
  clearTask(taskId: string): number {
    const grants = this.byTask.get(taskId);
    if (!grants) return 0;
    const count = grants.size;
    this.byTask.delete(taskId);
    return count;
  }

  /** Total grants held across all tasks (tests / diagnostics). */
  size(): number {
    let total = 0;
    for (const grants of this.byTask.values()) total += grants.size;
    return total;
  }

  /** Drop everything (tests). */
  clear(): void {
    this.byTask.clear();
  }
}

/**
 * Fallback store for a middleware built WITHOUT an injected one.
 *
 * The engine always injects its own per-session store (`TaskExecuteEngine
 * .approvalGrants`), because the store must outlive a single worker run — the
 * middleware is rebuilt per run while a grant is per TASK — and must die with
 * the session. This singleton exists so `wrapWithPermissionMiddleware` stays
 * usable standalone (and so the default is one shared object rather than a
 * fresh, useless store per call); nothing in the engine path uses it.
 */
export const sharedApprovalMemory = new ApprovalMemory();
