/**
 * Render the /context report: a compact, ≤80-column multi-line summary of the
 * current context window usage.
 *
 * Pure formatting only — the data comes from
 * dynamicState.contextUsage (ControllerAgent), which carries the provider
 * usage of the last step plus a per-group token estimate of the prompt.
 */

import type { ContextUsage } from '@/types/index';
import { formatTokenCount } from './format-tokens';
import { truncateToWidth } from './text-width';

/** Hard cap for every rendered line (terminal-safe). */
export const CONTEXT_REPORT_MAX_WIDTH = 80;

export { formatTokenCount } from './format-tokens';

/** Group digits: 100000 → "100,000". */
export function formatFullTokens(tokens: number): string {
  if (!Number.isFinite(tokens)) return '0';
  return String(Math.round(tokens)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** One-decimal percentage of the context window, e.g. "12.3%". */
function formatPercent(tokens: number, contextWindowTokens: number): string {
  if (!(contextWindowTokens > 0)) return '0.0%';
  const percent = (tokens / contextWindowTokens) * 100;
  return `${percent.toFixed(1)}%`;
}

/** Integer percentage of the context window, e.g. "12%" (matches the status bar). */
function formatRoundedPercent(tokens: number, contextWindowTokens: number): string {
  const percent = contextWindowTokens > 0 ? Math.round((tokens / contextWindowTokens) * 100) : 0;
  return `${percent}%`;
}

const LABEL_WIDTH = 16;
const VALUE_WIDTH = 8;
const PERCENT_WIDTH = 6;

/** Align one breakdown row: "  system prompt        1.2k   1.2%". */
function breakdownRow(label: string, tokens: number, contextWindowTokens: number): string {
  return `  ${label.padEnd(LABEL_WIDTH)}${formatTokenCount(tokens).padStart(VALUE_WIDTH)}${formatPercent(tokens, contextWindowTokens).padStart(PERCENT_WIDTH)}`;
}

/**
 * Build the /context report lines.
 *
 * Line 1 — Context · 12.3k / 100k (12%) · source=usage
 * Line 2 — Last step · in 12.1k · out 340 · cached 8k
 * Line 3 — Model limit · 100,000 tokens
 * Line 4+ — "Breakdown", one row per non-empty group, then the total.
 *
 * The breakdown section is omitted when the snapshot carries no breakdown.
 */
export function formatContextReport(usage: ContextUsage | null | undefined): string[] {
  if (!usage) {
    return ['Context · no data yet'];
  }

  const contextWindowTokens = usage.contextWindowTokens;
  const lines: string[] = [
    `Context · ${formatTokenCount(usage.usedTokens)} / ${formatTokenCount(contextWindowTokens)} (${formatRoundedPercent(usage.usedTokens, contextWindowTokens)}) · source=${usage.source}`,
  ];

  if (usage.lastUsage) {
    const { inputTokens, outputTokens, cachedInputTokens } = usage.lastUsage;
    lines.push(
      `Last step · in ${formatTokenCount(inputTokens)} · out ${formatTokenCount(outputTokens)} · cached ${formatTokenCount(cachedInputTokens)}`,
    );
  } else {
    lines.push('Last step · no usage yet');
  }

  lines.push(`Model limit · ${formatFullTokens(contextWindowTokens)} tokens`);

  const breakdown = usage.breakdown;
  if (breakdown) {
    const groups: Array<[string, number]> = [
      ['system prompt', breakdown.systemPrompt],
      ['user', breakdown.user],
      ['assistant', breakdown.assistant],
      ['tool calls', breakdown.toolCalls],
      ['tool results', breakdown.toolResults],
      ['compact summary', breakdown.compactSummary],
    ];
    lines.push('Breakdown');
    for (const [label, tokens] of groups) {
      if (tokens > 0) lines.push(breakdownRow(label, tokens, contextWindowTokens));
    }
    lines.push(breakdownRow('total', breakdown.total, contextWindowTokens));
  }

  // Enforce the documented hard cap — no line may exceed the report width.
  return lines.map(line => truncateToWidth(line, CONTEXT_REPORT_MAX_WIDTH));
}
