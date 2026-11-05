/**
 * ACP (Agent Client Protocol) v1 type subset — only the shapes wayang consumes.
 *
 * Contract: docs/design/acp/00-interface-freeze.md §1/§2.3. This module is the
 * leaf of the acp dependency graph: it must not import any other acp module,
 * nor anything from `@/services/agents/**` or `@/types/config` (layering ban).
 *
 * `AcpSessionUpdate` keeps precise members for the 7 variants wayang maps in
 * the worker layer, plus a catch-all row for the remaining official variants
 * (available_commands_update / current_mode_update / config_option_update /
 * session_info_update / notice / compaction_update / compaction_summary_chunk)
 * and any vendor variant — all of them are still dispatched to `onUpdate`;
 * ignoring happens in the worker's event mapper.
 */

export type AcpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'resource_link'; name: string; uri: string };

export interface AcpMcpServer {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export type AcpStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled';

export type AcpToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

export type AcpToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type AcpPermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always';

export interface AcpToolCall {
  /** Field-measured: the first event may arrive with empty rawInput and kind 'other'; the same id can be re-sent in full later. */
  toolCallId: string;
  title: string;
  name?: string | null;
  kind?: AcpToolKind;
  status?: AcpToolStatus;
  content?: AcpToolCallContent[];
  locations?: { path: string; line?: number | null }[];
  rawInput?: unknown;
  /** Field-measured: a single object `{type:'text',text}`, not a block array. */
  rawOutput?: unknown;
}

/** All fields except toolCallId are optional; null/absent means "unchanged"; content/locations/rawInput/rawOutput use overwrite semantics. */
export interface AcpToolCallUpdate {
  toolCallId: string;
  title?: string | null;
  name?: string | null;
  kind?: AcpToolKind | null;
  status?: AcpToolStatus | null;
  content?: AcpToolCallContent[] | null;
  locations?: { path: string; line?: number | null }[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
}

export type AcpToolCallContent =
  | { type: 'content'; content: AcpContentBlock }
  | { type: 'diff'; path: string; oldText?: string; newText: string }
  | { type: 'terminal'; terminalId: string };

export type AcpSessionUpdate =
  | {
      sessionUpdate: 'user_message_chunk' | 'agent_message_chunk' | 'agent_thought_chunk';
      content: AcpContentBlock;
      messageId?: string | null;
    }
  | ({ sessionUpdate: 'tool_call' } & AcpToolCall)
  | ({ sessionUpdate: 'tool_call_update' } & AcpToolCallUpdate)
  | { sessionUpdate: 'plan'; entries: { content: string; priority?: string; status?: string }[] }
  | {
      sessionUpdate: 'usage_update';
      used: number;
      size: number;
      cost?: { amount: number; currency: string } | null;
    }
  | { sessionUpdate: string; [k: string]: unknown };

export interface AcpPermissionRequest {
  sessionId: string;
  toolCall: AcpToolCallUpdate;
  options: AcpPermissionOption[];
}

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: AcpPermissionOptionKind;
}

export type AcpPermissionOutcome =
  | { outcome: 'selected'; optionId: string }
  | { outcome: 'cancelled' };

export interface AcpAuthMethod {
  id: string;
  name: string;
  description?: string | null;
}

/** Official v1 fields plus `raw` preserving vendor extensions verbatim. */
export interface AcpAgentCapabilities {
  loadSession: boolean;
  promptCapabilities?: { image?: boolean; embeddedContext?: boolean } | null;
  mcpCapabilities?: { http?: boolean; sse?: boolean } | null;
  raw: unknown;
}

export interface AcpClientCapabilities {
  fs: { readTextFile: boolean; writeTextFile: boolean };
  terminal: boolean;
  auth: { terminal: boolean };
}

export interface AcpHandshake {
  /** Anything other than 1 is classified as 'protocol-mismatch'. */
  protocolVersion: number;
  agentCapabilities: AcpAgentCapabilities;
  authMethods: AcpAuthMethod[];
  agentInfo?: { name: string; title?: string; version: string } | null;
}

/** `raw` is the full result object; vendor fields pass through uninterpreted. */
export interface AcpTurnResult {
  stopReason: AcpStopReason;
  raw: unknown;
}

export type AcpCloseReason = 'run-finished' | 'cancel' | 'shutdown' | 'crash';

export interface AcpExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Any exit not initiated by close() is reported as 'crash'. */
  reason: AcpCloseReason;
  /** True on the cancel path, to distinguish cancellation from a crash. */
  cancelled: boolean;
}

/** Stable capability view for upper layers; built by `buildAcpCapabilities`. */
export interface AcpCapabilities {
  provider: string;
  protocolVersion: number;
  /** Constantly true: session/update streaming exists by protocol definition. */
  streaming: true;
  toolCalls: boolean;
  permissionRequests: boolean;
  loadSession: boolean;
  /** 0.9.0 placeholders — semantics made explicit. */
  midTurnInject: false;
  inquiry: false;
  authMethods: AcpAuthMethod[];
}
