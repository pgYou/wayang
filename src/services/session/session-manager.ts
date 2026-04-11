/**
 * SessionManager — manages the current session's metadata.
 *
 * Created via static factories:
 * - SessionManager.create() — new session, initializes meta via WayangState
 * - SessionManager.resume() — existing session, restores from disk
 */

import * as path from 'node:path';
import { formatTimestamp } from '@/utils/id';
import { SessionState } from './session-state';

export class SessionManager {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly isResume: boolean;
  private state: SessionState;

  private constructor(sessionId: string, sessionDir: string, isResume: boolean) {
    this.sessionId = sessionId;
    this.sessionDir = sessionDir;
    this.isResume = isResume;
    this.state = new SessionState(sessionDir);
  }

  /** Create a new session: generates ID, initializes meta via WayangState (auto mkdir + write). */
  static create(homeDir: string, workspaceDir: string): SessionManager {
    const sessionId = `${formatTimestamp()}-${Math.random().toString(36).slice(2, 6)}`;
    const sessionDir = path.join(homeDir, 'sessions', sessionId);
    const mgr = new SessionManager(sessionId, sessionDir, false);

    // Initialize meta via state — persistence layer handles mkdir + write
    mgr.state.set('meta', {
      sessionId,
      workspace: workspaceDir,
      firstInput: null,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    });

    return mgr;
  }

  /** Resume an existing session. State is restored in restore(). */
  static resume(sessionId: string, sessionDir: string): SessionManager {
    return new SessionManager(sessionId, sessionDir, true);
  }

  /** Restore state from disk (resume only, no-op for new sessions). */
  async restore(): Promise<void> {
    if (!this.isResume) return;
    await this.state.restore();
  }

  /** Workspace directory of this session. */
  get workspace(): string {
    return this.state.get<string>('meta.workspace');
  }

  /** Whether firstInput has already been recorded. */
  get hasFirstInput(): boolean {
    return !!this.state.get<string | null>('meta.firstInput');
  }

  /**
   * Notify that a user input occurred.
   * Records firstInput (idempotent) and updates lastActiveAt.
   */
  onUserInput(text: string): void {
    if (!this.hasFirstInput) {
      this.state.set('meta.firstInput', text);
    }
    this.state.set('meta.lastActiveAt', Date.now());
  }
}
