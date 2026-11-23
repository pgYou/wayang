// Context compaction — the agent-type-agnostic layer shared by the controller
// and puppet workers (issue #90). It owns the whole compaction step: build the
// summarizer input (folding the previous summary in), call the summarizer with
// retries, let ContextManager append the compact marker (compactMeta.
// summarizedTokenCount) and move the verbatim-zone start index, and degrade to
// a half-history truncation when the summarizer fails. Callers only supply the
// state, the context manager, the model and a logger.

import { generateText, type LanguageModel } from 'ai';
import type { Logger } from '@/infra/logger';
import type { BaseWayangState } from '@/infra/state/base-state';
import type { ConversationEntry } from '@/types/conversation';
import { COMPACT_MAX_RETRIES, type ContextManager } from '../context-manager';
import { buildSummaryInput } from '../utils/summarizer-input';
import { SUMMARIZER_SYSTEM_PROMPT, buildSummarizerPrompt } from '../prompts/index';

/**
 * Share of the context window (in characters) the summarizer input may use —
 * leaves room for the summarizer prompt and its output.
 */
const SUMMARIZER_INPUT_RATIO = 0.5;

/**
 * Upper bound on summarizing compactions within a single agent run. A context
 * that keeps refilling after every compaction must not loop forever: past the
 * limit the caller degrades to truncation instead of summarizing again.
 */
export const MAX_COMPACTIONS_PER_RUN = 5;

export interface ContextCompactionDeps {
  /** State holding the `conversation` array the marker is appended to. */
  state: BaseWayangState;
  /** Owns the compact summary / verbatim-zone index and the marker append. */
  contextManager: ContextManager;
  /** Model used for the summarizer call. */
  model: LanguageModel;
  /** Model name stamped into the marker's compactMeta (omitted when absent). */
  modelName?: string;
  logger: Logger;
}

export type CompactionOutcome = 'summarized' | 'truncated' | 'skipped';

export interface CompactionResult {
  outcome: CompactionOutcome;
  /** Entries covered by the summary (summarized only). */
  summarizedEntries?: number;
  /** Entries kept in memory by the fallback truncation (truncated only). */
  kept?: number;
}

/**
 * Compact the conversation: summarize it, append the compact marker and move
 * the verbatim-zone start index — or, when the summarizer fails after
 * COMPACT_MAX_RETRIES attempts, fall back to truncating half of the history
 * in memory (the append-only file is untouched).
 */
export async function compactContext(deps: ContextCompactionDeps): Promise<CompactionResult> {
  const { state, contextManager, model, logger } = deps;
  // Same guard as ContextManager.compact(): below four entries there is
  // nothing worth summarizing, and truncation could not keep a pairable
  // history either — report a no-op instead of burning a compaction.
  const entryCount = (state.get<ConversationEntry[]>('conversation') ?? []).length;
  if (entryCount < 4) return { outcome: 'skipped' };
  try {
    // Capture the previous summary before compact() replaces it — the
    // summarizer folds it in so repeated compactions stay incremental.
    const previousSummary = contextManager.getCompactSummary();

    await contextManager.compact(
      async (entries) => {
        // Budget the summarizer input in characters against the model
        // window: CJK text runs close to one token per character, so a
        // character budget never underestimates the request size.
        const budget = Math.floor(contextManager.getContextWindowTokens() * SUMMARIZER_INPUT_RATIO)
          - (previousSummary?.length ?? 0);
        const entryTexts = buildSummaryInput(entries, Math.max(budget, 0));
        if (previousSummary) {
          entryTexts.unshift(`[Previous Summary]\n${previousSummary}`);
        }

        let lastError: unknown;
        for (let attempt = 0; attempt <= COMPACT_MAX_RETRIES; attempt++) {
          try {
            const { text } = await generateText({
              model,
              system: SUMMARIZER_SYSTEM_PROMPT,
              prompt: buildSummarizerPrompt(entryTexts),
            });
            return text;
          } catch (err) {
            lastError = err;
            logger.warn({ attempt: attempt + 1, error: String(err) }, 'Compaction summarizer failed');
          }
        }
        throw lastError;
      },
      { ...(deps.modelName !== undefined && { model: deps.modelName }) },
    );
    logger.info(
      { ...(deps.modelName !== undefined && { model: deps.modelName }), summarizedEntries: entryCount },
      'Compaction done',
    );
    return { outcome: 'summarized', summarizedEntries: entryCount };
  } catch (err) {
    // All retries failed — fallback: truncate half of history in memory only.
    logger.warn({ error: String(err) }, 'Compaction failed, falling back to half-truncation');
    return truncateHistoryHalf(deps);
  }
}

/**
 * Compaction fallback: keep only the newest half of the history in memory
 * (the JSONL file is untouched). Truncation goes through the context manager
 * so its verbatim-zone index and real-usage mark stay consistent with the
 * shortened array. No-op for very short conversations (nothing to gain).
 */
export function truncateHistoryHalf(
  deps: Pick<ContextCompactionDeps, 'state' | 'contextManager' | 'logger'>,
): CompactionResult {
  const { state, contextManager, logger } = deps;
  const total = (state.get<ConversationEntry[]>('conversation') ?? []).length;
  if (total <= 4) return { outcome: 'skipped' };
  const kept = Math.floor(total / 2);
  contextManager.truncateHistory(kept);
  logger.info({ kept, total }, 'History truncated (half) as compaction fallback');
  return { outcome: 'truncated', kept };
}
