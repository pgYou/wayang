/**
 * PermissionTransport — the shared spine of the three permission gates
 * (puppet middleware, ACP permission bridge, Claude Code worker gate).
 *
 * What used to exist three times now exists once:
 *  - the pending registry (park / settle / cleanup-all on abort) — one
 *    `BlockingRequestMap` per worker run, keyed by request id;
 *  - the controller-answer wait bound and its timeout settle —
 *    `DEFAULT_PERMISSION_TIMEOUT_MS` (300s), overridable per call so a
 *    caller can wire a configured bound later without a second constant;
 *  - the #69 five-state vocabulary (`PermissionResolutionStatus`) and the
 *    `BlockingRequestMap` outcome → status mapping;
 *  - the reusable-grant-keys rule (issue #46) and the deny text templates
 *    the puppet middleware hands back to the worker.
 *
 * Deliberately NOT here: the policy verdicts (permission-rules), the signal
 * payload assembly, and the audit records themselves. The three callers
 * project their verdicts differently (ACP's merged-snapshot classification,
 * Claude Code's SDK tool map), and their audit entries carry different
 * fields — only the SETTLE SEMANTICS are shared, and those are exactly the
 * five states below plus the canonical settle reasons.
 */

import { BlockingRequestMap, type SettledOutcome } from '@/infra/blocking-requests';
import { generateId } from '@/utils/id';
import { approvalKey } from './approval-memory';

/**
 * Default wait for a controller answer. Shared by all three gates; a caller
 * may pass its own bound to `wait` (the ACP bridge wires its per-provider
 * `permissionMs` config there), but no caller defines a second constant.
 */
export const DEFAULT_PERMISSION_TIMEOUT_MS = 300_000;

/** Canonical reason a timed-out wait settles with. */
export const PERMISSION_TIMEOUT_REASON = 'timeout';

/** Canonical reason an aborted / shut-down worker's wait settles with. */
export const PERMISSION_ABORT_REASON = 'Worker aborted';

/**
 * What a pending permission settles with. The puppet middleware and the ACP
 * bridge use it verbatim; the Claude Code gate adapts it onto the SDK's
 * `PermissionResult` (its `behavior` / `message` vocabulary) — the adapter
 * maps these two reason markers back onto the same messages it always built.
 */
export interface PermissionAnswer {
  approved: boolean;
  reason?: string;
}

/**
 * Outcome of routing a respond_permission call to a permission request
 * (issue #69). Every value is a definite terminal answer for the controller:
 *
 * - 'resolved' — THIS call settled a pending request; the worker proceeds
 *   with the answer.
 * - 'already-resolved' — the request was answered earlier; the duplicate
 *   response was ignored and the worker already continued with the first
 *   answer.
 * - 'expired' — the request timed out; the worker already received a
 *   timeout error and moved on. No response is needed.
 * - 'worker-closed' — the request was settled by worker abort/shutdown; the
 *   worker's wait was released with a cancellation. No response is needed.
 * - 'not-found' — no live request ever knew this id (stale id from an old
 *   turn or a finished worker). Retrying cannot help.
 *
 * In every non-'resolved' case the worker-side wait has already been
 * released (or never existed) — a controller can never leave a worker
 * hanging by sending one of these.
 */
export type PermissionResolutionStatus =
  | 'resolved'
  | 'already-resolved'
  | 'expired'
  | 'worker-closed'
  | 'not-found';

/**
 * Map a BlockingRequestMap settle outcome onto the permission status
 * vocabulary, so every gate reports the same distinguishable semantics for
 * a response that arrived after its request settled.
 */
export function permissionStatusFromOutcome(
  outcome: SettledOutcome | undefined,
): PermissionResolutionStatus {
  switch (outcome) {
    case 'responded':
      return 'already-resolved';
    case 'timed-out':
      return 'expired';
    case 'cleaned':
      return 'worker-closed';
    default:
      return 'not-found';
  }
}

/**
 * Shape the reuse rule reads. Both `PermissionVerdict` (puppet middleware)
 * and `ToolAccessDecision` (the shared policy the ACP and Claude Code gates
 * use) satisfy it, so one exported rule can serve every gate instead of
 * drifting into per-gate copies (issues #46/#58).
 */
export interface GrantReuseVerdict {
  decision: 'allow' | 'ask' | 'deny';
  access?: 'read' | 'write' | 'unknown';
  sensitive?: boolean;
  askPaths?: string[];
}

/**
 * The grants a verdict may reuse, or `[]` when this call must ask again.
 *
 * The rule is the whole contract of the feature (issue #46):
 *   - only `ask` reaches here (`allow` already ran, `deny` never runs);
 *   - only READ — a write approval is never carried to a later write;
 *   - never a sensitive hit — `~/.ssh` is asked about every single time, even
 *     under the default `sensitiveMode: 'ask'` where the hit IS approvable;
 *   - and the call must name at least one concrete path, so escalations that
 *     are not about a single path (`dangerous-bash`, `dynamic-shell`,
 *     `home-other-user`) can never be covered by an old grant.
 */
