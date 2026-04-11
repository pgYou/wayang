import { join } from 'node:path';
import type { ConversationEntry } from '@/types/index';
import type { Logger } from '@/infra/logger';
import { BaseWayangState } from '@/infra/state/base-state';
import { JSONFileHelper } from '@/infra/state/persistence/json-file';
import { JSONLFileHelper } from '@/infra/state/persistence/jsonl-file';

interface WorkerRuntimeState {
  session: { id: string; startedAt: number };
  task: { id: string; description: string };
}

interface WorkerStateData {
  runtimeState: WorkerRuntimeState;
  conversation: ConversationEntry[];
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
    const conversation = this.jsonlFile.read() as ConversationEntry[];
    if (conversation.length > 0) {
      this.data.conversation = conversation;
    }
    this.logger.info('WorkerState restored');
  }

  /** Override append to ensure JSONL write-per-entry. */
  append(path: string, entry: unknown): void {
    super.append(path, entry);
    if (path === 'conversation') {
      this.persistAppend(path, entry);
    }
  }
}
