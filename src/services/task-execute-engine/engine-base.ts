// TaskEngineBase: the shared fields, constructor and state subscriptions of
// TaskExecuteEngine. All layers of the engine extend this base.

import type { SystemContext } from '@/infra/system-context';
import type { SignalQueue } from '@/services/signal/signal-queue';
import type { Logger } from '@/infra/logger';
import type { ActiveWorkerInfo, IWorkerInstance, ProviderConfig, WorkerConfig } from '@/types/index';
import { TaskPoolState } from '@/services/task/task-pool-state';
import { BaseWayangState } from '@/infra/state/base-state';
import type { Subscribable } from '@/infra/state/subscribable';
import type { StateEvent } from '@/infra/state/base-state';
import type { SkillRegistry } from '@/services/skills/registry';
import type { PermissionConfig } from '@/types/config';
import type { WorkspaceRef } from '@/infra/workspace-registry';
import type { PermissionMiddlewareResult } from '@/services/tools/permission-middleware';
import { ApprovalMemory } from '@/services/permission/approval-memory';
import { BlockingRequestMap } from '@/infra/blocking-requests';
import type { TaskExecuteEngineOptions, WorkerInquiryResolution } from './types';
import { homedir } from 'node:os';

/** Runtime-only observable state — no file persistence, no restore needed. */
class RuntimeState extends BaseWayangState {
  constructor(initialData: Record<string, unknown>) {
    super(initialData, []);
  }
  async restore(): Promise<void> { /* no-op: runtime-only */ }
}

export const PUPPET_WORKER_TYPE = 'puppet';

/** Default idle timeout: idle workers are reaped after 30 minutes if not reused. */
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export class TaskEngineBase implements Subscribable {
  protected taskState: TaskPoolState;
  protected workerState: RuntimeState;

  protected readonly logger: Logger;
  protected readonly maxConcurrency: number;
  protected readonly workerProvider: ProviderConfig;
  protected readonly workerConfigs?: Record<string, WorkerConfig>;
  protected readonly skills: SkillRegistry;

  /** Worker instance tracking. */
  protected workers = new Map<string, IWorkerInstance>();
  /** Reverse mapping: workerId → taskId. */
  protected workerTaskMap = new Map<string, string>();
  /** Permission middleware resolvers keyed by workerId. */
  protected permissionResolvers = new Map<string, PermissionMiddlewareResult>();
  /** ask_controller blocking-request registries keyed by workerId. */
  protected inquiryRegistries = new Map<string, BlockingRequestMap<WorkerInquiryResolution>>();
  /**
   * Inquiry ids aborted by worker shutdown/cancel. Lets a late respond_inquiry
   * distinguish "worker gone" from "timed out" even while other workers'
   * registries are still alive.
   */
  protected abortedInquiryIds = new Set<string>();
  /**
   * Turn lineage of each active worker's current run: the execution turn id
   * (also handed to the worker for stamping its entries), the chain's root
   * turn, and the task id (used as signals' causationId).
   */
  protected workerTurnLineage = new Map<string, { turnId: string; rootTurnId?: string; taskId: string }>();
  /**
   * Running tasks cancelled via cancel(): their (aborted) worker resolution
   * must not re-classify the task or emit a worker_failed signal — the
   * task_cancelled signal was already emitted at cancel time. Cleared when
   * the worker's run promise settles (handleDone/handleFail).
   */
  protected cancelledTaskIds = new Set<string>();
  /** Idle-reaping timers keyed by workerId (multi-stage workers only). */
  protected idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Idle TTL (ms). Idle workers are disposed after this if not reused. */
  protected readonly idleTimeoutMs: number;
  /** The user's home directory the path permission policy anchors on. */
  protected readonly userHome: string;
  /** User-config permission section applied to this run's worker tools. */
  protected readonly permission?: PermissionConfig;
  /** Session-side hook: remember every workspace a task is accepted for. */
  protected readonly onTaskWorkspace?: (workspace: WorkspaceRef) => void;
  /**
   * Task-scoped approval grants (#46): one store per engine (= per session),
   * handed to every worker's permission middleware so a grant approved in one
   * worker run is visible to the next run of the SAME task. Nothing is
   * persisted — a resumed session builds a new engine and starts empty.
   */
  readonly approvalGrants = new ApprovalMemory();

  constructor(
    protected readonly ctx: SystemContext,
    protected readonly signalQueue: SignalQueue,
    skills: SkillRegistry,
    options: TaskExecuteEngineOptions = {},
  ) {
    this.logger = ctx.logger;
    this.userHome = options.userHome ?? homedir();
    this.permission = options.permission ?? ctx.config.permission;
    this.onTaskWorkspace = options.onTaskWorkspace;
    this.maxConcurrency = ctx.maxConcurrency;
    this.workerProvider = ctx.workerProvider;
    this.workerConfigs = ctx.config.workers;
    this.skills = skills;
    this.idleTimeoutMs = ctx.config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

    // Internal state objects
    this.taskState = new TaskPoolState(ctx);
    this.workerState = new RuntimeState({ activeWorkers: [] as ActiveWorkerInfo[] });
  }

  // ---------------------------------------------------------------------------
  // Subscribable
  // ---------------------------------------------------------------------------

  subscribe(path: string, callback: (event: StateEvent) => void): () => void {
    if (path.startsWith('tasks.')) return this.taskState.on(path, callback);
    if (path === 'activeWorkers' || path.startsWith('activeWorkers.')) return this.workerState.on(path, callback);
    throw new Error(`TaskExecuteEngine: unknown subscription path "${path}"`);
  }

  getSnapshot<T>(path: string): T {
    if (path.startsWith('tasks.')) return this.taskState.get(path);
    if (path === 'activeWorkers' || path.startsWith('activeWorkers.')) return this.workerState.get(path);
    throw new Error(`TaskExecuteEngine: unknown snapshot path "${path}"`);
  }
}