export function reusableGrantKeys(verdict: GrantReuseVerdict): string[] {
  if (verdict.decision !== 'ask') return [];
  if (verdict.access !== 'read') return [];
  if (verdict.sensitive === true) return [];
  const paths = verdict.askPaths ?? [];
  if (paths.length === 0) return [];
  const keys: string[] = [];
  for (const path of paths) {
    const key = approvalKey('read', path);
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/**
 * Why an unapproved wait settled: the controller denied, the wait timed out,
 * or the worker was aborted (the cleanup settles pending waits). Shared by
 * the audit `source` triage and the ACP denial ledger, which must agree on
 * which settles are user rejections and which are run teardown.
 */
export function denialSourceOf(
  answer: PermissionAnswer,
): 'timeout' | 'aborted' | 'controller' {
  if (answer.reason === PERMISSION_TIMEOUT_REASON) return 'timeout';
  if (answer.reason === PERMISSION_ABORT_REASON) return 'aborted';
  return 'controller';
}

/**
 * The refusal text the puppet middleware hands back to the worker's tool
 * call — one template per settle path, keyed on the canonical reasons, so
 * the three failure shapes stay distinguishable in the transcript:
 * timeout, worker shutdown, and a controller denial with its reason.
 */
export function permissionRefusalText(toolName: string, answer: PermissionAnswer): string {
  if (answer.reason === PERMISSION_TIMEOUT_REASON) {
    return `[ERROR] Permission request timed out for ${toolName}`;
  }
  if (answer.reason === PERMISSION_ABORT_REASON) {
    return `[ERROR] Permission request cancelled: worker shutting down`;
  }
  return `[ERROR] Permission denied for ${toolName}: ${answer.reason ?? 'operation not approved by controller'}`;
}

/**
 * One worker run's pending permission requests: the parking lot, the
 * timeout, and the #69 status bookkeeping over a `BlockingRequestMap`.
 *
 * Semantics per operation (identical to what the gates did separately):
 *  - `newRequestId()` — a 'perm' id that is not parked right now; ids are
 *    self-generated, so a (millisecond + suffix) collision is retried with a
 *    fresh id instead of throwing.
 *  - `wait(id, timeoutMs?)` — park a promise under `id`; on timeout it
 *    settles with `{ approved: false, reason: 'timeout' }` and the id
 *    becomes `expired` to a late responder. Timers are unref'd (the spine's
 *    behaviour — the two third-party gates already ran this way).
 *  - `resolve(id, approved, reason?)` — settle one request and report the
 *    #69 status: 'resolved', or the terminal state an earlier settle left.
 *  - `cleanup()` — settle everything as `{ approved: false, reason:
 *    'Worker aborted' }` (worker abort / shutdown).
 */
export class PermissionTransport {
  private readonly requests = new BlockingRequestMap<PermissionAnswer>();

  /** Number of requests parked right now. */
  get size(): number {
    return this.requests.size;
  }

  /** A 'perm' request id that is not parked right now (collision-safe). */
  newRequestId(): string {
    let requestId = generateId('perm');
    while (this.requests.has(requestId)) requestId = generateId('perm');
    return requestId;
  }

  /**
   * Park a promise under `requestId` until the controller answers, the bound
   * expires, or the run is cleaned up. The timeout settle is canonical
   * (`reason: 'timeout'`); `timeoutMs` defaults to
   * `DEFAULT_PERMISSION_TIMEOUT_MS` and may come from a caller's config.
   */
  wait(requestId: string, timeoutMs: number = DEFAULT_PERMISSION_TIMEOUT_MS): Promise<PermissionAnswer> {
    return this.requests.wait(requestId, timeoutMs, () => ({
      approved: false,
      reason: PERMISSION_TIMEOUT_REASON,
    }));
  }

  /**
   * Settle one request and report the #69 status for the responder: this
   * call settled it ('resolved'), an earlier settle already did
   * ('already-resolved' / 'expired' / 'worker-closed'), or the id was never
   * parked here ('not-found').
   */
  resolve(requestId: string, approved: boolean, reason?: string): PermissionResolutionStatus {
    const settledNow = this.requests.resolve(requestId, { approved, reason });
    if (settledNow) return 'resolved';
    return permissionStatusFromOutcome(this.requests.outcomeOf(requestId));
  }

  /** Settle every pending request as aborted (worker abort / shutdown). */
  cleanup(): void {
    this.requests.cleanupAll(() => ({ approved: false, reason: PERMISSION_ABORT_REASON }));
  }
}
