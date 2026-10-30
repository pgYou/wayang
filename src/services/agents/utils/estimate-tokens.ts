/**
 * Rough token estimator for conversation entries.
 * Uses a conservative ratio of ~4 chars per token (English/mixed content).
 */

/** Estimate token count for a string. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Estimate tokens for a single conversation entry.
 *
 * Counts the primary text content (message.content or content) plus tool call
 * arguments and tool result outputs — those regularly dominate an assistant
 * step's real token footprint.
 */
export function estimateEntryTokens(entry: any): number {
  if (!entry) return 0;
  const content = entry.message?.content ?? entry.content ?? '';
  let tokens = estimateTokens(String(content ?? ''));
  if (entry.toolCalls?.length) {
    for (const tc of entry.toolCalls) {
      tokens += estimateTokens(tc.arguments ?? '');
    }
  }
  if (entry.toolResults?.length) {
    for (const tr of entry.toolResults) {
      tokens += estimateTokens(tr.output?.value ?? '');
    }
  }
  return tokens;
}

/** Estimate total tokens for conversation entries. */
export function estimateConversationTokens(entries: any[]): number {
  let total = 0;
  for (const entry of entries) {
    total += estimateEntryTokens(entry);
  }
  return total;
}

// --- SDK message content extraction ---
//
// ModelMessages carry everything in content parts, while conversation entries
// keep tool calls/results as sibling fields. These helpers are the single
// implementation for reading a message's text payloads; the context breakdown
// classifies ModelMessages through them so its per-group split stays in sync
// with the sent format instead of re-deriving part handling.

/** Text payloads carried by a message's content, grouped by prompt kind. */
export interface ContentTextParts {
  /** One entry per text/reasoning part (plain string content = one entry). */
  texts: string[];
  /** Serialized tool-call inputs. */
  toolCalls: string[];
  /** Serialized tool-result outputs. */
  toolResults: string[];
}

/** Extract the text payloads from a message content value. */
export function extractContentText(content: unknown): ContentTextParts {
  if (typeof content === 'string') {
    return { texts: content ? [content] : [], toolCalls: [], toolResults: [] };
  }
  if (!Array.isArray(content)) {
    return { texts: [], toolCalls: [], toolResults: [] };
  }

  const texts: string[] = [];
  const toolCalls: string[] = [];
  const toolResults: string[] = [];

  for (const part of content as Array<Record<string, unknown>>) {
    if (!part || typeof part !== 'object') continue;
    switch (part.type) {
      case 'text':
      case 'reasoning':
        if (typeof part.text === 'string') texts.push(part.text);
        break;
      case 'tool-call':
        toolCalls.push(toolPayloadText(part.input));
        break;
      case 'tool-result':
        toolResults.push(toolOutputText(part.output));
        break;
    }
  }

  return { texts, toolCalls, toolResults };
}

/** Serialize a tool call payload — JSON string on entries, input object on SDK messages. */
export function toolPayloadText(payload: unknown): string {
  if (payload === undefined || payload === null) return '';
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    return '';
  }
}

/** Extract the text carried by a tool result output ({type:'text', value} or a raw value). */
export function toolOutputText(output: unknown): string {
  if (output === undefined || output === null) return '';
  if (typeof output === 'string') return output;
  if (typeof output === 'object' && 'value' in (output as Record<string, unknown>)) {
    const value = (output as Record<string, unknown>).value;
    return typeof value === 'string' ? value : toolPayloadText(value);
  }
  return toolPayloadText(output);
}
