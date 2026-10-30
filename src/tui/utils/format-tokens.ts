/**
 * Compact a token count for display: raw below 1k, "12.3k" below 1M, "1.2M"
 * above. Non-finite input renders as "0"; values below 1k are rounded.
 * Shared by the status bar and the /context report.
 */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens)) return '0';
  if (tokens < 1_000) return String(Math.round(tokens));
  if (tokens < 1_000_000) {
    return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}
