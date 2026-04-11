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
 * Both getMessages() and restore() use this to ensure recent context is preserved.
 */
const RECENT_TOKEN_BUDGET = 20_000;

/** Maximum retry attempts for the LLM summarizer call. */
export const COMPACT_MAX_RETRIES = 2;

// --- ContextManager ---

export class ContextManager {
  private readonly maxTokens: number;

  /**
   * Cached compact state — updated by compact() and restore(), read by getMessages().
   * Null means no compaction has occurred.
   */
  private compactSummary: string | null = null;

  /**
   * Index into the conversation array: entries from this index onward are the
   * "recent" entries that should be sent to the LLM alongside the summary.
   * Updated together with compactSummary.
   */
  private compactStartIdx = 0;

  constructor(
    private state: BaseWayangState,
    private staticPrompt: string,
    private dynamicContextFn: () => string,
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
    parts.push('\n' + this.dynamicContextFn());
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

  /**
   * Compact the conversation by summarizing all current entries.
   *
   * Appends a compact marker entry to the conversation (and JSONL file).
   * Does NOT modify or remove any existing entries — storage is append-only.
   *
   * The summarizer receives ALL entries and returns a summary.
   * After compaction, getMessages() returns [summary] + entries appended after the marker.
   */
  async compact(summarizer: (entries: any[]) => Promise<string>): Promise<void> {
    const conversation = this.state.get<any[]>('conversation');
    if (conversation.length < 4) return;

    const summary = await summarizer(conversation);

    // Cache the summary and set startIdx to current length
    // (entries after this index — i.e. future entries — will be included verbatim)
    this.compactSummary = summary;
    this.compactStartIdx = conversation.length;

    // Append compact marker — a normal system entry persisted to JSONL
    this.state.append('conversation', {
      type: EEntryType.System,
      uuid: generateId('compact'),
      parentUuid: null,
      sessionId: this.state.get<string>('runtimeState.session.id') ?? '',
      timestamp: nowISO(),
      subtype: ESystemSubtype.Compact,
      content: summary,
      compactMeta: {
        summarizedTokenCount: estimateConversationTokens(conversation),
      },
    });
  }

  /**
   * Restore compact state from persisted conversation.
   *
   * Scans for the latest compact marker, then loads recent entries within
   * the token budget. If loaded entries are fewer than RECENT_TOKEN_BUDGET,
   * continues loading past the marker (overlap with summary is acceptable).
   */
  restoreFromEntries(entries: any[]): void {
    // Find the latest compact marker (SystemEntry with Compact subtype)
    const compactIdx = entries.findLastIndex(
      (e) => e.type === EEntryType.System && e.subtype === ESystemSubtype.Compact,
    );

    if (compactIdx === -1) {
      this.compactSummary = null;
      this.compactStartIdx = 0;
      return;
    }

    const summary = entries[compactIdx].content as string;

    // From the marker, walk backwards to fill the token budget
    let budget = RECENT_TOKEN_BUDGET;
    let cutIdx = 0;
    for (let i = compactIdx - 1; i >= 0; i--) {
      const tokens = estimateEntryTokens(entries[i]);
      budget -= tokens;
      if (budget <= 0) {
        cutIdx = i + 1;
        break;
      }
    }

    this.compactSummary = summary;
    this.compactStartIdx = compactIdx - cutIdx;
  }
}

// --- Helpers ---

/** Estimate tokens for a single conversation entry. */
function estimateEntryTokens(entry: any): number {
  const content = entry.message?.content ?? entry.content ?? '';
  let tokens = estimateTokens(String(content));
  if (entry.toolCalls?.length) {
    for (const tc of entry.toolCalls) {
      tokens += estimateTokens(tc.arguments ?? '');
    }
  }
  if (entry.toolResults?.length) {
    for (const tr of entry.toolResults) {
      tokens += estimateTokens(tr.output?.value ?? '');
    }
  }
  return tokens;
}
