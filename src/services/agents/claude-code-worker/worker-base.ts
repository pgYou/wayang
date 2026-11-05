// ClaudeWorkerBase: the ClaudeCodeWorker fields (original declaration order),
// constructor, turn-envelope builder and base state / messaging surface.

import type { WorkerConfig, WorkerResult, TaskDetail } from '@/types/index';
import type { WorkerLiveStatus } from '@/types/worker';
import type { Logger } from '@/infra/logger';
import type { StateEvent } from '@/infra/state/base-state';
import type { AssistantEntry } from '@/types/conversation';
import { WorkerState } from '../worker-state';
import { type TurnEnvelope } from '../utils/entry-envelope';
import { generateId } from '@/utils/id';
import { SystemContext } from '@/infra/system-context';
import { wayangDirForSessionDir } from '@/infra/session-helpers';
import { resolveWorkspaceRef } from '@/infra/workspace-registry';
import type { WorkspaceRef } from '@/infra/workspace-registry';
import type { SignalQueue } from '@/services/signal/signal-queue';
import type { PermissionMiddlewareResult } from '@/services/tools/permission-middleware';
import type { WorkerAccessScope } from '@/services/tools/permission-rules';
import { BlockingRequestMap } from '@/infra/blocking-requests';
import type { SkillRegistry } from '@/services/skills/registry';
import type { SignalTurnLineage } from '@/types/index';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';

export class ClaudeWorkerBase {
  readonly id: string;
  protected readonly config: WorkerConfig;
  protected readonly state: WorkerState;
  /** Workspace this worker executes in — fixed at construction (IWorkerInstance). */
  readonly workspaceDir: string;
  protected readonly logger: Logger;
  protected readonly abortController = new AbortController();
  protected _terminalResult: WorkerResult | null = null;
  /** True once the SDK message stream of the current run has closed (issue #16). */
  protected _streamEnded = false;

  // --- Controller messaging via streamInput ---
  protected _messageQueue: string[] = [];
  protected _messageResolve: ((value: void) => void) | null = null;
  /**
   * True while run() is executing. Controller messages are rejected once the
   * run's input has closed (see `_inputClosed`), but idle multi-stage workers
   * (no run in flight) keep accepting — the next stage folds them into its
   * opening prompt.
   */
  protected _runInFlight = false;
  /**
   * True once the prompt iterator reported done for the current run: the
   * session can no longer take input (a turn result arrived with nothing
   * queued, or the run was aborted). Further acceptMessage calls fail
   * explicitly instead of pretending to queue.
   */
  protected _inputClosed = false;

  // --- Tool-call recording (see utils/claude-tool-records.ts) ---
  /**
   * Assistant steps buffered while their tool results are still in flight.
   * The SDK stream splits one LLM step across two messages (assistant
   * tool_use → user tool_result), but the schema stores a step atomically on
   * one AssistantEntry and storage is append-only — so the entry waits in
   * memory until its results arrive (or the stream ends). FIFO order is kept:
   * only the head is flushed, so the file order always matches arrival order.
   */
  protected _pendingToolSteps: AssistantEntry[] = [];

  // --- ask_controller via in-process SDK MCP server ---
  protected _askController: ((question: string, context?: string) => Promise<string>) | null = null;

  // --- Permission control via canUseTool ---
  protected readonly _pendingPermissions = new BlockingRequestMap<PermissionResult>();

  /** Exposed for engine to resolve pending permission requests. */
  readonly permissionHandler: PermissionMiddlewareResult = {
    resolvePermission: (requestId: string, approved: boolean, reason?: string) => {
      return this._pendingPermissions.resolve(
        requestId,
        approved
          ? { behavior: 'allow' }
          : { behavior: 'deny', message: reason ?? 'Denied by controller' },
      );
    },
    cleanup: () => {
      this._pendingPermissions.cleanupAll(() => ({ behavior: 'deny', message: 'Worker aborted' }));
    },
    wrappedTools: {}, // not used for ClaudeCodeWorker
  };

  // Signal context set during run()
  protected _signalQueue: SignalQueue | null = null;
  protected _runContext: { workerId: string; taskId: string; taskTitle: string; workerType?: string; emoji?: string } | null = null;
  /**
   * Shared permission policy scope for this run (workspace, task allowedDirs,
   * userHome, config). Provided by the engine via setSignalContext so the
   * canUseTool callback judges access exactly like a puppet worker's
   * permission middleware does. Null until wired; a fallback scope derived
   * from the worker's own directory is used when absent.
   */
  protected _accessScope: WorkerAccessScope | null = null;
  /** Session directory this worker belongs to (workspace-registry lookup). */
  private readonly sessionDir: string;
  /** Turn lineage for permission-request signals emitted by this worker. */
  protected _turnLineage: SignalTurnLineage = {};
  /** Turn lineage stamped on entries written by the run in flight. */
  protected _currentTurnEnv: TurnEnvelope | null = null;

  protected _progressTimer: ReturnType<typeof setTimeout> | null = null;
  protected _pendingProgress: string | null = null;

  protected readonly ctx: SystemContext;
  protected readonly skills: SkillRegistry;
  /**
   * Registry identity of the workspace this worker executes in, resolved once
   * at construction. Feeds the `workspaceSlug` on turn envelopes (and the
   * runtime-state stamp) so entries stay attributable to a directory.
   */
  private readonly workspaceRef?: WorkspaceRef;

