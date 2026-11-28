import type { BaseWayangState } from '../../infra/state/base-state';
import { conversationToSdkMessages } from './utils/conversation-to-sdk-messages';
import { estimateTokens, estimateConversationTokens, estimateEntryTokens, extractContentText } from './utils/estimate-tokens';
import { EEntryType, ESystemSubtype } from '@wayang-ai/protocol';
import type { ContextBreakdown, ConversationEntry } from '@wayang-ai/protocol';
import { generateId } from '../../utils/id';
import { nowISO } from '../../utils/time';

// --- Configuration Constants ---

/** Default context window budget: 256K tokens (K = 1024 throughout the codebase). */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 256 * 1024;

/** Trigger compaction at 60% of the context window, reserving 40% for output. */
const COMPACT_THRESHOLD_RATIO = 0.6;

/**
 * Token budget for the retained verbatim zone (issue #95 redesign), scaled to
 * the model's context window.
 *
 * retainedMax = clamp(windowTokens × 25%, 4k, 16k), retainedMin = half of it.
 * The window comes from the model config's contextWindowTokens (injected via
 * the ContextManager deps); the default fallback window (256k, or any window
 * ≥ 64k) clamps to the historical 16k/8k pair, so existing configs keep their
 * behaviour, while smaller windows shrink the zone so the retained history
 * plus the summary can actually fit the window.
 */
export function retainedMaxTokens(windowTokens: number): number {
  return Math.round(Math.min(16_000, Math.max(4_000, windowTokens * 0.25)));
}

export function retainedMinTokens(windowTokens: number): number {
  return retainedMaxTokens(windowTokens) / 2;
}

/**
 * Replay text for the compact marker. It sits between the retained history
 * and the summary entry in the message flow, so the model knows the entries
 * above are recent verbatim history and the user message below summarizes
 * everything older.
 */
export const COMPACT_MARKER_TEXT =
  '[Context compacted] The entries above are the retained recent history. '
  + 'A summary of everything before them follows as the next user message.';

/**
 * Start index of the retained verbatim zone: the newest whole entries whose
 * estimated size lands in [retainedMin, retainedMax] for the manager's window.
 *
 * Turn integrity wins over the budget. An AssistantEntry is atomic — its
 * toolCalls and toolResults live on the same entry — so an entry boundary can
 * never split a tool call from its result; the walk below therefore only ever
 * stops between steps. The newest entry is always kept whole, even when it
 * alone exceeds the upper bound.
 *
 * Returns 0 when nothing can be discarded (the whole conversation fits), which
 * the caller turns into a skipped compaction.
 */
function retainedStartIdx(conversation: ConversationEntry[], minTokens: number, maxTokens: number): number {
  let total = 0;
  let start = conversation.length;
  for (let i = conversation.length - 1; i >= 0; i--) {
    const tokens = estimateEntryTokens(conversation[i]);
    const newest = i === conversation.length - 1;
    if (!newest && (total >= minTokens || total + tokens > maxTokens)) break;
    total += tokens;
    start = i;
  }
  return start;
}

/**
 * Token budget for recent entries to keep alongside the summary on restore.
 * Shared by the state-layer restore() windowing (controller/worker) so the
 * on-disk window and the in-memory compaction agree on how much recent
 * context survives.
 *
 * Scaled to the window like the retained zone: clamp(windowTokens × 25%,
 * 4k, 20k). A fixed 20k would already exceed the 60% compaction threshold
 * (19.2k) on a 32k window, forcing a pointless compaction on the first
 * request after restore; ≥80k windows keep the historical 20k budget.
 */
export function recentTokenBudget(windowTokens: number): number {
  return Math.round(Math.min(20_000, Math.max(4_000, windowTokens * 0.25)));
}

/** Maximum retry attempts for the LLM summarizer call. */
export const COMPACT_MAX_RETRIES = 2;

// --- ContextManager ---

export class ContextManager {
  /** Context window budget (input side) — NOT an output cap. Distinct from the
   *  OpenAI-protocol `max_tokens` (max output tokens); this is the model's
   *  context window the prompt must fit into. */
  private readonly contextWindowTokens: number;

