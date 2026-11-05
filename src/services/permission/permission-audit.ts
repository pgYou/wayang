/**
 * Structured permission audit trail.
 *
 * Every permission decision that required the controller (approved / denied)
 * and every hard refusal (`sensitiveMode: 'deny'` on a sensitive hit) is written
 * to the session's pino log with `audit: 'permission'`, so the trail can be
 * filtered out of the regular application log:
 *
 *   grep '"audit":"permission"' ~/.wayang/sessions/<id>/wayang.log
 *
 * The record carries METADATA only — canonical path, matched sensitive entry,
 * task/worker identity, tool category (`operation`), judged direction
 * (`access`), decision, timestamp. It never carries file
 * content, tool output or token values: an audit trail that quotes the secret
 * it protected is a second leak. `recordPermissionAudit` therefore builds the
 * object from an explicit field allowlist instead of forwarding caller-supplied
 * extras.
 *
 * That stance holds for `allowed` too, which is written on the policy's allow
 * fast path: the DECISION is observable (which rule allowed it, which path it
 * judged, which tool and task), the CONTENT is not. An allowing record names no
 * command text — a bash line that allowed records its judged target (if any),
 * never the command string — so "the gate decided" and "here is what the worker
 * ran" stay separate questions.
 *
 * This is deliberately NOT a conversation transcript: audit records never enter
 * the worker/controller context (they would eat the context budget and pollute
 * business output).
 */

import type { Logger } from '@/infra/logger';

/**
 * The tool CATEGORY the call belongs to (`bash` runs commands, file tools read
 * or write one path). Deliberately NOT the direction of a single target — see
 * `PermissionAccess` for that.
 */
export type PermissionOperation = 'read' | 'write' | 'exec';

/**
 * The access DIRECTION the policy actually judged the call under, recorded next
 * to — never instead of — `operation`: a bash command is `operation: 'exec'`
 * whatever it does to its arguments, while `access` says whether the verdict
 * was reached as a read, a write, or without a usable candidate (`unknown`).
 * Without it an audit of `cat ~/.ssh/id_rsa` and `tee ~/.ssh/x` looked
 * identical.
 */
export type PermissionAccess = 'read' | 'write' | 'unknown';

/**
 * The decision being recorded.
 * - `allowed`      — the policy allowed the call outright: no controller was
 *                    asked, the tool ran immediately. The majority decision on
 *                    the happy path, and the one that made the trail look
 *                    incomplete when only the asks were recorded: "the gate
 *                    never saw this call" and "the gate allowed it" are
 *                    different stories about the same silence.
 * - `approved`     — the controller approved an `ask` verdict
 * - `denied`       — the controller refused (or the request timed out / aborted)
 * - `hard-denied`  — the policy refused without asking (`sensitiveMode: 'deny'`
 *                    on a sensitive hit; the default mode asks instead)
 * - `granted-by-memory` — the call asked, but a grant recorded earlier in the
 *                    SAME task already covered every path it needed, so no
 *                    `permission_request` was emitted. `grantId` names that
 *                    earlier approval (issue #46). Reads only — a write and a
 *                    sensitive hit always ask again.
 */
export type PermissionAuditDecision =
  | 'allowed'
  | 'approved'
  | 'denied'
  | 'hard-denied'
  | 'granted-by-memory';

/** Why an `ask` ended the way it did (only meaningful for `denied`). */
export type PermissionAuditSource = 'controller' | 'timeout' | 'aborted';

