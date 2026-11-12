import type { Logger } from '@/infra/logger';
import { DEFAULT_APPROVAL_MEMORY } from '@/infra/permission/permission-config';
import type { SignalQueue } from '@/services/signal/signal-queue';
import type { ApprovalMemoryMode } from '@/types/config';
import type { SignalTurnLineage } from '@/types/index';
import {
  DEFAULT_PERMISSION_TIMEOUT_MS,
  PermissionTransport,
  denialSourceOf,
  permissionRefusalText,
  reusableGrantKeys,
  type PermissionResolutionStatus,
} from '@/services/permission/permission-transport';
import { sharedApprovalMemory, type ApprovalMemory } from '@/services/permission/approval-memory';
import {
  auditAccessFor,
  operationForTool,
  recordPermissionAudit,
  verdictDetailSuffix,
} from '@/services/permission/permission-audit';

/** What a gated tool call needs before it may run. */
export interface PermissionVerdict {
  /** `allow` runs immediately, `ask` requests controller approval, `deny` refuses outright. */
  decision: 'allow' | 'ask' | 'deny';
  /**
   * Present on `deny`: the message returned to the caller instead of running
   * the tool. The policy layer builds it so it can control disclosure.
   */
  message?: string;
  /**
   * Present on `ask` when the policy escalated for a non-obvious reason (e.g.
   * "command substitution", "output redirection"). Appended to the approval
   * description so the controller understands why it is being asked.
   */
  reason?: string;
  /** Rule that produced the verdict — carried onto the signal and the audit. */
  matchedRule?: string;
  /** Sensitive-list entry that matched (never disclosed to the worker). */
  matchedEntry?: string;
  /** Which sensitive rule produced the hit. */
  matchedSource?: string;
  /** Canonical target the verdict was made about. */
  resolvedPath?: string;
  /** What the call would do with the target. */
  operation?: 'read' | 'write' | 'exec';
  /** True when the verdict came from the sensitive list. */
  sensitive?: boolean;
  /** How the target was judged (read / write / unknown). */
  access?: 'read' | 'write' | 'unknown';
  /**
   * Canonical paths this call asks approval FOR (see
   * `ToolAccessDecision.askPaths`). The task approval memory keys grants per
   * `direction:path`, so every one of them must already be granted before the
   * call is let through without a prompt.
   */
  askPaths?: string[];
}

export interface PermissionMiddlewareConfig {
  /** Tool names that may require permission before execution. */
  gatedTools: string[];
  /**
   * Decide what a specific tool call needs.
   * `allow` passes through, `ask` blocks until the controller answers,
   * `deny` fails the call without ever emitting a permission_request.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- args shape is tool-specific (public config surface; policy callbacks read fields defensively)
  decide: (toolName: string, args: any) => PermissionVerdict;
  /**
   * Generate a human-readable description of the tool call.
   *
   * The `verdict` is passed along so the description can name the path the
   * policy actually JUDGED (`verdict.resolvedPath`) instead of re-deriving one
   * from the raw arguments — re-deriving is what used to print
   * `<workspace>/~/.wayang.config.json` for `~/.wayang.config.json`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as decide: tool-specific arg shape
  describeCall: (toolName: string, args: any, verdict?: PermissionVerdict) => string;
}

export interface PermissionMiddlewareDeps {
  workerId: string;
  taskId: string;
  taskTitle: string;
  workerType?: string;
  emoji?: string;
  signalQueue: SignalQueue;
  timeoutMs?: number;
  /** Turn lineage attached to emitted permission_request signals. */
  turnLineage?: SignalTurnLineage;
  /** Session logger for the permission audit trail (metadata only). */
  logger?: Logger;
  /**
   * `permission.approvalMemory` (default `'task'`). `'off'` disables the whole
   * grant path: no lookup, no writes, byte-for-byte the pre-#46 behaviour.
   */
  approvalMemory?: ApprovalMemoryMode;
  /**
   * Where per-task read grants live. The engine injects its per-session store
   * (`TaskExecuteEngine.approvalGrants`) and clears a task's slice on the
   * terminal transitions; without an injection a shared process-wide store is
   * used, which keeps a standalone middleware usable.
   */
  grants?: ApprovalMemory;
}

