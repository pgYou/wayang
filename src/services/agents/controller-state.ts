import { join } from 'node:path';
import type { ConversationEntry, InquireQuestion } from '@/types/index';
import { EEntryType, ESystemSubtype, isSystemEntry, getEntryContent } from '@/types/index';
import type { Logger } from '@/infra/logger';
import { BaseWayangState } from '@/infra/state/base-state';
import { JSONFileHelper } from '@/infra/state/persistence/json-file';
import { JSONLFileHelper } from '@/infra/state/persistence/jsonl-file';
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
      dynamicState: { streamingEntries: [], busy: false },
    };

    super(initialData, [
      { path: 'runtimeState', helper: jsonFile },
      { path: 'conversation', helper: jsonlFile },
    ]);

    this.jsonFile = jsonFile;
    this.jsonlFile = jsonlFile;
    this.logger = ctx.logger;
  }

  async restore(): Promise<void> {
    // Restore runtime state from JSON
    const runtimeState = this.jsonFile.read() as ControllerRuntimeState | null;
    if (runtimeState) {
      this.data.runtimeState = runtimeState;
    }

    // Restore conversation from JSONL
    const allEntries = this.jsonlFile.read() as ConversationEntry[];

    // Check for compact marker — if found, load recent entries within token budget
    const compactIdx = allEntries.findLastIndex(
      (e) => isSystemEntry(e) && e.subtype === ESystemSubtype.Compact,
    );

    if (compactIdx === -1) {
      // No compaction — load everything
      this.data.conversation = allEntries;
    } else {
      // Walk backwards from marker to fill token budget
      const RECENT_TOKEN_BUDGET = 20_000;
      let budget = RECENT_TOKEN_BUDGET;
      let cutIdx = 0;
      for (let i = compactIdx - 1; i >= 0; i--) {
        const entry = allEntries[i];
        const content = getEntryContent(entry);
        budget -= Math.ceil(String(content).length / 4);
        if (budget <= 0) {
          cutIdx = i + 1;
          break;
        }
      }
      this.data.conversation = allEntries.slice(cutIdx);
    }

    this.logger.info({
      entryCount: this.data.conversation.length,
      totalEntries: allEntries.length,
    }, 'ControllerAgentState restored');
  }

  /** Override append to ensure JSONL write-per-entry. */
  append(path: string, entry: unknown): void {
    super.append(path, entry);
    if (path === 'conversation') {
      this.persistAppend(path, entry);
    }
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
