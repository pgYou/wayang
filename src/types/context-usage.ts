/**
 * Context window usage snapshot for the status bar.
 *
 * Written by ControllerAgent into dynamicState.contextUsage (not persisted)
 * after each LLM step and after restore; read by the TUI status bar and the
 * /context command.
 */

/**
 * Per-group token estimate of the current prompt.
 *
 * Groups are mutually exclusive (no entry contributes to two of them), so
 * `total` always equals the sum of the individual groups. Tool call arguments
 * and tool results are broken out of the assistant group so the assistant text
 * itself is not inflated by tool payloads.
 */
export interface ContextBreakdown {
  /** Static system prompt (excludes the compaction summary). */
  systemPrompt: number;
  /** User messages plus inbound worker-signal messages (as sent). */
  user: number;
  /** Assistant text content (message.content + reasoning). */
  assistant: number;
  /** Tool call arguments requested by the model. */
  toolCalls: number;
  /** Tool result payloads returned to the model. */
  toolResults: number;
  /** Compaction summary (kept separate so it is never double counted). */
  compactSummary: number;
  /**
   * Sum of all groups above. This is a fresh estimate of the prompt as it
   * would be sent right now — it advances when an assistant step is appended
   * and therefore samples a different point in time than `usedTokens`
   * (see ContextUsage.breakdown).
   */
  total: number;
}

/** Token usage reported by the provider for the most recent assistant step. */
export interface ContextLastUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface ContextUsage {
  /**
   * Provider-reported input tokens for the most recent step when available —
   * i.e. a snapshot of the PREVIOUS prompt — otherwise a local estimate of the
   * current prompt. See `breakdown`: the two are sampled at different times.
   */
  usedTokens: number;
  /** Context window budget (input side) from ContextManager — NOT an output cap. */
  contextWindowTokens: number;
  /** usedTokens / contextWindowTokens — raw value, not clamped to 1. */
  ratio: number;
  /** Whether usedTokens came from provider-reported usage or an estimate. */
  source: 'usage' | 'estimate';
  /**
   * Per-group estimate of the prompt as it would be sent right now (always a
   * fresh local estimate). When an assistant step was appended and the next
   * step has not run yet, `breakdown.total` covers content the provider has not
   * seen — so it differs in timing from `usedTokens` and must not be
   * reconciled against it directly.
   */
  breakdown?: ContextBreakdown;
  /** Provider usage of the most recent assistant step, when available. */
  lastUsage?: ContextLastUsage;
}
