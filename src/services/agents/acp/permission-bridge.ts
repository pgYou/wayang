/**
 * ACP permission bridge (frozen §5, 04 booklet): `session/request_permission`
 * → merged-snapshot classification → `decideToolAccess` → approval memory →
 * `permission_request` signal → outcome.
 *
 * Same entry point as puppet/claude-code (`decideToolAccess` with the
 * engine-injected `WorkerAccessScope`) — ACP adds no second policy. What is
 * ACP-specific sits here: merging the request's toolCall into the shared
 * accumulator (verdicts are ALWAYS based on the merged snapshot — judging a
 * single event is a bug), mapping ACP kinds onto policy tool names, and
 * selecting the agent's answer by option KIND (optionIds are arbitrary
 * strings; the options array order is not dependable).
 *
 * fail-closed rules (frozen §5, no provider may relax them):
 *  1. missing judgement input (no kind and no shape inference, no
 *     command/path) → ask — never a silent allow;
 *  2. an option set with neither allow nor reject → outcome 'cancelled',
 *     audit `hard-denied`, protocol-mismatch log;
 *  3. transport error / process exit / timeout / abort settle as a refusal —
 *     "no answer yet" is never an allow.
 */

import type { AcpPermissionOption, AcpPermissionOutcome, AcpPermissionRequest } from '@/services/acp/types';
import { selectAllowOption, selectRejectOption } from '@/services/acp/client';
import type { SignalQueue } from '@/services/signal/signal-queue';
import type { SignalTurnLineage, PermissionRequestSignalPayload } from '@/types/index';
import type { ApprovalMemoryMode } from '@/types/config';
import type { Logger } from '@/infra/logger';
import {
  DEFAULT_PERMISSION_TIMEOUT_MS,
  PermissionTransport,
  denialSourceOf,
  reusableGrantKeys,
  type PermissionAnswer,
} from '@/services/permission/permission-transport';
import type { ApprovalMemory } from '@/services/permission/approval-memory';
import {
  auditAccessFor,
  operationForTool,
  recordPermissionAudit,
  verdictDetailSuffix,
  type PermissionOperation,
} from '@/services/permission/permission-audit';
import { decideToolAccess, type WorkerAccessScope } from '@/services/tools/permission-rules';
import { generateId } from '@/utils/id';
import type { AcpToolAccumulator, AcpToolSnapshot } from './event-mapper';
import { MCP_SERVER_NAME, type McpToolName } from './mcp-schemas';

/** Default wait for a controller answer — the shared transport constant. */

/**
 * What the blocking wait settles with — the transport's canonical answer
 * under the ACP-facing name this module's callers already use.
 */
export type AcpPermissionAnswer = PermissionAnswer;

/** Why a turn was refused (#56): the source that decides the failure wording. */
export type AcpDenialSource = 'policy' | 'timeout' | 'controller';
/** Raw refusal fields (#56); BASE assembles the structured TurnDenial. */
export interface AcpDenialInfo { source: AcpDenialSource; toolName: string; reason: string; target: string; matchedRule?: string; injectable?: boolean }

/** Everything the bridge needs, injected by BaseAcpWorker (which got it from the engine). */
export interface AcpPermissionBridgeDeps {
  /** Shared per-run accumulator — the request's toolCall is merged in before judging. */
  accumulator: AcpToolAccumulator;
  scope: WorkerAccessScope;
  signalQueue: SignalQueue;
  runContext: {
    workerId: string;
    taskId: string;
    taskTitle: string;
    workerType?: string;
    emoji?: string;
  };
  turnLineage?: SignalTurnLineage;
  /** Task-scoped approval memory (#46), engine-injected. */
  grants: ApprovalMemory;
  approvalMemory: ApprovalMemoryMode;
  logger: Logger;
  /** `config.type` — audit extension field. */
  provider: string;
  /** Wait bound for a controller answer. */
  permissionMs?: number;
  /**
   * Called when a permission is refused in the CURRENT turn (#56) with the raw
   * { source, toolName, reason, target, matchedRule } fields; BASE assembles
   * the structured TurnDenial (sanitizedTarget/key/injectable). An 'aborted'
   * settle (run teardown) is NOT a denial and never fires this.
   */
  onDenial?: (info: AcpDenialInfo) => void;
}