  /**
   * Legacy restore summary — set only by restoreCompact() for sessions whose
   * compaction predates the summary-entry format. Null for every compaction
   * made by the current code (the summary is a conversation entry instead),
   * which keeps it out of the system prompt.
   */
  private compactSummary: string | null = null;

  /**
   * True once a compaction is active: getMessages() then replays only the
   * verbatim zone. Distinct from compactSummary because the current format
   * has no system-prompt summary to key off.
   */
  private compacted = false;

  /**
   * Index into the conversation array: entries from this index onward form the
   * "verbatim zone" — entries sent to the LLM as-is alongside the summary.
   *
   * Semantics (unified):
   * - After compact(): the start of the retained recent entries. Everything
   *   before it lives on in the summary entry (and in the append-only JSONL
   *   history); the compact marker and the summary entry are appended after
   *   the retained zone.
   * - After restoreCompact(): 0. The state layer has already sliced the
   *   in-memory conversation to the restore window, so the whole array IS
   *   the verbatim zone.
   *
   * Updated together with `compacted`.
   */
  private compactStartIdx = 0;

  /**
   * Last real provider-reported prompt size (inputTokens of the most recent
   * step), if any. Real usage beats the local estimator — estimators
   * undercount CJK text and tool JSON heavily, and undercounting lets the
   * context grow past the model window without ever triggering compaction.
   */
  private lastReportedTokens: number | null = null;

  constructor(
    private state: BaseWayangState,
    private staticPrompt: string,
    contextWindowTokens?: number,
  ) {
    // Only a positive finite budget is meaningful — 0/negative/NaN would make
    // isFull() true on every loop (compact forever). Config validation rejects
    // those up front; this is the runtime backstop.
    this.contextWindowTokens =
      typeof contextWindowTokens === 'number' && Number.isFinite(contextWindowTokens) && contextWindowTokens > 0
        ? contextWindowTokens
        : DEFAULT_CONTEXT_WINDOW_TOKENS;
  }

  // --- Public API ---

  /**
   * System prompt: the static prompt, plus the legacy compaction summary
   * section when a pre-summary-entry-format session was restored. Current
   * compactions put the summary in a `user` entry inside getMessages(), so the
   * system prompt carries no summary for them.
   */
  getSystemPrompt(): string {
    return this.staticPrompt + this.summarySection();
  }

  /**
   * The text getSystemPrompt() appends for a legacy restored summary (''
   * otherwise). Only the restore path sets compactSummary; compact() leaves it
   * null so the summary is never duplicated between prompt and messages.
   */
  private summarySection(): string {
    return this.compactSummary ? `\n\n[Conversation Summary]\n${this.compactSummary}` : '';
  }

  /**
   * Build messages for the LLM.
   *
   * If no compaction has occurred, converts the full conversation.
   * If compacted, converts only the verbatim zone (entries from
   * compactStartIdx on) — the retained recent entries, followed by the compact
   * marker and the summary entry. Everything before the zone is covered by the
   * summary. No backward scanning — uses the cached compactStartIdx.
   */
  getMessages() {
    const conversation = this.state.get<ConversationEntry[]>('conversation');

    if (!this.compacted) {
      return conversationToSdkMessages(conversation);
    }

    return conversationToSdkMessages(conversation.slice(this.compactStartIdx));
  }

  /** Record the provider-reported prompt size (inputTokens) of the latest step. */
  reportRealUsage(inputTokens: number): void {
    if (typeof inputTokens === 'number' && Number.isFinite(inputTokens) && inputTokens > 0) {
      this.lastReportedTokens = inputTokens;
    }
  }

  /**
   * Compaction fallback: keep only the newest `keep` entries in memory (the
   * JSONL file is untouched). Keeps the context manager's own bookkeeping
   * consistent with the shortened array:
   * - compactStartIdx shifts by the number of removed entries, so the
   *   verbatim zone still starts right after the active summary instead of
   *   pointing past the end (which silently sent no recent history at all);
   * - the real-usage high-water mark is cleared, so the next loop does not
   *   judge the context full again on a stale value and truncate repeatedly.
   *
   * Returns the number of entries removed (0 when nothing was cut).
   */
  truncateHistory(keep: number): number {
    const conversation = this.state.get<ConversationEntry[]>('conversation') ?? [];
    const keepCount = Math.max(0, Math.floor(keep));
    const removed = conversation.length - keepCount;
    if (removed <= 0) return 0;
    this.state.set('conversation', keepCount > 0 ? conversation.slice(-keepCount) : []);
    this.compactStartIdx = Math.max(0, this.compactStartIdx - removed);
    this.lastReportedTokens = null;
    return removed;
  }

