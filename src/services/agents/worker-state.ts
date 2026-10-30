import { join } from 'node:path';
import type { ConversationEntry } from '@/types/index';
import { isCompactMarker } from '@/types/index';
import type { Logger } from '@/infra/logger';
import { BaseWayangState } from '@/infra/state/base-state';
import { JSONFileHelper } from '@/infra/state/persistence/json-file';
import { JSONLFileHelper } from '@/infra/state/persistence/jsonl-file';
import { RECENT_TOKEN_BUDGET } from './context-manager';
import { estimateEntryTokens } from './utils/estimate-tokens';

interface WorkerRuntimeState {
  session: { id: string; startedAt: number };
  task: { id: string; description: string };
}

export interface InboxMessage {
  id: string;
  content: string;
  timestamp: number;
}

interface WorkerStateData {
  runtimeState: WorkerRuntimeState;
  conversation: ConversationEntry[];
  inbox: InboxMessage[];
}

export class WorkerState extends BaseWayangState {
  private jsonFile: JSONFileHelper;
  private jsonlFile: JSONLFileHelper;

  constructor(
    sessionDir: string,
    workerId: string,
    private logger: Logger,
  ) {
    const workerDir = join(sessionDir, 'workers', workerId);
    const jsonFile = new JSONFileHelper(join(workerDir, 'runtime-state.json'));
    const jsonlFile = new JSONLFileHelper(join(workerDir, 'conversation.jsonl'));

    const initialData: WorkerStateData = {
      runtimeState: {
        session: { id: workerId, startedAt: Date.now() },
        task: { id: '', description: '' },
      },
      conversation: [],
      inbox: [],
    };

    super(initialData, [
      { path: 'runtimeState', helper: jsonFile },
      { path: 'conversation', helper: jsonlFile },
    ]);

    this.jsonFile = jsonFile;
    this.jsonlFile = jsonlFile;
  }

  async restore(): Promise<void> {
    const runtimeState = this.jsonFile.read() as WorkerRuntimeState | null;
    if (runtimeState) {
      this.data.runtimeState = runtimeState;
    }
    const allEntries = this.jsonlFile.read() as ConversationEntry[];

    // Same windowing as ControllerAgentState.restore: structural marker check
    // (only system entries carrying compactMeta count), then walk backwards
    // from the marker within RECENT_TOKEN_BUDGET using estimateEntryTokens.
    const compactIdx = allEntries.findLastIndex(isCompactMarker);

    if (compactIdx === -1) {
      if (allEntries.length > 0) {
        this.data.conversation = allEntries;
      }
    } else {
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
    }
    this.logger.info('WorkerState restored');
  }
}
