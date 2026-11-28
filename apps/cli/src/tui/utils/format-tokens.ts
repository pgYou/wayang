const K = 1024;
const M = 1024 * 1024;

/**
 * Compact a token count for display: raw below 1K, "12.3k" below 1M, "1.2M"
 * above. K and M are binary (1024) — the same convention as the default
 * context window and the desktop's window presets. Non-finite input renders
 * as "0"; values below 1K are rounded.
 * Shared by the status bar and the /context report.
 */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens)) return '0';
  if (tokens < K) return String(Math.round(tokens));
  if (tokens < M) {
    return `${(tokens / K).toFixed(1).replace(/\.0$/, '')}k`;
  }
  return `${(tokens / M).toFixed(1).replace(/\.0$/, '')}M`;
}
