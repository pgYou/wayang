// Entry text extraction: flattening an entry's payload, tool calls and results.

import type { ConversationEntry } from '@/types/index';
import { toolOutputText } from '@/services/agents/utils/estimate-tokens';

function blockText(block: unknown): string {
  if (typeof block === 'string') return block;
  if (block && typeof block === 'object') {
    const b = block as { type?: string; text?: string };
    if (b.type === 'text' && typeof b.text === 'string') return b.text;
    // Non-text blocks (tool_use, images, …) keep their structure instead of
    // degrading to "[object Object]" / comma-joined fragments.
    return JSON.stringify(block);
  }
  return String(block ?? '');
}

/**
 * Flatten an entry's text payload.
 * `message.content` may be a string or a content-block array — the array case
 * used to collapse into a comma-joined String() before being cut, losing both
 * structure and readability.
 */
export function entryText(entry: ConversationEntry): string {
  const raw = entry as { message?: { content?: unknown }; content?: unknown };
  const content = raw.message?.content ?? raw.content ?? '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(blockText).join('\n');
  return content === null || content === undefined ? '' : String(content);
}

/** Tool calls recorded on an entry (puppet/controller entries carry them). */
export function entryToolCalls(entry: ConversationEntry): Array<{ toolName: string; arguments?: string }> {
  const calls = (entry as { toolCalls?: Array<{ toolName?: string; arguments?: string }> }).toolCalls;
  if (!Array.isArray(calls)) return [];
  return calls
    .filter((c) => typeof c?.toolName === 'string')
    .map((c) => ({ toolName: c.toolName as string, arguments: c.arguments }));
}

/**
 * Tool results recorded on an entry, with the output flattened to text.
 * `ToolResultRecord.output` is `{ type: 'text', value }` — reading it as a
 * string renders "[object Object]", so the text is extracted via
 * toolOutputText (same reader the token estimator uses).
 */
export function entryToolResults(entry: ConversationEntry): Array<{ output: string; isError?: boolean }> {
  const results = (entry as { toolResults?: Array<{ output?: unknown; isError?: boolean }> }).toolResults;
  if (!Array.isArray(results)) return [];
  return results.map((r) => ({
    output: toolOutputText(r.output),
    isError: r.isError,
  }));
}

/** Human-facing label, e.g. `assistant` or `system/task_result`. */
export function entryLabel(entry: ConversationEntry): string {
  const subtype = (entry as { subtype?: string }).subtype;
  return subtype ? `${entry.type}/${subtype}` : entry.type;
}
