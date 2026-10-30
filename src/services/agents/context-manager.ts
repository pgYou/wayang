import type { BaseWayangState } from '@/infra/state/base-state';
import { conversationToSdkMessages } from './utils/conversation-to-sdk-messages';
import { estimateTokens, estimateConversationTokens, extractContentText } from './utils/estimate-tokens';
import { EEntryType, ESystemSubtype } from '@/types/index';
import type { ContextBreakdown } from '@/types/index';
import { generateId } from '@/utils/id';
import { nowISO } from '@/utils/time';

// --- Configuration Constants ---

/** Default context window: ~100k tokens (conservative for most models). */
const DEFAULT_MAX_TOKENS = 100_000;

/** Trigger compaction at 90% of maxTokens, reserving 10% for output. */
const COMPACT_THRESHOLD_RATIO = 0.9;

/**
 * Token budget for recent entries to keep alongside the summary.
 * Shared by the state-layer restore() windowing (controller/worker) so the
 * on-disk window and the in-memory compaction agree on how much recent
 * context survives.
 */
export const RECENT_TOKEN_BUDGET = 20_000;

/** Maximum retry attempts for the LLM summarizer call. */
export const COMPACT_MAX_RETRIES = 2;

// --- ContextManager ---

export class ContextManager {
  private readonly maxTokens: number;

  /**
   * Cached compact state — updated by compact() and restoreCompact(), read by
   * getMessages()/getSystemPrompt(). Null means no compaction is active.
   */
  private compactSummary: string | null = null;

  /**
   * Index into the conversation array: entries from this index onward form the
   * "verbatim zone" — entries sent to the LLM as-is alongside the summary.
   *
   * Semantics (unified):
   * - After compact(): conversation.length. Only entries appended AFTER the
   *   compaction belong to the verbatim zone; pre-compaction entries live on
   *   in the summary (and in the append-only JSONL history).
   * - After restoreCompact(): 0. The state layer has already sliced the
   *   in-memory conversation to the restore window, so the whole array IS
   *   the verbatim zone.
   *
   * Updated together with compactSummary.
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
    maxTokens?: number,
  ) {
    this.maxTokens = maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  // --- Public API ---

  getSystemPrompt(): string {
    const parts = [this.staticPrompt];
    if (this.compactSummary) {
      parts.push(`\n[Conversation Summary]\n${this.compactSummary}`);
    }
    return parts.join('\n\n');
  }

  /**
   * Build messages for the LLM.
   *
   * If no compaction has occurred, converts the full conversation.
   * If compacted, returns: [summary system msg] + [recent entries (compactStartIdx..)].
   * No backward scanning — uses cached compactSummary and compactStartIdx.
   */
  getMessages() {
    const conversation = this.state.get<any[]>('conversation');

    if (!this.compactSummary) {
      return conversationToSdkMessages(conversation);
    }

    // Skip entries before compactStartIdx; include everything after
    const recentEntries = conversation.slice(this.compactStartIdx);
    return [
      { role: 'system' as const, content: `[Conversation Summary]\n${this.compactSummary}` },
      ...conversationToSdkMessages(recentEntries),
    ];
  }

  /** Record the provider-reported prompt size (inputTokens) of the latest step. */
  reportRealUsage(inputTokens: number): void {
    if (typeof inputTokens === 'number' && Number.isFinite(inputTokens) && inputTokens > 0) {
      this.lastReportedTokens = inputTokens;
    }
  }

  /** Check if context exceeds the compaction threshold. */
  isFull(): boolean {
    const promptTokens = estimateTokens(this.getSystemPrompt());
    const convTokens = estimateConversationTokens(this.getMessages());
    // Real reported usage beats the estimate — max() covers the gap before
    // the first real usage arrives and right after a compaction.
    const effective = Math.max(promptTokens + convTokens, this.lastReportedTokens ?? 0);
    return effective > this.maxTokens * COMPACT_THRESHOLD_RATIO;
  }

  /** Get the configured context window budget (tokens). */
  getMaxTokens(): number {
    return this.maxTokens;
  }