/** What an `ask` carries into the signal payload and the audit record. */
interface BridgeAsk {
  reason?: string;
  matchedRule?: string;
  matchedEntry?: string;
  matchedSource?: string;
  resolvedPath?: string;
  operation: PermissionOperation;
  sensitive?: boolean;
  access?: 'read' | 'write' | 'unknown';
  /** Every path the approval would cover (approval-memory reuse, #46). */
  askPaths?: string[];
}

/** How one merged snapshot reaches a policy verdict. */
type Classification =
  /** Hand the policy this tool name with these args. */
  | { type: 'policy'; toolName: string; args: Record<string, unknown>; path?: string; command?: string }
  /** Allow without consulting the policy (non-path kinds, cwd-scoped search). */
  | { type: 'direct-allow'; reason: string }
  /** Ask without consulting the policy (missing input — fail-closed rule 1). */
  | { type: 'direct-ask'; reason: string; operation: PermissionOperation };

function pathFromSnapshot(snapshot: AcpToolSnapshot): string | undefined {
  const location = snapshot.locations?.[0]?.path;
  if (typeof location === 'string' && location.length > 0) return location;
  const raw = snapshot.rawInput;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const key of ['file_path', 'path', 'filePath'] as const) {
      const value = (raw as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
  }
  return undefined;
}

function commandFromSnapshot(snapshot: AcpToolSnapshot): string | undefined {
  const raw = snapshot.rawInput;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const command = (raw as Record<string, unknown>).command;
  if (typeof command === 'string' && command.length > 0) return command;
  const cmd = (raw as Record<string, unknown>).cmd;
  if (typeof cmd === 'string' && cmd.length > 0) return cmd;
  if (Array.isArray(cmd)) return cmd.every((part) => typeof part === 'string') ? cmd.join(' ') : undefined;
  return undefined;
}

/**
 * The ONLY MCP tools exempt from approval: wayang's controller-facing tools,
 * which do no filesystem IO. An explicit enumeration on purpose — never a
 * `mcp__wayang__*` prefix test and never an `MCP_TOOLS` sweep: a tool added to
 * the registry stays behind the approval gate until it is listed HERE. The
 * element type is `McpToolName`, so renaming/removing a registry tool breaks
 * the build instead of silently drifting, and the tests cross-check every
 * entry against `MCP_TOOLS` (`mcp-schemas.ts`) at runtime.
 */
export const SAFE_WAYANG_MCP_TOOLS: ReadonlySet<McpToolName> = new Set<McpToolName>([
  'update_progress',
  'ask_controller',
]);

/**
 * Server-qualified identity of a declared tool name:
 * `mcp__wayang__update_progress` → `{ server: 'wayang', tool: 'update_progress' }`.
 * The LAST `__` separates server from tool, because a server name may itself
 * contain underscores — `mcp__wayang_other__update_progress` is server
 * `wayang_other`, not wayang. `wayang.update_progress` / `wayang-update_progress`
 * name the same server. A bare name carries no server: `undefined`, never a match.
 */
function mcpToolIdentity(name: string): { server: string; tool: string } | undefined {
  const lower = name.trim().toLowerCase();
  if (lower.startsWith('mcp__')) {
    const rest = lower.slice('mcp__'.length);
    const sep = rest.lastIndexOf('__');
    if (sep <= 0 || sep + 2 >= rest.length) return undefined;
    return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
  }
  const qualified = /^([a-z0-9_]+)[.-]([a-z0-9_]+)$/.exec(lower);
  return qualified ? { server: qualified[1], tool: qualified[2] } : undefined;
}

