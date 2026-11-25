/**
 * Pure UI metrics for the chat surface (§4.3 工作项③) — unit-testable without
 * a DOM: context-ring percentage, the user-message fold decision, and the
 * TurnDotsNav sliding window.
 */

import type { ContextUsage } from '@wayang-ai/protocol';

/** Context ring percentage (0–100, clamped); null when no usage is known. */
export function contextPercent(usage: ContextUsage | null): number | null {
  if (!usage || usage.contextWindowTokens <= 0) return null;
  return Math.min(100, Math.round((usage.usedTokens / usage.contextWindowTokens) * 100));
}

/** Compact token label for the ring's title (12.3k style). */
export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Fold a message whose rendered height exceeds the threshold (§4.3 >300px). */
export const FOLD_THRESHOLD_PX = 300;

export function shouldFold(contentHeight: number | null, expanded: boolean, threshold: number = FOLD_THRESHOLD_PX): boolean {
  if (contentHeight === null || expanded) return false;
  return contentHeight > threshold;
}

/** One navigation dot's model. */
export interface TurnDot {
  /** The user message's conversation uuid (scroll anchor). */
  id: string;
  /** Hover preview: the first line of the message, clipped. */
  preview: string;
}

/**
 * The ≤20-dot sliding window over the user turns (§4.3 TurnDotsNav): centered
 * on the active index so the highlight never leaves the middle band while
 * the whole history stays reachable.
 */
export const TURN_DOT_WINDOW = 20;

export function buildTurnDots(
  items: readonly TurnDot[],
  activeIndex: number | null,
  windowSize: number = TURN_DOT_WINDOW,
): { dots: Array<TurnDot & { index: number }>; total: number } {
  if (items.length === 0) return { dots: [], total: 0 };
  if (items.length <= windowSize) {
    return { dots: items.map((item, index) => ({ ...item, index })), total: items.length };
  }
  const half = Math.floor((windowSize - 1) / 2);
  const anchor = activeIndex === null ? items.length - 1 : Math.min(Math.max(activeIndex, half), items.length - 1 - half);
  const start = Math.min(Math.max(anchor - half, 0), Math.max(items.length - windowSize, 0));
  const dots = items.slice(start, start + windowSize).map((item, i) => ({ ...item, index: start + i }));
  return { dots, total: items.length };
}
