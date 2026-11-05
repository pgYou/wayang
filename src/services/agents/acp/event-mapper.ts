/**
 * session/update → wayang event mapping (frozen §3).
 *
 * Pure functions only: no transport, no state writes, no signals. The worker
 * layer feeds every `session/update` through `mapSessionUpdate` and persists
 * whatever comes out; the permission bridge reuses the SAME accumulator for
 * its merge-before-judging rule (frozen §5) so verdicts and transcripts are
 * always based on the merged tool-call snapshot, never on a single event.
 *
 * Accumulation semantics (frozen §2.3, measured codebuddy behavior):
 * - `tool_call` is a full snapshot; a same-id resend overwrites every field
 *   it carries (the measured stream sends an empty-rawInput/kind:'other'
 *   first event, then a full resend with kind corrected to 'execute').
 * - `tool_call_update` merges incrementally: null/undefined means "keep the
 *   previous value", a present value replaces it.
 * - The FIRST snapshot for an id produces NO record — its rawInput may be
 *   empty and its kind 'other'; records wait until the snapshot is mature
 *   (resend or terminal update) or the turn ends (flushUnsettled).
 */

import type { AcpContentBlock, AcpSessionUpdate, AcpToolCall, AcpToolCallContent, AcpToolCallUpdate, AcpToolKind, AcpToolStatus } from '@/services/acp/types';
import type { ToolCallRecord, ToolResultRecord } from '@/types/index';
import { nowISO } from '@/utils/time';
import { toolPayloadText } from '../utils/estimate-tokens';
import {
  CLAUDE_TOOL_ARGS_STORE_CHARS,
  CLAUDE_TOOL_RESULT_STORE_CHARS,
  truncateForStorage,
} from '../utils/claude-tool-records';
import { clampToolOutput } from '../utils/tool-output-clamp';

/**
 * Merged per-toolCallId snapshot — the single source both the permission
 * bridge (verdicts) and the transcript writer (records) read from. `status`
 * widens with 'cancelled': the protocol's own status enum has no cancelled
 * value, so the end-of-turn flush marks unsettled calls with it (02 §5).
 */