  /**
   * Estimate the current context size: system prompt + the messages
   * getMessages() would send. Read-only — never trims or mutates history.
   */
  getEstimatedTokens(): number {
    return estimateTokens(this.getSystemPrompt()) + estimateConversationTokens(this.getMessages());
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
   * - the compaction summary is counted once, from the cached summary text;
   *   the copy getMessages() prepends as a system message is skipped
   *
   * Read-only — never trims, mutates or appends anything.
   */
  getContextBreakdown(): ContextBreakdown {
    const messages = this.getMessages();
    const summaryMessage = this.compactSummary
      ? `[Conversation Summary]\n${this.compactSummary}`
      : null;

    const breakdown: ContextBreakdown = {
      systemPrompt: estimateTokens(this.staticPrompt),
      user: 0,
      assistant: 0,
      toolCalls: 0,
      toolResults: 0,
      compactSummary: estimateTokens(this.compactSummary ?? ''),
      total: 0,
    };

    for (const message of messages) {
      // The summary is counted once from the cached text above; getMessages()
      // also sends it as a system message, which would double count.
      if (summaryMessage && message.role === 'system' && message.content === summaryMessage) {
        continue;
      }

      switch (message.role) {
        case 'user':
        case 'system':
          // Replayed worker signals are inbound context — same group as user
          // input. (The compaction summary was handled above.)
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
   * Restore compact state from a summary computed by the state layer.
   *
   * Call this after the state layer's restore() has already sliced the
   * in-memory conversation to the restore window (entries before the cut are
   * gone from memory). The window itself is the verbatim zone, so
   * compactStartIdx resets to 0 — see the field's semantics note.
   */
  restoreCompact(summary: string): void {
    this.compactSummary = summary;
    this.compactStartIdx = 0;
  }

  /** Get the cached compaction summary, or null if no compaction is active. */
  getCompactSummary(): string | null {
    return this.compactSummary;
  }

  /**
   * Compact the conversation by summarizing all current entries.
   *
   * Appends a compact marker entry to the conversation (and JSONL file).
   * Does NOT modify or remove any existing entries — storage is append-only.
   *
   * The summarizer receives ALL entries and returns a summary.
   * After compaction, getMessages() returns [summary] + entries appended after the marker.
   *
   * @param meta Optional provenance recorded on the marker (model name).
   */
  async compact(
    summarizer: (entries: any[]) => Promise<string>,
    meta?: { model?: string },
  ): Promise<void> {
    const conversation = this.state.get<any[]>('conversation');
    if (conversation.length < 4) return;

    // Range of entries covered by the summary — the in-memory conversation at
    // compaction time (which may itself be a post-restore window).
    const fromEntryId = conversation[0]?.uuid;
    const toEntryId = conversation[conversation.length - 1]?.uuid;

    const summary = await summarizer(conversation);

    // Cache the summary and set startIdx to current length
    // (entries after this index — i.e. future entries — will be included verbatim)
    this.compactSummary = summary;
    this.compactStartIdx = conversation.length;
    // The pre-compaction real usage is stale — the next call sends the
    // summary instead. Let the next real usage re-arm it.
    this.lastReportedTokens = null;

    // Append compact marker — a normal system entry persisted to JSONL.
    // The marker is a chain boundary: parentId stays null (the shared
    // applyAppendEnvelope in the state layer) and the first entry after it
    // anchors to null too.
    const markerTs = nowISO();
    this.state.append('conversation', {
      type: EEntryType.System,
      uuid: generateId('compact'),
      parentUuid: null,
      sessionId: this.state.get<string>('runtimeState.session.id') ?? '',
      timestamp: markerTs,
      subtype: ESystemSubtype.Compact,
      content: summary,
      // System entries are point-in-time events: startedAt/endedAt share the
      // marker's creation moment.
      startedAt: markerTs,
      endedAt: markerTs,
      compactMeta: {
        summarizedTokenCount: estimateConversationTokens(conversation),
        ...(fromEntryId !== undefined && { fromEntryId }),
        ...(toEntryId !== undefined && { toEntryId }),
        ...(meta?.model !== undefined && { model: meta.model }),
        createdAt: markerTs,
      },
    });
  }
}