  /** Check if context exceeds the compaction threshold. */
  isFull(): boolean {
    // Real reported usage beats the estimate — max() covers the gap before
    // the first real usage arrives and right after a compaction.
    const effective = Math.max(this.getEstimatedTokens(), this.lastReportedTokens ?? 0);
    return effective > this.contextWindowTokens * COMPACT_THRESHOLD_RATIO;
  }

  /** Get the configured context window budget (tokens). */
  getContextWindowTokens(): number {
    return this.contextWindowTokens;
  }

  /**
   * Estimate the current context size: system prompt (static part + summary
   * section) + the messages getMessages() would send. Counted the same way as
   * getContextBreakdown(), so the two always agree. Read-only — never trims
   * or mutates history.
   */
  getEstimatedTokens(): number {
    return (
      estimateTokens(this.staticPrompt) +
      estimateTokens(this.summarySection()) +
      estimateConversationTokens(this.getMessages())
    );
  }

  /**
   * Estimate the current context size, split by prompt group.
   *
   * Classifies the exact ModelMessage[] getMessages() would send, so the split
   * is consistent with the wire format by construction — signal labels, the
   * stripped skip_reply content and the synthesized orphan tool results all
   * come from the same conversion. Groups are mutually exclusive, so `total`
   * equals their sum:
   *
   * - user messages (including replayed worker signals) share the user group
   * - assistant text/reasoning never absorbs tool payloads
   * - tool call arguments and tool results are counted on their own
   * - the compaction summary is counted from the section the system prompt
   *   carries (it is not repeated in the messages)
   *
   * Read-only — never trims, mutates or appends anything.
   */
  getContextBreakdown(): ContextBreakdown {
    const messages = this.getMessages();

    const breakdown: ContextBreakdown = {
      systemPrompt: estimateTokens(this.staticPrompt),
      user: 0,
      assistant: 0,
      toolCalls: 0,
      toolResults: 0,
      compactSummary: estimateTokens(this.summarySection()),
      total: 0,
    };

    for (const message of messages) {
      switch (message.role) {
        case 'user':
        case 'system':
          // Replayed worker signals are inbound context — same group as user
          // input.
          for (const text of extractContentText(message.content).texts) {
            breakdown.user += estimateTokens(text);
          }
          break;

        case 'assistant': {
          const { texts, toolCalls } = extractContentText(message.content);
          for (const text of texts) {
            breakdown.assistant += estimateTokens(text);
          }
          for (const call of toolCalls) {
            breakdown.toolCalls += estimateTokens(call);
          }
          break;
        }

        case 'tool': {
          for (const result of extractContentText(message.content).toolResults) {
            breakdown.toolResults += estimateTokens(result);
          }
          break;
        }
      }
    }

    breakdown.total =
      breakdown.systemPrompt +
      breakdown.user +
      breakdown.assistant +
      breakdown.toolCalls +
      breakdown.toolResults +
      breakdown.compactSummary;

    return breakdown;
  }

  /**
   * Restore the compaction state of a legacy session (the format that kept the
   * summary only in the system prompt): the state layer hands the summary back
   * and the whole restore window is the verbatim zone.
   *
   * Current-format sessions never call this — their summary already sits inside
   * the windowed conversation as a `user` entry, so the default (`compacted`
   * false) replays it as-is.
   */
  restoreCompact(summary: string): void {
    this.compactSummary = summary;
    this.compacted = true;
    this.compactStartIdx = 0;
  }

  /** Get the cached compaction summary, or null if no compaction is active. */
  getCompactSummary(): string | null {
    return this.compactSummary;
  }

