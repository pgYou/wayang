import { join } from 'node:path';
import type { TaskDetail } from '@/types/index';
import type { Logger } from '@/infra/logger';
import { BaseWayangState } from '@/infra/state/base-state';
import { JSONFileHelper } from '@/infra/state/persistence/json-file';

interface TaskPoolData {
  tasks: {
    pending: TaskDetail[];
    running: TaskDetail[];
    history: TaskDetail[];
  };
}

export class TaskPoolState extends BaseWayangState {
  private jsonFile: JSONFileHelper;

  constructor(
    private sessionDir: string,
    private logger: Logger,
  ) {
    const jsonFile = new JSONFileHelper(join(sessionDir, 'tasks.json'));

    super(
      {
        tasks: {
          pending: [],
          running: [],
          history: [],
        },
      },
      [{ path: 'tasks', helper: jsonFile }],
    );

    this.jsonFile = jsonFile;
  }

  async restore(): Promise<void> {
    const data = this.jsonFile.read() as TaskPoolData['tasks'] | null;
    if (data) {
      this.data.tasks = data;
    }
    this.logger.info('TaskPoolState restored');
  }
}