/**
 * The safe registry tool a snapshot claims to be: server name exactly
 * `MCP_SERVER_NAME` ('wayang') AND short name exactly in the safe set.
 *
 * Measured (0.9.4 CLI run, codebuddy): the agent never fills ACP `name` — the
 * call arrives with `kind:'other'` and the identity inside `rawInput.toolName`
 * (`{"params":{…},"toolName":"mcp__wayang__update_progress"}`). Measured again
 * (0.9.5 run): the deferred executor wraps its arguments one level deeper —
 * `rawInput.toolName` names the DISPATCHER (`"DeferExecuteTool"`) and the real
 * identity sits in `rawInput.params.toolName`, with the tool arguments either
 * nested under a second `params` or flattened beside the identity. The wrapper
 * arguments are read FIRST — they name the tool that actually runs; the outer
 * `name` last. `title` is free text and deliberately stays out of the
 * decision. The dispatcher itself is never exempt: a wrapper entry passes only
 * when the RESOLVED target is in the enumerated safe set, and an unresolvable
 * identity falls through to the fail-closed ask.
 */
function safeOwnMcpTool(snapshot: AcpToolSnapshot): McpToolName | undefined {
  const raw = snapshot.rawInput;
  const declared: unknown[] = [];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const input = raw as Record<string, unknown>;
    const inner = input.params;
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      declared.push((inner as Record<string, unknown>).toolName);
    }
    declared.push(input.toolName);
  }
  for (const candidate of [...declared, snapshot.name]) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    const identity = mcpToolIdentity(candidate);
    if (!identity || identity.server !== MCP_SERVER_NAME) continue;
    const tool = identity.tool as McpToolName;
    if (SAFE_WAYANG_MCP_TOOLS.has(tool)) return tool;
  }
  return undefined;
}

/**
 * Merged snapshot → policy tool name + args (frozen §5 table). Pure; exported
 * for unit tests. `other`/missing kind uses shape inference, and when that
 * fails the caller must NOT feed decideToolAccess (it allows every unknown
 * tool name) — it asks directly.
 */
export function classifyAcpToolCall(snapshot: AcpToolSnapshot): Classification {
  // Wayang's OWN injected MCP server (`mcp__wayang__<tool>`), but ONLY for the
  // tools explicitly registered in SAFE_WAYANG_MCP_TOOLS: controller-facing
  // tools, not filesystem IO — auto-allow. Without this, an unrecognized-tool
  // escalation would gate ask_controller itself, and an approval request that
  // can only be answered by calling the controller deadlocks the worker (same
  // rationale as cc/worker-permission.ts:159-168). Every other tool — including
  // a future `mcp__wayang__*` one and any other server's `mcp__*` — still asks.
  if (safeOwnMcpTool(snapshot) !== undefined) {
    return { type: 'direct-allow', reason: 'wayang MCP controller-facing tool' };
  }
  const kind = snapshot.kind;
  if (kind === 'fetch' || kind === 'think' || kind === 'switch_mode') {
    return { type: 'direct-allow', reason: `non-path kind "${kind}"` };
  }
  if (kind === 'execute') {
    const command = commandFromSnapshot(snapshot);
    if (command === undefined) {
      return { type: 'direct-ask', reason: 'the command could not be determined', operation: 'exec' };
    }
    return { type: 'policy', toolName: 'bash', args: { command }, command };
  }
  if (kind === 'read' || kind === 'edit' || kind === 'delete' || kind === 'move') {
    const path = pathFromSnapshot(snapshot);
    if (path === undefined) {
      return {
        type: 'direct-ask',
        reason: 'the target path could not be determined',
        operation: kind === 'read' ? 'read' : 'write',
      };
    }
    const toolName = kind === 'read' ? 'read_file' : kind === 'edit' ? 'edit_file' : 'write_file';
    return { type: 'policy', toolName, args: { path }, path };
  }
  if (kind === 'search') {
    const path = pathFromSnapshot(snapshot);
    if (path === undefined) {
      // No path = a search inside the cwd, which is inside the allowed scope
      // (pathRequired:false parity with the puppet search tools).
      return { type: 'direct-allow', reason: 'cwd-scoped search' };
    }
    return { type: 'policy', toolName: 'search_content', args: { path }, path };
  }

  // kind 'other' / missing: shape inference (04 §7).
  const command = commandFromSnapshot(snapshot);
  if (command !== undefined) {
    return { type: 'policy', toolName: 'bash', args: { command }, command };
  }
  const path = pathFromSnapshot(snapshot);
  if (path !== undefined) {
    const name = String(snapshot.name ?? '').toLowerCase();
    const inferred = /read|search|grep/.test(name) ? 'read_file' : 'write_file';
    return { type: 'policy', toolName: inferred, args: { path }, path };
  }
  // Inference failed: never feed the unknown to decideToolAccess — ask.
  return {
    type: 'direct-ask',
    reason: 'the tool kind could not be determined',
    operation: 'exec',
  };
}

