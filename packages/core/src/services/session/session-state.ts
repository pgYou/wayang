/**
 * SessionState — persistence backing for SessionManager.
 */

import { join } from 'node:path';
import type { SessionMeta } from '@/infra/session-helpers';
import type { WorkspaceRef } from '@/infra/workspace-registry';
import { BaseWayangState } from '@/infra/state/base-state';
import { JSONFileHelper } from '@/infra/state/persistence/json-file';

export class SessionState extends BaseWayangState {
  private jsonFile: JSONFileHelper;

  constructor(sessionDir: string) {
    const jsonFile = new JSONFileHelper(join(sessionDir, 'meta.json'));
    super(
      {
        meta: {
          sessionId: '',
          workspace: '',
          firstInput: null,
          createdAt: 0,
          lastActiveAt: 0,
          title: undefined,
          archived: false,
          archivedAt: undefined,
        } satisfies SessionMeta,
      },
      [{ path: 'meta', helper: jsonFile }],
    );
    this.jsonFile = jsonFile;
  }

  async restore(): Promise<void> {
    const data = this.jsonFile.read() as SessionMeta | null;
    if (data) {
      this.data.meta = data;
    }
  }

  /**
   * Attach a synthesized `workspaces` entry to the in-memory meta only — no
   * write happens here, so reading a legacy session never rewrites its file.
   * The value reaches disk with the next normal meta write (input, rename,
   * archive), because snapshot persistence serializes the whole meta object.
   */
  fillWorkspacesInMemory(workspace: WorkspaceRef): void {
    const meta = this.data.meta as SessionMeta | undefined;
    if (!meta) return;
    meta.workspaces = [workspace];
  }
}
