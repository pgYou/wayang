import type { BaseWayangState } from '@/infra/state/base-state';
import { conversationToSdkMessages } from './utils/conversation-to-sdk-messages';
import { estimateTokens, estimateConversationTokens } from './utils/estimate-tokens';
import { EEntryType, ESystemSubtype } from '@/types/index';
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

  /** Check if context exceeds the compaction threshold. */
  isFull(): boolean {
    const promptTokens = estimateTokens(this.getSystemPrompt());
    const convTokens = estimateConversationTokens(this.getMessages());
    return promptTokens + convTokens > this.maxTokens * COMPACT_THRESHOLD_RATIO;
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