/** toolName the signal/audit carry (04 §8: `toolCall.name ?? kind`). */
function bridgeToolName(snapshot: AcpToolSnapshot): string {
  return snapshot.name || snapshot.kind || 'unknown';
}

/**
 * Why an unapproved wait settled (#25): the controller denied, the wait timed
 * out, or the run was aborted (the cleanup settles pending waits). Only the
 * first is a user rejection — the triage itself is the transport's
 * `denialSourceOf`, so the audit source and the denial ledger agree with the
 * other gates.
 */
function denialSource(answer: AcpPermissionAnswer): 'timeout' | 'aborted' | 'controller' {
  return denialSourceOf(answer);
}

/** toolArgs for the signal payload: the merged rawInput, or locations when absent. */
function bridgeToolArgs(snapshot: AcpToolSnapshot): Record<string, unknown> {
  const raw = snapshot.rawInput;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return { locations: snapshot.locations ?? [] };
}

/** Description for the approval prompt, in the existing formats. */
function describeRequest(
  snapshot: AcpToolSnapshot,
  classification: Classification,
  ask: BridgeAsk | undefined,
): string {
  let detail: string;
  if (classification.type === 'policy' && classification.command !== undefined) {
    detail = `Execute shell command: ${classification.command}`;
  } else if (classification.type === 'policy' && classification.path !== undefined) {
    detail = `${bridgeToolName(snapshot)}: ${classification.path}`;
  } else {
    detail = `${bridgeToolName(snapshot)}: ${JSON.stringify(bridgeToolArgs(snapshot))}`;
  }
  const hit = ask?.sensitive
    ? verdictDetailSuffix({
        matchedRule: ask.matchedRule,
        matchedEntry: ask.matchedEntry,
        matchedSource: ask.matchedSource,
        resolvedPath: ask.resolvedPath,
        operation: ask.operation,
      })
    : '';
  const withHit = `${detail}${hit}`;
  return ask?.reason ? `${withHit} (${ask.reason})` : withHit;
}

/**
 * Build the ACP permission handler. Returns the function handed to
 * `AcpClient.onPermissionRequest`; every path ends in a concrete outcome —
 * the client writes the JSON-RPC response from it.
 *
 * `pendingPermissions` is the worker's shared `PermissionTransport`: the
 * bridge parks its asks there (the same spine the puppet middleware and the
 * Claude Code gate use) and inherits the canonical timeout settle.
 */
