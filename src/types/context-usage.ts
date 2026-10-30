/**
 * Context window usage snapshot for the status bar.
 *
 * Written by ControllerAgent into dynamicState.contextUsage (not persisted)
 * after each LLM step and after restore; read by the TUI status bar.
 */
export interface ContextUsage {
  /** Tokens occupied by the current prompt (real usage or local estimate). */
  usedTokens: number;
  /** Context window budget from ContextManager. */
  maxTokens: number;
  /** usedTokens / maxTokens — raw value, not clamped to 1. */
  ratio: number;
  /** Whether usedTokens came from provider-reported usage or an estimate. */
  source: 'usage' | 'estimate';
}
