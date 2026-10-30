import { join } from 'node:path';
import type { ConversationEntry, ConversationIndex, InquireQuestion, SystemEntry, TurnView } from '@/types/index';
import { isCompactMarker } from '@/types/index';
import type { Logger } from '@/infra/logger';
import { BaseWayangState } from '@/infra/state/base-state';
import { JSONFileHelper } from '@/infra/state/persistence/json-file';
import { JSONLFileHelper } from '@/infra/state/persistence/jsonl-file';
import { ConversationIndexBuilder } from '@/services/conversation/conversation-index';
import { RECENT_TOKEN_BUDGET } from './context-manager';
import type { TurnEnvelope } from './utils/entry-envelope';
import { estimateEntryTokens } from './utils/estimate-tokens';
import type { SystemContext } from '@/infra/system-context';


interface ControllerRuntimeState {
  session: { id: string; startedAt: number };
  /** Controller's private scratchpad — persists across context compaction. */
  notebook: string;
  /** Active inquiry from controller to user — null when no inquiry pending. */
  pendingInquiry: InquireQuestion | null;
}

interface DynamicState {
  /** Entries currently being streamed — cleared when step completes. */
  streamingEntries: ConversationEntry[];
  /** Whether the controller LLM is currently processing — ephemeral, never persisted. */
  busy: boolean;
  /**
   * Turn lineage of the controller run in flight — set at the start of each
   * run(), read by the add_task tool (via getTurnContext) to stamp tasks.
   * Ephemeral, never persisted.
   */
  currentTurn: TurnEnvelope | null;
}

interface ControllerStateData {
  runtimeState: ControllerRuntimeState;
  conversation: ConversationEntry[];
  compactSummary: string | null;
  /** Transient UI state — not persisted. */
  dynamicState: DynamicState;
}

export class ControllerAgentState extends BaseWayangState {
  private jsonFile: JSONFileHelper;
  private jsonlFile: JSONLFileHelper;
  private readonly logger: Logger;
  /** In-memory turn index — built in restore(), fed incrementally on append. */
  private convIndex: ConversationIndexBuilder | null = null;
  /** In-memory resolve function for the current inquiry — never persisted. */
  private inquiryResolver: ((answer: string) => void) | null = null;

  constructor(ctx: SystemContext) {
    const jsonFile = new JSONFileHelper(join(ctx.sessionDir, 'runtime-state.json'));
    const jsonlFile = new JSONLFileHelper(join(ctx.sessionDir, 'conversation.jsonl'));

    const initialData: ControllerStateData = {
      runtimeState: {
        session: { id: '', startedAt: 0 },
        notebook: '',
        pendingInquiry: null,
      },
      conversation: [],
      compactSummary: null,
      dynamicState: { streamingEntries: [], busy: false, currentTurn: null },
    };

    super(initialData, [
      { path: 'runtimeState', helper: jsonFile },
      { path: 'conversation', helper: jsonlFile },
    ]);

    this.jsonFile = jsonFile;
    this.jsonlFile = jsonlFile;
    this.logger = ctx.logger;
  }

  /**
   * Append with turn-index feeding: mechanical envelope fields (v / parentId,
   * compaction-boundary aware) are stamped by BaseWayangState.append via the
   * shared conversation-envelope module — the single source of truth. This
   * override only feeds the in-memory turn index incrementally.
   */
  append(path: string, entry: unknown): void {
    super.append(path, entry);
    if (path === 'conversation' && this.convIndex) {
      this.convIndex.onAppend(entry as ConversationEntry);
    }
  }

  /** Read the full persisted conversation (all JSONL lines, ignoring the in-memory window). */
  readFullConversation(): ConversationEntry[] {
    return this.jsonlFile.read() as ConversationEntry[];
  }

  /** Read-only turn index (live view; callers must not mutate). */
  getConversationIndex(): ConversationIndex {
    return this.convIndex?.getIndex() ?? { turns: [], byEntryId: new Map() };
  }

  /** Look up one turn by id. */
  getTurn(turnId: string): TurnView | undefined {
    return this.convIndex?.getTurn(turnId);
  }

  async restore(): Promise<void> {
    // Restore runtime state from JSON
    const runtimeState = this.jsonFile.read() as ControllerRuntimeState | null;
    if (runtimeState) {
      this.data.runtimeState = runtimeState;
    }

    // Restore conversation from JSONL
    const allEntries = this.jsonlFile.read() as ConversationEntry[];

    // Structural marker check: only system entries carrying compactMeta count.
    // Legacy subtype='compact' records without it must not trigger windowing.
    const compactIdx = allEntries.findLastIndex(isCompactMarker);

    if (compactIdx === -1) {
      // No compaction — load everything
      this.data.conversation = allEntries;
      this.data.compactSummary = null;
    } else {
      // Walk backwards from the marker to fill the token budget.
      // estimateEntryTokens counts tool call arguments and tool result outputs
      // too, so heavy tool entries push the window start forward.
      let budget = RECENT_TOKEN_BUDGET;
      let cutIdx = 0;
      for (let i = compactIdx - 1; i >= 0; i--) {
        budget -= estimateEntryTokens(allEntries[i]);
        if (budget <= 0) {
          cutIdx = i + 1;
          break;
        }
      }
      this.data.conversation = allEntries.slice(cutIdx);
      // Expose the summary for the upper layer (ControllerAgent.restore wires
      // it into ContextManager.restoreCompact). Memory-only: 'compactSummary'
      // is not a persisted path, so this never touches disk.
      // (findLastIndex's guard does not narrow the indexed element — assert it.)
      const marker = allEntries[compactIdx] as SystemEntry;
      this.data.compactSummary = marker.content;
    }

    this.logger.info({
      entryCount: this.data.conversation.length,
      totalEntries: allEntries.length,
    }, 'ControllerAgentState restored');

    // Build the in-memory turn index from the FULL persisted history (the
    // in-memory conversation may be a compact window). Live appends are fed
    // incrementally by the append() override — no full rebuilds.
    this.convIndex = new ConversationIndexBuilder(allEntries);
  }

  /** Set a pending inquiry and return a Promise that resolves when the user answers. */
  askInquiry(question: InquireQuestion): Promise<string> {
    return new Promise<string>((resolve) => {
      this.inquiryResolver = resolve;
      this.set('runtimeState.pendingInquiry', question);
    });
  }

  /** Resolve the pending inquiry with the user's answer. */
  resolveInquiry(answer: string): void {
    if (this.inquiryResolver) {
      this.inquiryResolver(answer);
      this.inquiryResolver = null;
    }
    this.set('runtimeState.pendingInquiry', null);
  }
}