export function createAcpPermissionBridge(
  deps: AcpPermissionBridgeDeps,
  pendingPermissions: PermissionTransport,
): (req: AcpPermissionRequest) => Promise<AcpPermissionOutcome> {
  const permissionMs = deps.permissionMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
  const memoryEnabled = deps.approvalMemory !== 'off';
  const audit = (entry: Parameters<typeof recordPermissionAudit>[1]) =>
    recordPermissionAudit(deps.logger, { ...entry, transport: 'acp', provider: deps.provider });

  /** Emit a structured refusal (#56). An 'aborted' settle is run teardown, not a denial. */
  const emitWaitDenial = (answer: AcpPermissionAnswer, toolName: string, target: string, matchedRule?: string): void => {
    const source = denialSource(answer);
    if (source !== 'aborted') deps.onDenial?.({ source, toolName, reason: answer.reason ?? '', target, matchedRule });
  };

  const baseAuditFields = (toolName: string, snapshot: AcpToolSnapshot, classification: Classification) => ({
    taskId: deps.runContext.taskId,
    workerId: deps.runContext.workerId,
    toolName,
    operation:
      classification.type === 'policy'
        ? operationForTool(classification.toolName)
        : classification.type === 'direct-ask'
          ? classification.operation
          : 'exec', // direct-allow never audits; placeholder keeps the field total
    requestedPath:
      classification.type === 'policy' && classification.path !== undefined
        ? classification.path
        : pathFromSnapshot(snapshot),
  });

  return async (req: AcpPermissionRequest): Promise<AcpPermissionOutcome> => {
    const options: AcpPermissionOption[] = Array.isArray(req.options) ? req.options : [];

    // Input merge (frozen §5): the request's toolCall joins the accumulator —
    // the measured request carries no kind/title and a partial rawInput, so
    // judging the bare request fields would be a bug.
    const snapshot = deps.accumulator.upsert(req.toolCall);
    const toolName = bridgeToolName(snapshot);
    const classification = classifyAcpToolCall(snapshot);
    const denialTarget = classification.type === 'policy' ? (classification.command ?? classification.path ?? '<unspecified>') : (pathFromSnapshot(snapshot) ?? '<unspecified>');
    const base = baseAuditFields(toolName, snapshot, classification);

    // Helper: pick an outcome by option KIND (never by order, never by optionId).
    const outcomeFor = (want: 'allow' | 'reject', deniedAudit?: () => void): AcpPermissionOutcome => {
      const allow = selectAllowOption(options);
      const reject = selectRejectOption(options);
      if (want === 'allow') {
        if (allow) return { outcome: 'selected', optionId: allow.optionId };
        // The verdict allows but the agent offered no allow option: settle as
        // a refusal rather than executing something the agent never offered.
        if (reject) {
          deniedAudit?.();
          return { outcome: 'selected', optionId: reject.optionId };
        }
      } else {
        if (reject) {
          deniedAudit?.();
          return { outcome: 'selected', optionId: reject.optionId };
        }
        if (allow) {
          // A refusal verdict with only allow options offered cannot select
          // any of them — cancelling the request is the fail-closed answer.
          return { outcome: 'cancelled' };
        }
      }
      // Fail-closed rule 2: neither kind exists.
      audit({ ...base, decision: 'hard-denied' });
      deps.logger.warn(
        { provider: deps.provider, toolName, options: options.map((option) => option.kind) },
        'ACP permission option set has neither allow nor reject — answering cancelled (protocol-mismatch)',
      );
      return { outcome: 'cancelled' };
    };

    if (classification.type === 'direct-allow') {
      return outcomeFor('allow');
    }

    // Ask without a policy verdict (missing input — fail-closed rule 1).
    const ask: BridgeAsk =
      classification.type === 'direct-ask'
        ? { reason: classification.reason, operation: classification.operation }
        : { operation: operationForTool(classification.toolName) };

    if (classification.type === 'policy') {
      const verdict = decideToolAccess(deps.scope, classification.toolName, classification.args);

      if (verdict.decision === 'allow') {
        audit({
          ...base,
          decision: 'allowed',
          access: auditAccessFor(verdict.access),
          resolvedPath: verdict.resolvedPath,
          matchedRule: verdict.matchedRule,
          matchedEntry: verdict.matchedEntry,
          matchedSource: verdict.matchedSource,
        });
        return outcomeFor('allow');
      }

      ask.reason = verdict.reason;
      ask.matchedRule = verdict.matchedRule;
      ask.matchedEntry = verdict.matchedEntry;
      ask.matchedSource = verdict.matchedSource;
      ask.resolvedPath = verdict.resolvedPath;
      ask.sensitive = verdict.sensitive;
      ask.access = verdict.access;
      ask.askPaths = verdict.askPaths;

      if (verdict.decision === 'deny') {
        // Only sensitiveMode:'deny' produces a policy deny (04 §1). This is a
        // hard refusal by the policy itself — no controller prompt, no wait.
        audit({
          ...base,
          decision: 'hard-denied',
          access: auditAccessFor(verdict.access),
          resolvedPath: verdict.resolvedPath,
          matchedRule: verdict.matchedRule,
          matchedEntry: verdict.matchedEntry,
          matchedSource: verdict.matchedSource,
        });
        deps.onDenial?.({ source: 'policy', toolName, reason: verdict.reason ?? 'policy hard-deny', target: denialTarget, matchedRule: verdict.matchedRule });
        return outcomeFor('reject');
      }

      // Task approval memory (#46): every path this ask covers was already
      // approved for reading in THIS task → run without a prompt. The decision
      // point is here, before the request is built, so a reuse produces no
      // permission_request signal at all.
      const grantKeys = memoryEnabled ? reusableGrantKeys(verdict) : [];
      if (grantKeys.length > 0 && grantKeys.every((key) => deps.grants.has(deps.runContext.taskId, key))) {
        audit({
          ...base,
          decision: 'granted-by-memory',
          grantId: deps.grants.get(deps.runContext.taskId, grantKeys[0])?.grantId,
          access: 'read',
          resolvedPath: verdict.resolvedPath,
          matchedRule: verdict.matchedRule,
          matchedEntry: verdict.matchedEntry,
          matchedSource: verdict.matchedSource,
        });
        return outcomeFor('allow');
      }

      // Plain ask → permission_request signal → blocking wait.
      const requestId = generateId('perm');
      deps.signalQueue.enqueue({
        source: 'worker',
        type: 'permission_request',
        payload: {
          requestId,
          workerId: deps.runContext.workerId,
          taskId: deps.runContext.taskId,
          taskTitle: deps.runContext.taskTitle,
          workerType: deps.runContext.workerType,
          emoji: deps.runContext.emoji,
          toolName,
          toolArgs: bridgeToolArgs(snapshot),
          description: describeRequest(snapshot, classification, ask),
          ...(ask.matchedRule !== undefined && { matchedRule: ask.matchedRule }),
          ...(ask.matchedEntry !== undefined && { matchedEntry: ask.matchedEntry }),
          ...(ask.matchedSource !== undefined && { matchedSource: ask.matchedSource }),
          ...(ask.resolvedPath !== undefined && { resolvedPath: ask.resolvedPath }),
          ...(ask.sensitive !== undefined && { sensitive: ask.sensitive }),
          ...(ask.access !== undefined && { access: ask.access }),
          operation: ask.operation,
        } satisfies PermissionRequestSignalPayload,
        ...(deps.turnLineage ?? {}),
      });

      const result = await pendingPermissions.wait(requestId, permissionMs);

      audit({
        ...base,
        decision: result.approved ? 'approved' : 'denied',
        access: ask.access !== undefined ? auditAccessFor(ask.access) : 'unknown',
        resolvedPath: ask.resolvedPath,
        matchedRule: ask.matchedRule,
        matchedEntry: ask.matchedEntry,
        matchedSource: ask.matchedSource,
        ...(!result.approved && { source: denialSource(result) }),
      });

      if (result.approved) {
        // One grant per asking path; refusals write nothing.
        for (const key of grantKeys) {
          deps.grants.remember(deps.runContext.taskId, key, { requestId });
        }
        return outcomeFor('allow');
      }
      emitWaitDenial(result, toolName, denialTarget, ask.matchedRule);
      return outcomeFor('reject');
    }

    // direct-ask: no verdict fields to project — ask the controller directly.
    const requestId = generateId('perm');
    deps.signalQueue.enqueue({
      source: 'worker',
      type: 'permission_request',
      payload: {
        requestId,
        workerId: deps.runContext.workerId,
        taskId: deps.runContext.taskId,
        taskTitle: deps.runContext.taskTitle,
        workerType: deps.runContext.workerType,
        emoji: deps.runContext.emoji,
        toolName,
        toolArgs: bridgeToolArgs(snapshot),
        description: describeRequest(snapshot, classification, ask),
        operation: ask.operation,
      } satisfies PermissionRequestSignalPayload,
      ...(deps.turnLineage ?? {}),
    });

    const result = await pendingPermissions.wait(requestId, permissionMs);

    audit({
      ...base,
      decision: result.approved ? 'approved' : 'denied',
      access: 'unknown',
      ...(!result.approved && { source: denialSource(result) }),
    });

    if (!result.approved) emitWaitDenial(result, toolName, denialTarget, ask.matchedRule);
    return result.approved ? outcomeFor('allow') : outcomeFor('reject');
  };
}
