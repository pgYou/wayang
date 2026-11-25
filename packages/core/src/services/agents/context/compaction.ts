// Context compaction — the agent-type-agnostic layer shared by the controller
// and puppet workers (issue #90). It owns the whole compaction step: build the
// summarizer input (folding the previous summary in), call the summarizer with
// retries, let ContextManager append the compact marker (compactMeta.
// summarizedTokenCount) and move the verbatim-zone start index, and degrade to
// a half-history truncation when the summarizer fails. Callers only supply the
// state, the context manager, the model and a logger.

import { generateText, type LanguageModel } from 'ai';
import type { Logger } from '../../../infra/logger';
import type { BaseWayangState } from '../../../infra/state/base-state';
import type { ConversationEntry } from '@wayang-ai/protocol/types/conversation';
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

/**
 * Per-attempt timeout for the summarizer call. Without it a hung provider
 * would sit inside prepareStep for as long as the agent's idle watchdog (5
 * minutes) — and that watchdog only watches toolsInFlight, so a compaction
 * between steps could get the whole task killed as idle. A timeout is treated
 * as a summarizer failure: after the retries the caller truncates instead.
 */
export const SUMMARIZER_TIMEOUT_MS = 60_000;

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
  /**
   * Entry uuids left out of the summarizer input. The worker excludes its
   * current task-description entry (#90): that description is re-injected into
   * the rebuilt request, and a summary could otherwise paraphrase it away.
   */
  excludeEntryUuids?: readonly string[];
}

export type CompactionOutcome = 'summarized' | 'truncated' | 'skipped';

export interface CompactionResult {
  outcome: CompactionOutcome;
  /** Entries covered by the summary (summarized only). */
  summarizedEntries?: number;
  /** Entries kept in memory by the fallback truncation (truncated only). */
  kept?: number;
  /** Entries kept verbatim alongside the summary (summarized only). */
  retainedEntries?: number;
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

    const result = await contextManager.compact(
      async (entries) => {
        // Budget the summarizer input in characters against the model
        // window: CJK text runs close to one token per character, so a
        // character budget never underestimates the request size.
        const budget = Math.floor(contextManager.getContextWindowTokens() * SUMMARIZER_INPUT_RATIO)
          - (previousSummary?.length ?? 0);
        const excluded = new Set(deps.excludeEntryUuids ?? []);
        const summaryEntries = excluded.size > 0
          ? entries.filter((entry) => !excluded.has((entry as ConversationEntry).uuid))
          : entries;
        const entryTexts = buildSummaryInput(summaryEntries, Math.max(budget, 0));
        if (previousSummary) {
          entryTexts.unshift(`[Previous Summary]\n${previousSummary}`);
        }

        let lastError: unknown;
        for (let attempt = 0; attempt <= COMPACT_MAX_RETRIES; attempt++) {
          // A fresh controller per attempt: one hung request must not eat the
          // whole idle-watchdog window (see SUMMARIZER_TIMEOUT_MS).
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), SUMMARIZER_TIMEOUT_MS);
          try {
            const { text } = await generateText({
              model,
              system: SUMMARIZER_SYSTEM_PROMPT,
              prompt: buildSummarizerPrompt(entryTexts),
              abortSignal: controller.signal,
            });
            return text;
          } catch (err) {
            lastError = err;
            if (controller.signal.aborted) {
              logger.warn(
                { attempt: attempt + 1, timeoutMs: SUMMARIZER_TIMEOUT_MS, error: String(err) },
                'Compaction summarizer timed out',
              );
            } else {
              logger.warn({ attempt: attempt + 1, error: String(err) }, 'Compaction summarizer failed');
            }
          } finally {
            clearTimeout(timer);
          }
        }
        throw lastError;
      },
      { ...(deps.modelName !== undefined && { model: deps.modelName }) },
    );

    if (result.skipped) {
      logger.info(
        { entryCount, keptEntries: result.keptEntries },
        'Compaction skipped — the retained zone covers the whole conversation',
      );
      return { outcome: 'skipped' };
    }

    logger.info(
      {
        ...(deps.modelName !== undefined && { model: deps.modelName }),
        summarizedEntries: entryCount,
        retainedEntries: result.keptEntries,
      },
      'Compaction done',
    );
    return { outcome: 'summarized', summarizedEntries: entryCount, retainedEntries: result.keptEntries };
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
