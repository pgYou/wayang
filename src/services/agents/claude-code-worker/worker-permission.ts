// ClaudeWorkerPermissionGate: the canUseTool permission gate — routes SDK
// tool calls through the shared access policy, emits permission_request
// signals and audits. Extends ClaudeWorkerBase.

import type { PermissionRequestSignalPayload } from '@/types/index';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import {
  auditAccessFor,
  operationForTool,
  recordPermissionAudit,
  verdictDetailSuffix,
  type PermissionOperation,
} from '@/services/permission/permission-audit';
import { decideToolAccess, type ToolAccessDecision, type WorkerAccessScope } from '@/services/tools/permission-rules';
import { generateId } from '@/utils/id';
import { homedir } from 'node:os';
import { ClaudeWorkerBase } from './worker-base';

/**
 * What an `ask` verdict contributes to the approval request and the audit.
 * Mirrors the puppet worker's payload fields so both entry points produce the
 * same request shape and the same audit record.
 */
interface PermissionAsk {
  /** Why the policy could not decide (command substitution, unknown tool, …). */
  reason?: string;
  matchedRule?: string;
  matchedEntry?: string;
  matchedSource?: string;
  resolvedPath?: string;
  operation: PermissionOperation;
  sensitive?: boolean;
  access?: 'read' | 'write' | 'unknown';
}

export class ClaudeWorkerPermissionGate extends ClaudeWorkerBase {
  private static readonly PERMISSION_TIMEOUT_MS = 300_000;

  // --- Permission control via canUseTool ---

  /**
   * SDK tool name → the canonical tool the shared permission policy judges.
   * Claude Code's file tools carry their target in a tool-specific field; this
   * maps each to one of the policy's file tool names plus the path key to read.
   * `Bash` is handled separately (its command string goes through the bash rule).
   */
  private static readonly SDK_FILE_TOOL_MAP: Record<
    string,
    { policyTool: string; pathKey: string; pathRequired: boolean }
  > = {
    Read: { policyTool: 'read_file', pathKey: 'file_path', pathRequired: true },
    Write: { policyTool: 'write_file', pathKey: 'file_path', pathRequired: true },
    Edit: { policyTool: 'edit_file', pathKey: 'file_path', pathRequired: true },
    NotebookEdit: { policyTool: 'edit_file', pathKey: 'notebook_path', pathRequired: true },
    // Search tools default to the workspace when no path is given.
    Glob: { policyTool: 'search_files', pathKey: 'path', pathRequired: false },
    Grep: { policyTool: 'search_content', pathKey: 'path', pathRequired: false },
  };

  /**
   * SDK tools that touch no filesystem path the policy could judge (todo list,
   * web access, sub-agents, MCP resources, worktrees). Their puppet counterparts
   * are not gated either, so they are allowed without an approval.
   */
  private static readonly SDK_NON_PATH_TOOLS = new Set([
    'Agent',
    'Task',
    'TaskOutput',
    'TaskStop',
    'KillShell',
    'KillTask',
    'ExitPlanMode',
    'TodoWrite',
    'WebFetch',
    'WebSearch',
    'AskUserQuestion',
    'ListMcpResources',
    'ReadMcpResource',
    'Mcp',
    'Config',
    'EnterWorktree',
    'ExitWorktree',
  ]);

  /**
   * Shared policy scope for this run. The engine injects the exact scope it
   * applies to puppet workers; when a worker is driven directly (tests), derive
   * a minimal scope from its own directory (no task allowedDirs / config — the
   * conservative reading). The home anchor is ALWAYS the process home — never
   * derived from the session layout: where wayang keeps its data has nothing
   * to do with whose home the policy protects.
   */
  private effectiveAccessScope(): WorkerAccessScope {
    if (this._accessScope) return this._accessScope;
    return { userHome: homedir(), workspace: this.workspaceDir };
  }

