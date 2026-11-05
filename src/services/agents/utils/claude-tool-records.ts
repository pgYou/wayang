/**
 * Tool-record builders for ClaudeCodeWorker: claude-agent-sdk stream blocks →
 * conversation ToolCallRecord / ToolResultRecord.
 *
 * The SDK stream delivers one LLM step as TWO messages — an assistant message
 * carrying `tool_use` blocks, then a user message carrying the matching
 * `tool_result` blocks — while the conversation schema stores text, tool calls
 * and tool results on ONE AssistantEntry (a step is atomic; see puppet's
 * buildAssistantEntry). The worker therefore buffers the assistant entry and
 * merges the results in before writing: conversation storage is append-only
 * JSONL, so they cannot be attached after the fact.
 *
 * Storage-sized truncation lives here too: worker transcripts are long-lived
 * audit records, and tool results (bash output, file dumps) can dwarf
 * everything else in a step. The per-worker caps are the first line; the
 * shared `clampToolOutput` (issue #53) is the outer fallback bound.
 */

import type { ToolCallRecord, ToolResultRecord } from '@/types/index';
import { toolPayloadText } from './estimate-tokens';
import { clampToolOutput } from './tool-output-clamp';

/**
 * Cap for a stored tool RESULT (chars). Keeps the informative head of a
 * payload (command echo, first findings) while bounding a many-tool run's
 * transcript size; at ~4 chars/token this is ~500 estimated tokens per result.
 */
export const CLAUDE_TOOL_RESULT_STORE_CHARS = 2_000;

/**
 * Cap for a stored tool INPUT / serialized arguments (chars). Commands and
 * paths stay complete well below this; only pathological inputs (e.g.
 * write_file carrying a whole file body) are cut.
 */
export const CLAUDE_TOOL_ARGS_STORE_CHARS = 8_000;

/**
 * Cut a payload for storage: keep the head, report the original size.
 * Marker format: `... [truncated, 12345 chars]`.
 */
export function truncateForStorage(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}... [truncated, ${text.length} chars]`;
}

/**
 * Structural type of an assistant-message `tool_use` content block
 * (BetaToolUseBlock), declared locally so this module does not depend on the
 * agent SDK's transitive @anthropic-ai/sdk types.
 */
export interface SdkToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

/**
 * Structural type of a user-message `tool_result` content block
 * (ToolResultBlockParam). `content` may be a plain string or an array of
 * blocks (text, images, …).
 */
export interface SdkToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | Array<unknown>;
  is_error?: boolean;
}

/**
 * Build the ToolCallRecord for one assistant tool_use block.
 * Status starts as 'running' — the result arrives in a later user message and
 * the worker closes the record then (the entry is still in memory, unwritten).
 * Empty inputs normalize to '{}' to match puppet's buildAssistantEntry shape.
 */
export function toolUseBlockToRecord(block: SdkToolUseBlock, startedAt: string): ToolCallRecord {
  return {
    toolCallId: block.id,
    toolName: block.name,
    arguments: truncateForStorage(toolPayloadText(block.input) || '{}', CLAUDE_TOOL_ARGS_STORE_CHARS),
    status: 'running',
    startedAt,
  };
}

/**
 * Flatten a tool_result content value to storable text: strings pass through;
 * block arrays join their text blocks and mark non-text blocks (images, …)
 * by type instead of degrading to "[object Object]".
 */
export function flattenToolResultContent(content: SdkToolResultBlock['content']): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return toolPayloadText(content);
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && 'type' in block) {
      const b = block as { type?: unknown; text?: unknown };
      if (b.type === 'text' && typeof b.text === 'string') {
        parts.push(b.text);
      } else {
        parts.push(`[${String(b.type)} block]`);
      }
    } else if (typeof block === 'string') {
      parts.push(block);
    }
  }
  return parts.join('\n');
}

/**
 * Build the ToolResultRecord for one user tool_result block.
 * `toolName` comes from the tool_use record that owns the id — the block
 * itself carries only `tool_use_id`. Error results keep `isError` plus an
 * `errorType` ('ToolError', the same classification safeExecute uses) even
 * when their text had to be truncated.
 */
export function toolResultBlockToRecord(
  block: SdkToolResultBlock,
  toolName: string,
  endedAt: string,
): ToolResultRecord {
  const isError = block.is_error === true;
  return {
    toolCallId: block.tool_use_id,
    toolName,
    output: {
      type: 'text' as const,
      // Own cap first (claude's storage budget), then the unified write-layer
      // clamp as the outer bound (issue #53): normally a no-op — it only
      // bites if the per-worker cap were ever raised past it.
      value: clampToolOutput(
        truncateForStorage(flattenToolResultContent(block.content), CLAUDE_TOOL_RESULT_STORE_CHARS),
      ),
    },
    ...(isError && { isError: true, errorType: 'ToolError' }),
    status: isError ? 'failed' : 'succeeded',
    endedAt,
  };
}
