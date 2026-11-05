// Types exported from the task-execute-engine module (stable import surface).

import type { PermissionConfig } from '@/types/config';
import type { WorkspaceRef } from '@/infra/workspace-registry';

/** Construction options for TaskExecuteEngine. */
export interface TaskExecuteEngineOptions {
  /**
   * The user's home directory the path permission policy anchors on (sensitive
   * list and read scope). Always the PROCESS home (`os.homedir()`) when
   * omitted — never derived from the session layout: where wayang keeps its
   * data (`--wayang-root`) has nothing to do with whose home the policy
   * protects. Inject it explicitly in tests (which use temp home dirs) to
   * keep the boundary controlled.
   */
  userHome?: string;
  /**
   * User-config permission section (`allowedDirs` / `autoAllowRoots` /
   * `sensitiveDirs`, plus the deprecated `deniedDirs` alias and
   * `sensitiveMode`) the policy consults. Defaults to `ctx.config.permission`;
   * injectable so a caller can hand the engine the exact policy it should
   * enforce instead of relying on ambient config.
   */
  permission?: PermissionConfig;
  /**
   * Notified when a task is accepted for a workspace, so the owning session
   * can accumulate every workspace it dispatches work into. The engine stays
   * unaware of session persistence — Supervisor supplies an implementation
   * that appends to the session's `meta.workspaces` (idempotent by canonical
   * path). Optional: without it, workspace accumulation simply does not
   * happen (used by tests and by direct engine construction).
   */
  onTaskWorkspace?: (workspace: WorkspaceRef) => void;
}

/** Resolution of a pending ask_controller call, settled via the registry. */
export type WorkerInquiryResolution =
  | { kind: 'answer'; answer: string }
  | { kind: 'timeout' }
  | { kind: 'aborted' };

/**
 * Outcome of delivering a controller message to a worker.
 * - 'delivered' / 'queued': the worker accepted the message (it reads it at
 *   its next step / turn boundary / stage start).
 * - 'finished': the worker is still listed as running but can no longer take
 *   input (a third-party worker's session ended) — the message was NOT
 *   delivered and the caller must report failure.
 * - 'not_running': no such active worker.
 */
export type WorkerMessageDelivery = 'delivered' | 'queued' | 'finished' | 'not_running';