export interface PermissionAuditEntry {
  /** Canonical (realpath-normalized) target the decision was made about. */
  resolvedPath?: string;
  /** The path/target as the caller spelled it — for cross-referencing prompts. */
  requestedPath?: string;
  /** Sensitive-list entry that matched, when the decision came from that list. */
  matchedEntry?: string;
  /** Which sensitive rule produced the hit (`segment`, `config-dir`, …). */
  matchedSource?: string;
  /**
   * Policy rule that produced the verdict (`sensitive-list`, …). The DIRECTION
   * of a sensitive hit is not encoded here — it is the separate `access` field,
   * so one rule name covers both reads and writes.
   */
  matchedRule?: string;
  /** Task this call belongs to. */
  taskId?: string;
  /** Worker that made the call, when known. */
  workerId?: string;
  /** Gated tool name (`read_file`, `bash`, …). */
  toolName?: string;
  /** Tool category of the call (`bash` → exec, file tools → read/write). */
  operation: PermissionOperation;
  /**
   * The direction the policy used (read / write / `unknown` when no candidate
   * could be judged). Missing on records written before this field existed;
   * every current call site passes it.
   */
  access?: PermissionAccess;
  /** The recorded verdict. */
  decision: PermissionAuditDecision;
  /** Set on `denied`: who/what ended the request. */
  source?: PermissionAuditSource;
  /**
   * Set on `granted-by-memory`: the grant whose earlier approval let this call
   * run unprompted. An id, never content — the trail says WHICH decision this
   * one inherited, not what was read.
   */
  grantId?: string;
}

/** Operation implied by a gated tool name (`bash` runs commands). */
export function operationForTool(toolName: string): PermissionOperation {
  if (toolName === 'bash') return 'exec';
  if (toolName === 'read_file' || toolName === 'search_files' || toolName === 'search_content') return 'read';
  return 'write';
}

/**
 * The `access` value for an audit record: the direction the policy used, or
 * `unknown` when it never got one (no path candidate, an unparsable command, an
 * unrecognized tool). Kept separate from `operationForTool`: the tool category
 * and the judged direction answer different questions and must not overwrite
 * each other.
 */
export function auditAccessFor(access: PermissionAccess | undefined): PermissionAccess {
  return access ?? 'unknown';
}

/**
 * Append one audit record to the session log.
 *
 * The field list is fixed: anything else a caller might be holding (tool args,
 * file content, tool output) is structurally excluded. A missing logger is a
 * no-op — auditing must never break the tool path it observes.
 */
export function recordPermissionAudit(logger: Logger | undefined, entry: PermissionAuditEntry): void {
  if (!logger) return;
  logger.info(
    {
      audit: 'permission',
      decision: entry.decision,
      operation: entry.operation,
      ...(entry.access !== undefined && { access: entry.access }),
      ts: new Date().toISOString(),
      ...(entry.resolvedPath !== undefined && { resolvedPath: entry.resolvedPath }),
      ...(entry.requestedPath !== undefined && { requestedPath: entry.requestedPath }),
      ...(entry.matchedEntry !== undefined && { matchedEntry: entry.matchedEntry }),
      ...(entry.matchedSource !== undefined && { matchedSource: entry.matchedSource }),
      ...(entry.matchedRule !== undefined && { matchedRule: entry.matchedRule }),
      ...(entry.taskId !== undefined && { taskId: entry.taskId }),
      ...(entry.workerId !== undefined && { workerId: entry.workerId }),
      ...(entry.toolName !== undefined && { toolName: entry.toolName }),
      ...(entry.source !== undefined && { source: entry.source }),
      ...(entry.grantId !== undefined && { grantId: entry.grantId }),
    },
    'permission audit',
  );
}

/** The subset of a policy verdict the approval description is built from. */
export interface VerdictDetail {
  matchedRule?: string;
  matchedEntry?: string;
  matchedSource?: string;
  resolvedPath?: string;
  operation?: PermissionOperation;
}

/**
 * `[hit: .ssh (segment) ; rule: sensitive-list ; op: read]` — appended to an
 * approval request description so the controller can see WHAT matched and
 * WHERE, instead of a bare tool call. Metadata only: never the file content.
 */
export function verdictDetailSuffix(detail: VerdictDetail): string {
  const parts: string[] = [];
  if (detail.matchedEntry) {
    parts.push(`hit: ${detail.matchedEntry}${detail.matchedSource ? ` (${detail.matchedSource})` : ''}`);
  }
  if (detail.matchedRule) parts.push(`rule: ${detail.matchedRule}`);
  if (detail.operation) parts.push(`op: ${detail.operation}`);
  return parts.length > 0 ? ` [${parts.join(' ; ')}]` : '';
}
