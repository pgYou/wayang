/**
 * Structured permission audit trail.
 *
 * Every permission decision that required the controller (approved / denied)
 * and every hard refusal (sensitive write, `sensitiveMode: 'deny'`) is written
 * to the session's pino log with `audit: 'permission'`, so the trail can be
 * filtered out of the regular application log:
 *
 *   grep '"audit":"permission"' ~/.wayang/sessions/<id>/wayang.log
 *
 * The record carries METADATA only — canonical path, matched sensitive entry,
 * task/worker identity, operation, decision, timestamp. It never carries file
 * content, tool output or token values: an audit trail that quotes the secret
 * it protected is a second leak. `recordPermissionAudit` therefore builds the
 * object from an explicit field allowlist instead of forwarding caller-supplied
 * extras.
 *
 * This is deliberately NOT a conversation transcript: audit records never enter
 * the worker/controller context (they would eat the context budget and pollute
 * business output).
 */

import type { Logger } from '@/infra/logger';

/** What the audited call would do with the target. */
export type PermissionOperation = 'read' | 'write' | 'exec';

/**
 * The decision being recorded.
 * - `approved`     — the controller approved an `ask` verdict
 * - `denied`       — the controller refused (or the request timed out / aborted)
 * - `hard-denied`  — the policy refused without asking (sensitive write,
 *                    `sensitiveMode: 'deny'`)
 */
export type PermissionAuditDecision = 'approved' | 'denied' | 'hard-denied';

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
  /** Policy rule that produced the verdict (`sensitive-list-write`, …). */
  matchedRule?: string;
  /** Task this call belongs to. */
  taskId?: string;
  /** Worker that made the call, when known. */
  workerId?: string;
  /** Gated tool name (`read_file`, `bash`, …). */
  toolName?: string;
  /** What the call would do with the target. */
  operation: PermissionOperation;
  /** The recorded verdict. */
  decision: PermissionAuditDecision;
  /** Set on `denied`: who/what ended the request. */
  source?: PermissionAuditSource;
}

/** Operation implied by a gated tool name (`bash` runs commands). */
export function operationForTool(toolName: string): PermissionOperation {
  if (toolName === 'bash') return 'exec';
  if (toolName === 'read_file' || toolName === 'search_files' || toolName === 'search_content') return 'read';
  return 'write';
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
