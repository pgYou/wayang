import { join } from 'node:path';
import type { TaskDetail } from '@/types/index';
import type { WorkspaceRef } from '@/infra/workspace-registry';
import type { Logger } from '@/infra/logger';
import { BaseWayangState } from '@/infra/state/base-state';
import { JSONFileHelper } from '@/infra/state/persistence/json-file';
import type { SystemContext } from '@/infra/system-context';

interface TaskPoolData {
  tasks: {
    pending: TaskDetail[];
    running: TaskDetail[];
    history: TaskDetail[];
  };
}

export class TaskPoolState extends BaseWayangState {
  private jsonFile: JSONFileHelper;
  private readonly logger: Logger;

  constructor(ctx: SystemContext) {
    const jsonFile = new JSONFileHelper(join(ctx.sessionDir, 'tasks.json'));

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
    this.logger = ctx.logger;
  }

  async restore(): Promise<void> {
    const data = this.jsonFile.read() as TaskPoolData['tasks'] | null;
    if (data) {
      this.data.tasks = data;
    }
    this.logger.info('TaskPoolState restored');
  }

  /**
   * Stamp `workspace` onto restored tasks that predate task workspace
   * attribution, using the session's own workspace as the fallback.
   *
   * Memory only — no persist call, so restoring a legacy session never rewrites
   * its tasks.json (the value reaches disk with the next normal task write,
   * exactly like `SessionState.fillWorkspacesInMemory`).
   *
   * Idempotent and non-destructive: a task that already carries a workspace is
   * left untouched, so repeated restores (and tasks stamped at add time) are
   * unaffected.
   */
  fillWorkspaceInMemory(fallback: WorkspaceRef): void {
    const buckets = this.data.tasks as TaskPoolData['tasks'] | undefined;
    if (!buckets) return;
    for (const bucket of [buckets.pending, buckets.running, buckets.history]) {
      if (!Array.isArray(bucket)) continue;
      for (const task of bucket) {
        if (!task || task.workspace) continue;
        task.workspace = { path: fallback.path, slug: fallback.slug };
      }
    }
  }
}
