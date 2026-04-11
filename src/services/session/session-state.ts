/**
 * SessionState — persistence backing for SessionManager.
 */

import { join } from 'node:path';
import type { SessionMeta } from '@/infra/session-helpers';
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
}
