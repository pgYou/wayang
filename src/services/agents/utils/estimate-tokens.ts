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