export interface AcpToolSnapshot {
  toolCallId: string;
  title: string;
  name?: string | null;
  kind?: AcpToolKind;
  status?: AcpToolStatus | 'cancelled';
  content?: AcpToolCallContent[];
  locations?: { path: string; line?: number | null }[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

/** Frozen §3 accumulator contract: `byToolCallId` upsert + end-of-turn flush. */
export interface AcpToolAccumulator {
  upsert(u: AcpToolCall | AcpToolCallUpdate): AcpToolSnapshot;
  flushUnsettled(): AcpToolSnapshot[];
  /** Read-only view of the merged snapshot for a toolCallId (frozen §5 input merge). */
  peek(toolCallId: string): AcpToolSnapshot | undefined;
}

/** Frozen §3 mapped-event union. */
export type AcpMappedEvent =
  | { kind: 'agent-text'; text: string; messageId: string | null }
  | { kind: 'progress'; text: string }
  | { kind: 'tool-call'; record: ToolCallRecord }
  | { kind: 'tool-result'; record: ToolResultRecord }
  | { kind: 'runtime-state'; key: 'plan' | 'usage'; value: unknown }
  | { kind: 'ignored'; variant: string; reason: string };

/** session/update variants wayang deliberately renders nothing for. */
const IGNORED_VARIANTS: ReadonlyMap<string, string> = new Map([
  ['available_commands_update', 'no-render'],
  ['current_mode_update', 'no-render'],
  ['config_option_update', 'no-render'],
  ['session_info_update', 'no-render'],
  ['notice', 'no-render'],
  ['compaction_update', 'no-render'],
  ['compaction_summary_chunk', 'no-render'],
]);

/** ToolCallRecord.status for a snapshot status (frozen §3 comment). */
function recordStatus(status: AcpToolSnapshot['status']): 'running' | 'succeeded' | 'failed' | 'cancelled' {
  if (status === 'completed') return 'succeeded';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  return 'running'; // pending | in_progress | undefined
}

/** Terminal protocol statuses — 'cancelled' only ever comes from the flush. */
function isTerminal(snapshot: AcpToolSnapshot): boolean {
  return snapshot.status === 'completed' || snapshot.status === 'failed';
}

/** Display name for a tool call: the agent's tool name, else its kind, else a placeholder. */
export function snapshotToolName(snapshot: AcpToolSnapshot): string {
  return snapshot.name || snapshot.kind || 'unknown';
}

/**
 * Merge one tool_call / tool_call_update into a snapshot. Field-level rules:
 * undefined/null keeps the previous value, a present value replaces it. This
 * single rule yields both frozen §2.3 semantics — a `tool_call` resend
 * overwrites every field it carries (full snapshot), an update merges
 * incrementally.
 */
function mergeSnapshot(prev: AcpToolSnapshot | undefined, u: AcpToolCall | AcpToolCallUpdate): AcpToolSnapshot {
  const base: AcpToolSnapshot = prev ?? {
    toolCallId: u.toolCallId,
    title: (u as AcpToolCall).title ?? '',
  };
  const next: AcpToolSnapshot = { ...base };
  const title = (u as AcpToolCall).title;
  if (typeof title === 'string' && title.length > 0) next.title = title;
  if (u.name !== undefined && u.name !== null) next.name = u.name;
  if (u.kind !== undefined && u.kind !== null) next.kind = u.kind;
  if (u.status !== undefined && u.status !== null) next.status = u.status;
  if (u.content !== undefined && u.content !== null) next.content = u.content;
  if (u.locations !== undefined && u.locations !== null) next.locations = u.locations;
  if (u.rawInput !== undefined) next.rawInput = u.rawInput;
  if (u.rawOutput !== undefined) next.rawOutput = u.rawOutput;
  return next;
}

/** Frozen §3: build the per-run accumulator. */
export function createAcpToolAccumulator(): AcpToolAccumulator {
  const byToolCallId = new Map<string, AcpToolSnapshot>();
  return {
    upsert(u) {
      const snapshot = mergeSnapshot(byToolCallId.get(u.toolCallId), u);
      byToolCallId.set(u.toolCallId, snapshot);
      return snapshot;
    },
    flushUnsettled() {
      const unsettled: AcpToolSnapshot[] = [];
      for (const snapshot of byToolCallId.values()) {
        if (isTerminal(snapshot)) continue;
        unsettled.push({ ...snapshot, status: 'cancelled' });
      }
      byToolCallId.clear();
      return unsettled;
    },
    peek(toolCallId) {
      return byToolCallId.get(toolCallId);
    },
  };
}

/**
 * Build the ToolCallRecord for a merged snapshot. `arguments` is the rawInput
 * JSON (frozen §7 transcript isomorphism), truncated with the shared
 * claude-tool-records storage caps.
 */
export function snapshotToToolCallRecord(snapshot: AcpToolSnapshot, timestamp: string = nowISO()): ToolCallRecord {
  return {
    toolCallId: snapshot.toolCallId,
    toolName: snapshotToolName(snapshot),
    arguments: truncateForStorage(toolPayloadText(snapshot.rawInput) || '{}', CLAUDE_TOOL_ARGS_STORE_CHARS),
    status: recordStatus(snapshot.status),
    startedAt: timestamp,
    ...(isTerminal(snapshot) && { endedAt: timestamp }),
  };
}

/** Flatten ACP content blocks: text passes through, diff/terminal are marked. */
function flattenContentBlocks(blocks: AcpToolCallContent[] | undefined): string {
  if (!blocks || blocks.length === 0) return '';
  const parts: string[] = [];
  for (const block of blocks) {
    if (block && typeof block === 'object' && block.type === 'content') {
      const inner = block.content as AcpContentBlock | undefined;
      if (inner && inner.type === 'text' && typeof inner.text === 'string') parts.push(inner.text);
      else if (inner) parts.push(`[${inner.type} block]`);
    } else if (block && typeof block === 'object' && block.type === 'diff') {
      parts.push(`[diff: ${block.path}]`);
    } else if (block && typeof block === 'object' && block.type === 'terminal') {
      parts.push(`[terminal: ${block.terminalId}]`);
    }
  }
  return parts.join('\n');
}

/**
 * Measured codebuddy sends rawOutput as a single `{type:'text', text}` object,
 * not a block array (03 §2.1) — accept both, plus a bare string.
 */
function rawOutputText(rawOutput: unknown): string {
  if (rawOutput === undefined || rawOutput === null) return '';
  if (typeof rawOutput === 'string') return rawOutput;
  if (typeof rawOutput === 'object') {
    const obj = rawOutput as { type?: unknown; text?: unknown };
    if (obj.type === 'text' && typeof obj.text === 'string') return obj.text;
  }
  return toolPayloadText(rawOutput);
}

/** Build the ToolResultRecord for a terminal snapshot (frozen §3 tool_call_update row). */
export function snapshotToToolResultRecord(snapshot: AcpToolSnapshot, timestamp: string = nowISO()): ToolResultRecord {
  const failed = snapshot.status === 'failed';
  const output = flattenContentBlocks(snapshot.content) || rawOutputText(snapshot.rawOutput);
  return {
    toolCallId: snapshot.toolCallId,
    toolName: snapshotToolName(snapshot),
    output: {
      type: 'text',
      // Same double clamp as claude's toolResultBlockToRecord: the per-worker
      // cap first, then the unified write-layer bound (issue #53).
      value: clampToolOutput(truncateForStorage(output, CLAUDE_TOOL_RESULT_STORE_CHARS)),
    },
    ...(failed && { isError: true, errorType: 'ToolError' }),
    status: failed ? 'failed' : 'succeeded',
    endedAt: timestamp,
  };
}

/**
 * Map ONE session/update onto mapped events (frozen §3 table). Pure: the
 * accumulator is the only state touched, and it is owned by the caller.
 *
 * The sessionUpdate union's last member is an open `{ sessionUpdate: string;
 * [k: string]: unknown }` catch-all, so per-variant narrowing cannot rely on
 * the discriminant alone — each branch casts to its precise shape first.
 */
export function mapSessionUpdate(update: AcpSessionUpdate, acc: AcpToolAccumulator): AcpMappedEvent[] {
  const variant = update.sessionUpdate;

  if (variant === 'agent_message_chunk') {
    const { content, messageId } = update as { content?: AcpContentBlock; messageId?: string | null };
    const text = content && content.type === 'text' ? content.text : '';
    if (!text) return [{ kind: 'ignored', variant, reason: 'empty-chunk' }];
    return [
      { kind: 'agent-text', text, messageId: messageId ?? null },
      { kind: 'progress', text },
    ];
  }
  if (variant === 'agent_thought_chunk') {
    return [{ kind: 'ignored', variant, reason: 'thought' }];
  }
  if (variant === 'user_message_chunk') {
    return [{ kind: 'ignored', variant, reason: 'echo' }];
  }
  if (variant === 'tool_call' || variant === 'tool_call_update') {
    const event = update as AcpToolCall | AcpToolCallUpdate;
    const isFirst = acc.peek(event.toolCallId) === undefined;
    const snapshot = acc.upsert(event);
    if (variant === 'tool_call' && isFirst) {
      // First snapshot produces no record: rawInput may be empty and kind
      // 'other' (measured); wait for the merge to mature.
      return [{ kind: 'ignored', variant, reason: 'first-snapshot' }];
    }
    if (variant === 'tool_call') {
      // Same-id full resend: the snapshot is mature — surface the running call.
      return [{ kind: 'tool-call', record: snapshotToToolCallRecord(snapshot) }];
    }
    if (isTerminal(snapshot)) {
      return [
        { kind: 'tool-call', record: snapshotToToolCallRecord(snapshot) },
        { kind: 'tool-result', record: snapshotToToolResultRecord(snapshot) },
      ];
    }
    return [{ kind: 'ignored', variant, reason: 'non-terminal-update' }];
  }
  if (variant === 'plan') {
    return [{ kind: 'runtime-state', key: 'plan', value: (update as { entries: unknown }).entries }];
  }
  if (variant === 'usage_update') {
    const usage = update as { used: number; size: number; cost?: { amount: number; currency: string } | null };
    return [
      {
        kind: 'runtime-state',
        key: 'usage',
        value: {
          used: usage.used,
          size: usage.size,
          ...(usage.cost !== undefined && usage.cost !== null && { cost: usage.cost }),
        },
      },
    ];
  }

  const knownReason = IGNORED_VARIANTS.get(variant);
  if (knownReason) return [{ kind: 'ignored', variant, reason: knownReason }];
  return [{ kind: 'ignored', variant, reason: 'unknown-variant' }];
}