  /**
   * Turn identity: one worker run = one turn. The engine passes the task's
   * execution turn id; rootTurnId is inherited from the task; the task is
   * the direct cause of this activation.
   */
  protected buildTurnEnv(task: TaskDetail & { workerId: string }): TurnEnvelope {
    // The task's own workspace stamp wins (add_task resolves it through the
    // registry); otherwise fall back to the directory this worker was built
    // for. Both are known here, so entries never leave `workspaceSlug` unset.
    const workspaceSlug = task.workspace?.slug ?? this.workspaceRef?.slug;
    return {
      turnId: task.executionTurnId ?? generateId('turn'),
      ...((task.rootTurnId ?? task.turnId) !== undefined && { rootTurnId: task.rootTurnId ?? task.turnId }),
      causationId: task.id,
      actor: { kind: 'worker', id: task.workerId, taskId: task.id },
      ...(workspaceSlug !== undefined && { workspaceSlug }),
    };
  }

  constructor(
    config: WorkerConfig,
    sessionDir: string,
    workspaceDir: string,
    ctx: SystemContext,
    skills: SkillRegistry,
  ) {
    this.id = generateId('cw');
    this.ctx = ctx;
    this.config = config;
    this.workspaceDir = workspaceDir;
    this.sessionDir = sessionDir;
    this.logger = ctx.logger;
    this.skills = skills;
    // Workspace identity is stamped into runtime-state (see WorkerState) and
    // reused for the turn envelope's `workspaceSlug`.
    this.workspaceRef = resolveWorkspaceRef(wayangDirForSessionDir(sessionDir), workspaceDir);
    this.state = new WorkerState(
      sessionDir,
      this.id,
      ctx.logger,
      this.workspaceRef,
    );
  }

  /** Set signal context for permission requests. Called by engine before run(). */
  setSignalContext(deps: {
    signalQueue: SignalQueue;
    workerId: string;
    taskId: string;
    taskTitle: string;
    workerType?: string;
    emoji?: string;
    /** Turn lineage attached to signals emitted by this worker. */
    turnLineage?: SignalTurnLineage;
    /**
     * Shared permission policy scope (workspace / taskAllowedDirs / userHome /
     * config). The engine supplies the exact scope it uses for puppet workers,
     * so canUseTool reaches the same allow/ask/deny verdicts. Omitted only by
     * direct construction (tests) — a scope derived from this worker's own
     * directory is then used.
     */
    accessScope?: WorkerAccessScope;
  }): void {
    this._signalQueue = deps.signalQueue;
    this._runContext = deps;
    this._turnLineage = deps.turnLineage ?? {};
    this._accessScope = deps.accessScope ?? null;
  }

  /** Get state for UI rendering. */
  getState(): WorkerState {
    return this.state;
  }

  /**
   * Live run flags (issue #16): `resultReceived` flips as soon as the SDK result
   * message lands, `streamEnded` when the message loop exits. The gap between
   * them is exactly the #15 window where the controller saw nothing.
   */
  getLiveStatus(): WorkerLiveStatus {
    return { resultReceived: this._terminalResult !== null, streamEnded: this._streamEnded };
  }

  /** Get conversation entries. */
  getConversation(): import('@/types/conversation').ConversationEntry[] {
    return this.state.get<import('@/types/conversation').ConversationEntry[]>('conversation') ?? [];
  }

  // --- Subscribable ---

  subscribe(path: string, callback: (event: StateEvent) => void): () => void {
    return this.state.on(path, callback);
  }

  getSnapshot<T>(path: string): T {
    return this.state.get(path);
  }

  /**
   * Accept a message from the controller. The message is queued and handed
   * to the SDK only when it pulls the next prompt: the CLI parks pulled
   * prompts in an internal queue that it drains strictly BETWEEN turns, so
   * delivery always lands on a turn boundary — a tool call in progress is
   * never cut off (the v0.6 interrupt delivery did exactly that and killed
   * the session with an orphaned tool_use; see docs/develop/v0.6-design.md
   * §6.1 — the hazard is any unclosed tool_use, not just a pending
   * permission).
   *
   * Returns false when delivery is impossible: the run's input has closed
   * (final result received) or the worker was aborted. Idle multi-stage
   * workers (no run in flight) always accept — the next stage folds the
   * message into its opening prompt.
   */
  acceptMessage(message: string): boolean {
    if (this.abortController.signal.aborted) return false;
    if (this._runInFlight && this._inputClosed) return false;
    this._messageQueue.push(message);
    if (this._messageResolve) {
      this._messageResolve();
      this._messageResolve = null;
    }
    this.logger.info({ workerId: this.id }, 'Controller message accepted');
    return true;
  }

  /** Unread controller messages (non-destructive) — engine reports these when the run ends. */
  pendingMessages(): string[] {
    return [...this._messageQueue];
  }

  /**
   * Provide the engine-backed ask_controller implementation. Once set, the
   * worker exposes it to Claude Code as an in-process SDK MCP tool.
   */
  setInquirySupport(ask: (question: string, context?: string) => Promise<string>): void {
    this._askController = ask;
  }

  protected flushMessageQueue(): void {
    this._messageQueue.length = 0;
    if (this._messageResolve) {
      this._messageResolve();
      this._messageResolve = null;
    }
  }
}