  /**
   * Route a Claude Code tool call through the SAME access policy a puppet
   * worker uses (`decideToolAccess`). A sensitive hit — read OR write — asks
   * the controller with the matched entry named, a refusal only happens under
   * `sensitiveMode: 'deny'`, an ambiguous target asks, and a path inside the
   * allowed scope runs immediately. This closes the parity gap where the old
   * regex-only gate let sensitive paths through silently.
   */
  protected async handleCanUseTool(toolName: string, input: Record<string, unknown>): Promise<PermissionResult> {
    // Without signal context there is nowhere to route an approval, and the run
    // uses bypassPermissions — canUseTool is never consulted in that mode.
    if (!this._signalQueue || !this._runContext) {
      return { behavior: 'allow' };
    }

    const scope = this.effectiveAccessScope();

    if (toolName === 'Bash') {
      const verdict = decideToolAccess(scope, 'bash', { command: String(input.command ?? '') });
      const operation = operationForTool('bash');
      if (verdict.decision === 'deny') return this.denyWithAudit(toolName, input, verdict, operation);
      if (verdict.decision === 'ask') return this.requestPermission(toolName, input, this.askOf(verdict, operation));
      return { behavior: 'allow' };
    }

    const fileTool = ClaudeWorkerPermissionGate.SDK_FILE_TOOL_MAP[toolName];
    if (fileTool) {
      const operation = operationForTool(fileTool.policyTool);
      const rawPath = input[fileTool.pathKey];
      if (typeof rawPath !== 'string' || rawPath.length === 0) {
        if (fileTool.pathRequired) {
          // A read/write tool with no usable target: the policy cannot judge
          // what it would touch — stay conservative and ask rather than allow.
          return this.requestPermission(toolName, input, {
            reason: 'the target path could not be determined',
            operation,
          });
        }
        // An optional-path search tool defaults to the workspace (its cwd),
        // which is inside the allowed scope.
        return { behavior: 'allow' };
      }
      const verdict = decideToolAccess(scope, fileTool.policyTool, { path: rawPath });
      if (verdict.decision === 'deny') return this.denyWithAudit(toolName, input, verdict, operation);
      if (verdict.decision === 'ask') return this.requestPermission(toolName, input, this.askOf(verdict, operation));
      return { behavior: 'allow' };
    }

    if (ClaudeWorkerPermissionGate.SDK_NON_PATH_TOOLS.has(toolName)) {
      // Nothing filesystem-related to judge — parity with the ungated puppet tools.
      return { behavior: 'allow' };
    }

    if (toolName.startsWith('mcp__wayang__')) {
      // Wayang's OWN registered MCP server (ask_controller and friends):
      // controller-facing tools, not filesystem IO — auto-allow so a worker
      // can always reach its own controller. Without this the
      // unrecognized-tool escalation below would gate ask_controller itself,
      // and an approval request that can only be answered by calling the
      // controller deadlocks the worker. Other servers' tools
      // (`mcp__other__*`) keep falling through to that escalation.
      return { behavior: 'allow' };
    }

    // Unrecognized tool: we cannot prove it stays inside the allowed scope, so
    // do not silently allow — escalate to the controller.
    return this.requestPermission(toolName, input, {
      reason: 'the tool is not recognized by the permission policy',
      operation: operationForTool('bash'),
    });
  }

  /**
   * Refuse a call the policy hard-denied (`sensitiveMode: 'deny'` on a
   * sensitive hit) and record it.
   *
   * The worker receives the policy's disclosure-safe message (its own path
   * spelling, never the matched entry); the audit trail gets the metadata.
   * Same shape as the puppet worker's audit, so both entries agree.
   */
  private denyWithAudit(
    toolName: string,
    input: Record<string, unknown>,
    verdict: ToolAccessDecision,
    operation: PermissionOperation,
  ): PermissionResult {
    recordPermissionAudit(this.logger, {
      decision: 'hard-denied',
      operation,
      access: auditAccessFor(verdict.access),
      resolvedPath: verdict.resolvedPath,
      requestedPath: this.requestedPathOf(input),
      matchedEntry: verdict.matchedEntry,
      matchedSource: verdict.matchedSource,
      matchedRule: verdict.matchedRule,
      taskId: this._runContext?.taskId,
      workerId: this._runContext?.workerId,
      toolName,
    });
    return { behavior: 'deny', message: verdict.message ?? 'Denied by the permission policy' };
  }

  /** Project a policy verdict onto the approval-request/audit fields. */
  private askOf(verdict: ToolAccessDecision, operation: PermissionOperation): PermissionAsk {
    return {
      reason: verdict.reason,
      matchedRule: verdict.matchedRule,
      matchedEntry: verdict.matchedEntry,
      matchedSource: verdict.matchedSource,
      resolvedPath: verdict.resolvedPath,
      operation,
      sensitive: verdict.sensitive,
      access: verdict.access,
    };
  }

