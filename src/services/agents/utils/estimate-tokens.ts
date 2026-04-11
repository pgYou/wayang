/**
 * Rough token estimator for conversation entries.
 * Uses a conservative ratio of ~4 chars per token (English/mixed content).
 */

/** Estimate token count for a string. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** Estimate total tokens for conversation entries. */
export function estimateConversationTokens(entries: any[]): number {
  let total = 0;
  for (const entry of entries) {
    if (entry.message?.content) {
      total += estimateTokens(entry.message.content);
    }
    if (entry.arguments) {
      total += estimateTokens(typeof entry.arguments === 'string' ? entry.arguments : JSON.stringify(entry.arguments));
    }
    if (entry.result) {
      total += estimateTokens(entry.result);
    }
    if (entry.content) {
      total += estimateTokens(entry.content);
    }
  }
  return total;
}