/**
 * The grants a verdict may reuse, the five-state vocabulary, the deny texts
 * and the permission wait bound live in the shared transport module
 * (permission-transport.ts, issues #46/#58/#69) — the same spine serves the
 * ACP bridge and the Claude Code gate, so no per-gate copy of any of them
 * exists anywhere.
 */

export interface PermissionMiddlewareResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors wrapWithPermissionMiddleware's tools param (heterogeneous tool set)
  wrappedTools: Record<string, any>;
  resolvePermission: (
    requestId: string,
    approved: boolean,
    reason?: string,
  ) => PermissionResolutionStatus;
  cleanup: () => void;
}

export function wrapWithPermissionMiddleware(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous tool set (zod-inferred per tool); see common.ts relaxation boundary
  tools: Record<string, any>,
  config: PermissionMiddlewareConfig,
  deps: PermissionMiddlewareDeps,
): PermissionMiddlewareResult {
  // The transport owns the pending registry, the timeout settle and the #69
  // status bookkeeping (see permission-transport.ts) — the same spine the ACP
  // bridge and the Claude Code gate wait on, instead of a per-gate Map.
  const transport = new PermissionTransport();
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
  const gatedSet = new Set(config.gatedTools);
  const memoryEnabled = (deps.approvalMemory ?? DEFAULT_APPROVAL_MEMORY) === 'task';
  const grants = deps.grants ?? sharedApprovalMemory;

  const wrappedTools = { ...tools };

  for (const toolName of Object.keys(tools)) {
    if (!gatedSet.has(toolName)) continue;

    const originalExecute = tools[toolName].execute;
    wrappedTools[toolName] = {
      ...tools[toolName],
      execute: async (args: Record<string, unknown>, options?: unknown) => {
        const verdict = config.decide(toolName, args);

        // Fast path: the policy allows this specific call outright. It is still
        // a DECISION, so it is audited like every other one — recording only
        // the asks made the trail read as if the gate had never seen the call
        // it allowed. Metadata only, exactly like the other records: rule,
        // judged direction, canonical path, tool/task/worker identity. The
        // command text is NOT recorded (this module's stance): the decision is
        // observable, the content is not.
        if (verdict.decision === 'allow') {
          recordPermissionAudit(deps.logger, {
            decision: 'allowed',
            operation: verdict.operation ?? operationForTool(toolName),
            access: auditAccessFor(verdict.access),
            resolvedPath: verdict.resolvedPath,
            matchedRule: verdict.matchedRule,
            taskId: deps.taskId,
            workerId: deps.workerId,
            toolName,
          });
          return originalExecute(args, options);
        }

        // Hard refusal (reached only when the user configured
        // `sensitiveMode: 'deny'`): never ask, never execute — but always
        // audit. A sensitive hit under the default mode arrives as `ask`.
        if (verdict.decision === 'deny') {
          recordPermissionAudit(deps.logger, {
            decision: 'hard-denied',
            operation: verdict.operation ?? operationForTool(toolName),
            access: auditAccessFor(verdict.access),
            resolvedPath: verdict.resolvedPath,
            requestedPath: typeof args.path === 'string' ? args.path : undefined,
            matchedEntry: verdict.matchedEntry,
            matchedSource: verdict.matchedSource,
            matchedRule: verdict.matchedRule,
            taskId: deps.taskId,
            workerId: deps.workerId,
            toolName,
          });
          return verdict.message ?? `[ERROR] ${toolName}: refused by the path permission policy`;
        }

        // Task approval memory (#46): when every path this call asks about was
        // already approved for reading in THIS task, it runs without a prompt.
        // The decision point is deliberately HERE — before the request is built
        // and enqueued — so a reuse produces no `permission_request` at all;
        // the controller only sees the effect in the worker's transcript and in
        // the audit trail below.
        //
        // `permission.approvalMemory: 'off'` short-circuits the whole feature:
        // no keys are derived, so neither the lookup below nor the write after
        // an approval can happen.
        const grantKeys = memoryEnabled ? reusableGrantKeys(verdict) : [];
        if (grantKeys.length > 0 && grantKeys.every((key) => grants.has(deps.taskId, key))) {
          const hitOperation = verdict.operation ?? operationForTool(toolName);
          recordPermissionAudit(deps.logger, {
            decision: 'granted-by-memory',
            grantId: grants.get(deps.taskId, grantKeys[0])?.grantId,
            operation: hitOperation,
            // `reusableGrantKeys` only ever returns read keys, so the record
            // can state the direction plainly.
            access: 'read',
            resolvedPath: verdict.resolvedPath,
            requestedPath: typeof args.path === 'string' ? args.path : undefined,
            matchedEntry: verdict.matchedEntry,
            matchedSource: verdict.matchedSource,
            matchedRule: verdict.matchedRule,
            taskId: deps.taskId,
            workerId: deps.workerId,
            toolName,
          });
          return originalExecute(args, options);
        }

        // A duplicate id would orphan the first waiter: the pending entry it
        // overwrote would lose its resolver, so only its own timeout timer
        // could ever release it — the "not found, worker stuck" shape of
        // issue #69. The transport's id generator retries a collision with a
        // fresh id instead (see `PermissionTransport.newRequestId`).
        const requestId = transport.newRequestId();
        const operation = verdict.operation ?? operationForTool(toolName);
        const baseDescription = config.describeCall(toolName, args, verdict);
        // Surface a non-obvious escalation reason (command substitution,
        // output redirection, …) and — on a sensitive hit — the entry and rule
        // that fired, so the controller can judge the request without reading
        // the file. Ordinary out-of-scope asks keep their existing wording.
        const hitDetail = verdict.sensitive
          ? verdictDetailSuffix({
              matchedRule: verdict.matchedRule,
              matchedEntry: verdict.matchedEntry,
              matchedSource: verdict.matchedSource,
              resolvedPath: verdict.resolvedPath,
              operation,
            })
          : '';
        const description = `${baseDescription}${hitDetail}${
          verdict.reason ? ` [reason: ${verdict.reason}]` : ''
        }`;

        deps.signalQueue.enqueue({
          source: 'worker',
          type: 'permission_request',
          payload: {
            requestId,
            workerId: deps.workerId,
            taskId: deps.taskId,
            taskTitle: deps.taskTitle,
            workerType: deps.workerType,
            emoji: deps.emoji,
            toolName,
            toolArgs: args,
            description,
            ...(verdict.matchedRule !== undefined && { matchedRule: verdict.matchedRule }),
            ...(verdict.matchedEntry !== undefined && { matchedEntry: verdict.matchedEntry }),
            ...(verdict.matchedSource !== undefined && { matchedSource: verdict.matchedSource }),
            ...(verdict.resolvedPath !== undefined && { resolvedPath: verdict.resolvedPath }),
            ...(verdict.sensitive !== undefined && { sensitive: verdict.sensitive }),
            ...(verdict.access !== undefined && { access: verdict.access }),
            operation,
          },
          ...(deps.turnLineage ?? {}),
        });

        const result = await transport.wait(requestId, timeoutMs);

        // Audit BEFORE executing: the record must exist even if the tool then
        // crashes, and a denied call must leave the same trail as an approved
        // one (approvals are exactly what an audit needs to catch).
        recordPermissionAudit(deps.logger, {
          decision: result.approved ? 'approved' : 'denied',
          operation,
          access: auditAccessFor(verdict.access),
          resolvedPath: verdict.resolvedPath,
          requestedPath: typeof args.path === 'string' ? args.path : undefined,
          matchedEntry: verdict.matchedEntry,
          matchedSource: verdict.matchedSource,
          matchedRule: verdict.matchedRule,
          taskId: deps.taskId,
          workerId: deps.workerId,
          toolName,
          ...(!result.approved && { source: denialSourceOf(result) }),
        });

        // An approval of a READ that is not sensitive opens one grant per
        // asking path, so the same path inside this task asks no further. A
        // denial writes nothing (a refusal is a decision about this request,
        // not a standing answer), and writes / sensitive hits never get here
        // because `reusableGrantKeys` returned no keys for them.
        if (result.approved) {
          for (const key of grantKeys) {
            grants.remember(deps.taskId, key, { requestId });
          }
        }

        if (!result.approved) {
          return permissionRefusalText(toolName, result);
        }

        return originalExecute(args, options);
      },
    };
  }

  return {
    wrappedTools,
    // Settle + #69 status in one call — the transport reports 'resolved' or the
    // terminal state an earlier settle left ('already-resolved' / 'expired' /
    // 'worker-closed'), and answers 'not-found' for an id this gate never knew.
    resolvePermission: (requestId, approved, reason) => transport.resolve(requestId, approved, reason),
    cleanup: (): void => {
      transport.cleanup();
    },
  };
}