  /** The target as the worker spelled it (for auditing against the prompt). */
  private requestedPathOf(input: Record<string, unknown>): string | undefined {
    for (const key of ['file_path', 'notebook_path', 'path']) {
      const value = input[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
    return undefined;
  }

  /**
   * Emit a permission_request and block until the controller answers (or it
   * times out → deny). Shared by every `ask` verdict so the request flow stays
   * identical to the puppet worker's.
   */
  protected async requestPermission(
    toolName: string,
    input: Record<string, unknown>,
    ask: PermissionAsk,
  ): Promise<PermissionResult> {
    if (!this._signalQueue || !this._runContext) return { behavior: 'allow' };

    const requestId = generateId('perm');
    const description = this.describePermissionRequest(toolName, input, ask);
    const operation = ask.operation;

    this._signalQueue.enqueue({
      source: 'worker',
      type: 'permission_request',
      payload: {
        requestId,
        workerId: this._runContext.workerId,
        taskId: this._runContext.taskId,
        taskTitle: this._runContext.taskTitle,
        workerType: this._runContext.workerType,
        emoji: this._runContext.emoji,
        toolName,
        toolArgs: input,
        description,
        ...(ask.matchedRule !== undefined && { matchedRule: ask.matchedRule }),
        ...(ask.matchedEntry !== undefined && { matchedEntry: ask.matchedEntry }),
        ...(ask.matchedSource !== undefined && { matchedSource: ask.matchedSource }),
        ...(ask.resolvedPath !== undefined && { resolvedPath: ask.resolvedPath }),
        ...(ask.sensitive !== undefined && { sensitive: ask.sensitive }),
        ...(ask.access !== undefined && { access: ask.access }),
        operation,
      } satisfies PermissionRequestSignalPayload,
      ...this._turnLineage,
    });

    const result = await this._pendingPermissions.wait(
      requestId,
      ClaudeWorkerPermissionGate.PERMISSION_TIMEOUT_MS,
      () => ({ behavior: 'deny', message: 'Permission request timed out' }) as PermissionResult,
    );

    // Audit approvals AND refusals with the same fields the puppet worker
    // uses — one record per gated call, no file content.
    const denied = result.behavior === 'deny';
    recordPermissionAudit(this.logger, {
      decision: denied ? 'denied' : 'approved',
      operation,
      access: auditAccessFor(ask.access),
      resolvedPath: ask.resolvedPath,
      requestedPath: this.requestedPathOf(input),
      matchedEntry: ask.matchedEntry,
      matchedSource: ask.matchedSource,
      matchedRule: ask.matchedRule,
      taskId: this._runContext.taskId,
      workerId: this._runContext.workerId,
      toolName,
      ...(denied && {
        source: result.message === 'Permission request timed out' ? ('timeout' as const) : ('controller' as const),
      }),
    });
    return result;
  }

  /** Human-readable summary of a gated call for the approval prompt. */
  private describePermissionRequest(
    toolName: string,
    input: Record<string, unknown>,
    ask: PermissionAsk,
  ): string {
    let detail: string;
    if (toolName === 'Bash') {
      detail = `Execute shell command: ${String(input.command ?? '')}`;
    } else if (typeof input.file_path === 'string') {
      detail = `${toolName}: ${input.file_path}`;
    } else if (typeof input.notebook_path === 'string') {
      detail = `${toolName}: ${input.notebook_path}`;
    } else if (typeof input.path === 'string') {
      detail = `${toolName}: ${input.path}`;
    } else {
      detail = `${toolName}: ${JSON.stringify(input)}`;
    }
    // Hit detail (entry + rule + op) first, so the controller sees WHAT matched
    // even when a non-obvious escalation reason is appended as well. Only on a
    // sensitive hit — ordinary asks keep their existing wording.
    const hit = ask.sensitive ? verdictDetailSuffix({
      matchedRule: ask.matchedRule,
      matchedEntry: ask.matchedEntry,
      matchedSource: ask.matchedSource,
      resolvedPath: ask.resolvedPath,
      operation: ask.operation,
    }) : '';
    const withHit = `${detail}${hit}`;
    return ask.reason ? `${withHit} (${ask.reason})` : withHit;
  }
}