  /**
   * Compact the conversation: summarize ALL entries, keep the newest ones as
   * the verbatim zone, and append a compact marker followed by the summary as
   * a `user` entry (issue #95 redesign).
   *
   * Storage stays append-only — nothing is modified or removed. The summary is
   * deliberately NOT put in the system prompt: it travels through the message
   * flow, so providers that reject requests without a `user` message stay
   * happy and the model reads the summary right after the retained history it
   * summarizes.
   *
   * Skipped (no marker, no state change) when the retained zone would cover the
   * whole conversation: nothing would be discarded, and the summary would only
   * duplicate history that is already sent verbatim.
   *
   * @param meta Optional provenance recorded on the marker (model name).
   * @returns skipped=true when nothing was compacted; keptEntries is the number
   *          of entries the retained zone holds.
   */
  async compact(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- public callback surface: summarizer implementations read heterogeneous entries defensively
    summarizer: (entries: any[]) => Promise<string>,
    meta?: { model?: string },
  ): Promise<{ skipped: boolean; keptEntries: number }> {
    const conversation = this.state.get<ConversationEntry[]>('conversation');
    if (conversation.length < 4) return { skipped: true, keptEntries: conversation.length };

    const keepStartIdx = retainedStartIdx(
      conversation,
      retainedMinTokens(this.contextWindowTokens),
      retainedMaxTokens(this.contextWindowTokens),
    );
    // The whole conversation fits the retained budget — a summary would only
    // repeat what is already sent verbatim, so leave everything untouched.
    if (keepStartIdx === 0) return { skipped: true, keptEntries: conversation.length };

    // Range of entries covered by the summary — the in-memory conversation at
    // compaction time (which may itself be a post-restore window). Captured
    // before the marker/summary appends below, which mutate the live array.
    const fromEntryId = conversation[0]?.uuid;
    const toEntryId = conversation[conversation.length - 1]?.uuid;
    const summarizedTokenCount = estimateConversationTokens(conversation);
    const keptEntries = conversation.length - keepStartIdx;

    const summary = await summarizer(conversation);

    // Cache the retained zone. The marker and the summary entry are appended
    // right after it, so slicing from keepStartIdx replays:
    // [retained entries][compact marker][summary user entry].
    this.compacted = true;
    this.compactStartIdx = keepStartIdx;
    // A legacy restored summary is folded into the new summary by the
    // summarizer input (compactContext passes it in), so it must not stay in
    // the system prompt as well.
    this.compactSummary = null;
    // The pre-compaction real usage is stale — the next call sends the summary
    // instead. Let the next real usage re-arm it.
    this.lastReportedTokens = null;

    const markerTs = nowISO();
    const sessionId = this.state.get<string>('runtimeState.session.id') ?? '';
    const summaryEntryUuid = generateId('u');

    // Append the compact marker — a normal system entry persisted to JSONL.
    // The marker is a chain boundary: parentId stays null (the shared
    // applyAppendEnvelope in the state layer) and the summary entry anchors to
    // null too.
    this.state.append('conversation', {
      type: EEntryType.System,
      uuid: generateId('compact'),
      parentUuid: null,
      sessionId,
      timestamp: markerTs,
      subtype: ESystemSubtype.Compact,
      content: COMPACT_MARKER_TEXT,
      // System entries are point-in-time events: startedAt/endedAt share the
      // marker's creation moment.
      startedAt: markerTs,
      endedAt: markerTs,
      compactMeta: {
        summarizedTokenCount,
        ...(fromEntryId !== undefined && { fromEntryId }),
        ...(toEntryId !== undefined && { toEntryId }),
        ...(meta?.model !== undefined && { model: meta.model }),
        createdAt: markerTs,
        summaryEntryUuid,
      },
    });

    // The summary rides as a user entry so the message flow itself carries a
    // user turn — the constraint the GLM MaaS gateway enforces (issue #95).
    // Its text starts with [Conversation Summary] so readers can identify it.
    this.state.append('conversation', {
      type: EEntryType.User,
      uuid: summaryEntryUuid,
      parentUuid: null,
      sessionId,
      timestamp: markerTs,
      actor: { kind: 'system', id: 'compaction' },
      startedAt: markerTs,
      endedAt: markerTs,
      message: { role: 'user', content: `[Conversation Summary]\n${summary}` },
    });

    return { skipped: false, keptEntries };
  }
}
