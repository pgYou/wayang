/**
 * SessionManager — manages the current session's metadata.
 *
 * Created via static factories:
 * - SessionManager.create() — new session, initializes meta via WayangState
 * - SessionManager.resume() — existing session, restores from disk
 */

import * as path from 'node:path';
import { formatTimestamp } from '@/utils/id';
import { sessionDisplayTitle, wayangDirForSessionDir } from '@/infra/session-helpers';
import type { SessionMeta } from '@/infra/session-helpers';
import { normalizeWorkspacePath, resolveWorkspaceRef } from '@/infra/workspace-registry';
import type { WorkspaceRef } from '@/infra/workspace-registry';
import { SessionState } from './session-state';

export class SessionManager {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly isResume: boolean;
  /** Wayang home dir (parent of `sessions/`), or null for ad-hoc session dirs. */
  private readonly wayangDir: string | null;
  private state: SessionState;

  private constructor(sessionId: string, sessionDir: string, isResume: boolean, wayangDir: string | null) {
    this.sessionId = sessionId;
    this.sessionDir = sessionDir;
    this.isResume = isResume;
    this.wayangDir = wayangDir;
    this.state = new SessionState(sessionDir);
  }

  /** Create a new session: generates ID, initializes meta via WayangState (auto mkdir + write). */
  static create(homeDir: string, workspaceDir: string): SessionManager {
    const sessionId = `${formatTimestamp()}-${Math.random().toString(36).slice(2, 6)}`;
    const sessionDir = path.join(homeDir, 'sessions', sessionId);
    const mgr = new SessionManager(sessionId, sessionDir, false, homeDir);

    // Initialize meta via state — persistence layer handles mkdir + write.
    // `workspace` (single value) stays for older readers; `workspaces` carries
    // the same workspace as its first entry.
    mgr.state.set('meta', {
      sessionId,
      workspace: workspaceDir,
      workspaces: [resolveWorkspaceRef(homeDir, workspaceDir)],
      firstInput: null,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    });

    return mgr;
  }

  /**
   * Resume an existing session. State is restored in restore().
   *
   * @param wayangDir  Wayang home dir, used to resolve workspace slugs. Omitted
   *   callers fall back to the layout-derived parent of `sessions/`.
   */
  static resume(sessionId: string, sessionDir: string, wayangDir?: string): SessionManager {
    return new SessionManager(sessionId, sessionDir, true, wayangDir ?? wayangDirForSessionDir(sessionDir));
  }

  /** Restore state from disk (resume only, no-op for new sessions). */
  async restore(): Promise<void> {
    if (!this.isResume) return;
    await this.state.restore();
    this.backfillWorkspaces();
  }

  /** Workspace directory of this session. */
  get workspace(): string {
    return this.state.get<string>('meta.workspace');
  }

  /**
   * Workspace identities of this session, always including the one matching
   * `workspace`. Legacy meta (written before `workspaces` existed) is
   * synthesized on read — see `backfillWorkspaces`.
   */
  get workspaces(): WorkspaceRef[] {
    this.backfillWorkspaces();
    return this.state.get<WorkspaceRef[] | undefined>('meta.workspaces') ?? [];
  }

  /**
   * Workspace this session was *started* in — the backfill target for records
   * that predate workspace attribution (e.g. legacy tasks.json entries).
   *
   * Deliberately not `workspaces[0]`: once a session accumulates more than one
   * workspace, the first array element is merely "the oldest one we happen to
   * have", not necessarily the startup workspace, and stamping old tasks with
   * it would point them at the wrong directory. `meta.workspace` stays
   * authoritative for "where this session was started" (see SessionMeta), so we
   * look up the entry that matches it after canonicalization — the array's
   * `path` is canonical, while `meta.workspace` keeps the original spelling
   * (symlinks, trailing slash).
   *
   * Falls back to the first entry when nothing matches (the startup directory
   * was renamed or removed since), and returns undefined when the session has
   * no workspace identity at all — callers then simply skip the backfill.
   */
  get startupWorkspace(): WorkspaceRef | undefined {
    const workspaces = this.workspaces;
    if (workspaces.length === 0) return undefined;
    const current = this.state.get<string | undefined>('meta.workspace');
    if (current) {
      const normalized = normalizeWorkspacePath(current);
      const match = workspaces.find(ws => normalizeWorkspacePath(ws.path) === normalized);
      if (match) return match;
    }
    return workspaces[0];
  }

  /**
   * Synthesize `meta.workspaces` from the single-valued `meta.workspace` when a
   * session predates the array. Memory only: nothing is written, so neither
   * resume nor `workspaces` ever rewrites a historical meta.json.
   *
   * Idempotent — a filled array short-circuits, and `resolveWorkspaceRef`
   * returns the same slug for the same canonical path, so repeated reads of one
   * legacy session yield an identical result.
   */
  private backfillWorkspaces(): void {
    const existing = this.state.get<WorkspaceRef[] | undefined>('meta.workspaces');
    if (existing && existing.length > 0) return;
    const workspace = this.state.get<string | undefined>('meta.workspace');
    // An empty/absent workspace means a half-written meta; leave it untouched.
    if (!workspace) return;
    this.state.fillWorkspacesInMemory(resolveWorkspaceRef(this.wayangDir, workspace));
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

  /** Current display label: explicit title, else first input. */
  get displayTitle(): string | null {
    return sessionDisplayTitle(this.state.get<SessionMeta>('meta'));
  }

  /** Whether this session is archived (hidden from the default list). */
  get archived(): boolean {
    return this.state.get<boolean | undefined>('meta.archived') ?? false;
  }

  /**
   * Rename the session. Passing null/empty clears the explicit title, so the
   * session falls back to showing its first input.
   */
  rename(title: string | null): void {
    const trimmed = title?.trim();
    this.state.set('meta.title', trimmed && trimmed.length > 0 ? trimmed : undefined);
  }

  /**
   * Toggle the archived flag. Archiving hides the session from the default
   * list without deleting its transcript; unarchiving restores visibility.
   */
  setArchived(archived: boolean): void {
    this.state.set('meta.archived', archived);
    this.state.set('meta.archivedAt', archived ? Date.now() : undefined);
  }
}
