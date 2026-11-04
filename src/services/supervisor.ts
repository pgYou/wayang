import { SystemContext } from '@/infra/system-context';
import { SignalQueue } from '@/services/signal/signal-queue';
import { TaskExecuteEngine } from '@/services/task-execute-engine';
import { ControllerLoop } from '@/services/controller-loop';
import { SessionManager } from '@/services/session/session-manager';
import { ControllerAgent } from './agents/controller-agent';
import { SkillRegistry } from '@/services/skills/registry';
import { resolveSkillDirs } from '@/services/skills/skill-dir';
import { readSessionUnfinishedTasks } from '@/infra/session-helpers';
import { SessionLock } from '@/infra/session-lock';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ConversationIndex, TurnView, WayangConfig } from '@/types/index';

/** Parameters for Supervisor initialization. */
export interface SupervisorOptions {
  config: WayangConfig;
  workspaceDir: string;
  logLevel?: string;
  /** Resume a specific session. Omit for new session. */
  resume?: { sessionId: string; sessionDir: string };
  /** Home directory for sessions storage. Required for new sessions. */
  homeDir?: string;
  /**
   * Whether to inject a `previous_session_tasks` signal at resume when the
   * resumed session has unfinished tasks. Defaults to false — only the
   * sessionless default-inherit path (bootstrap, not --resume) sets this true,
   * so an explicit `--resume` is treated as "continue this exact session"
   * without re-surfacing stale tasks.
   */
  injectPreviousTasks?: boolean;
}

export class Supervisor {
  readonly ctx: SystemContext;
  readonly signalQueue: SignalQueue;
  readonly engine: TaskExecuteEngine;
  readonly controllerAgent: ControllerAgent;
  readonly sessionManager: SessionManager;
  /** Shared skill registry — discovered at startup, used by all agents. */
  readonly skills: SkillRegistry;
  /** Exclusive ownership of this session's directory (see SessionLock). */
  readonly sessionLock: SessionLock;
  private controllerLoop: ControllerLoop;
  private readonly resumeSessionDir?: string;
  private readonly injectPreviousTasks: boolean;

  constructor(options: SupervisorOptions) {
    const { config, workspaceDir, logLevel } = options;
    this.resumeSessionDir = options.resume?.sessionDir;
    this.injectPreviousTasks = options.injectPreviousTasks ?? false;

    // Create session manager
    if (options.resume) {
      this.sessionManager = SessionManager.resume(
        options.resume.sessionId,
        options.resume.sessionDir,
        options.homeDir,
      );
    } else {
      if (!options.homeDir) throw new Error('homeDir is required for new sessions');
      this.sessionManager = SessionManager.create(options.homeDir, workspaceDir);
    }

    // Take ownership of the session directory BEFORE anything writes into it.
    // Both paths need the lock: a resumed session already has a transcript that
    // a second process would append to concurrently, and a new session must not
    // be reopened by another process either. Acquiring here (rather than in
    // restore()/start()) means a conflict aborts construction before the log
    // sink below opens <sessionDir>/wayang.log from a worker thread.
    // Throws SessionLockedError carrying the holder's pid/startedAt/session dir.
    this.sessionLock = new SessionLock(this.sessionManager.sessionDir);
    const lockResult = this.sessionLock.acquire();

    // Create system context (logger, providers, hooks, abort controller)
    this.ctx = new SystemContext(
      config,
      this.sessionManager.sessionId,
      this.sessionManager.sessionDir,
      workspaceDir,
      logLevel,
    );

    if (lockResult.staleTakeover) {
      // The previous owner died without releasing (SIGKILL, power loss). We
      // replaced its lock after the heartbeat expired — worth warning about,
      // since that session's last run ended abnormally.
      this.ctx.logger.warn(
        { sessionDir: this.sessionManager.sessionDir },
        'Took over a stale session lock left by an abnormally terminated process',
      );
    }

    this.ctx.logger.info(
      { controllerEndpoint: this.ctx.controllerProvider.endpoint, controllerModel: this.ctx.controllerProvider.modelName },
      'Provider config',
    );

    // Create services
    this.signalQueue = new SignalQueue(this.ctx);

    // Shared skill registry (global + project + config dirs). The global dir
    // lives under the wayang DATA dir (follows `--wayang-root`), not the
    // process home.
    this.skills = new SkillRegistry(
      resolveSkillDirs(options.homeDir ?? join(homedir(), '.wayang'), workspaceDir, config.skillsDirs),
      this.ctx.logger,
    );

    // Workspace accumulation: a task accepted for a workspace the session has
    // not touched yet is appended to `meta.workspaces` (idempotent by canonical
    // path). Without this, only SessionManager.create ever wrote the list, so a
    // session that dispatched into a second directory could not be found by
    // `getLatestSessionForWorkspace` and the picker showed a single workspace.
    this.engine = new TaskExecuteEngine(this.ctx, this.signalQueue, this.skills, {
      onTaskWorkspace: (workspace) => {
        this.sessionManager.addWorkspace(workspace);
      },
    });
    this.controllerAgent = ControllerAgent.create({
      ctx: this.ctx,
      provider: this.ctx.controllerProvider,
      config,
      engine: this.engine,
      signalQueue: this.signalQueue,
      skills: this.skills,
    });

    this.controllerLoop = new ControllerLoop(
      this.ctx,
      this.signalQueue,
      this.controllerAgent,
      {
        getRunningCount: () => this.engine.getRunningCount(),
        getActiveWorkers: () => this.engine.getActiveWorkers(),
        getPendingCount: () => this.engine.list('pending').length,
        getWorkerActivity: (workerId: string) => this.engine.getWorkerActivity(workerId),
      },
    );
  }

  // --- Lifecycle ---

  async restore(): Promise<void> {
    // Snapshot unfinished tasks from the resumed session BEFORE engine.restore
    // runs recoverCrashedTasks (which marks running tasks as failed). This way
    // the controller still sees what was pending/in-flight.
    let previousTasks: { id: string; title: string; description: string; status: 'pending' | 'running' }[] | null = null;
    if (this.resumeSessionDir && this.injectPreviousTasks) {
      previousTasks = readSessionUnfinishedTasks(this.resumeSessionDir);
    }

    // Restore the session first: the task engine needs this session's
    // workspace identity to backfill tasks that predate workspace attribution
    // (legacy tasks.json). Session restore is a single synchronous file read,
    // so serializing it ahead of the rest costs nothing meaningful.
    await this.sessionManager.restore();
    // Backfill target is the session's STARTUP workspace (the entry matching
    // meta.workspace), not an arbitrary first array element: once a session
    // accumulates several workspaces, element 0 can be a different directory
    // and legacy tasks would be stamped with the wrong one. `startupWorkspace`
    // already falls back to element 0 when the startup dir no longer matches,
    // and yields undefined when the session has no workspace identity — in
    // which case no fallback is passed and old tasks stay unattributed, as
    // before.
    const sessionWorkspace = this.sessionManager.startupWorkspace;

    await Promise.all([
      this.controllerAgent.restore(),
      this.engine.restore(sessionWorkspace),
      this.signalQueue.restore(),
    ]);

    // Inject the previous-session-tasks signal so the controller can decide
    // whether to re-dispatch. Workers are NOT auto-resumed (recoverCrashedTasks
    // already marked running tasks as failed).
    if (previousTasks && previousTasks.length > 0) {
      this.signalQueue.enqueue({
        source: 'system',
        type: 'previous_session_tasks',
        payload: {
          sessionId: this.ctx.sessionId,
          lastActiveAt: Date.now(),
          tasks: previousTasks.map(t => ({
            taskId: t.id,
            title: t.title,
            description: t.description,
            status: t.status,
          })),
        },
      });
      this.ctx.logger.info({ count: previousTasks.length }, 'Injected previous_session_tasks signal');
    }

    this.ctx.logger.info('Supervisor restored');
  }

  async start(): Promise<void> {
    // Set controller session info
    this.controllerAgent.initSession({
      id: this.ctx.sessionId,
      startedAt: this.ctx.startedAt,
    });

    // Cold-start compaction: when resuming (notably the sessionless default),
    // the inherited conversation tail may already exceed the context window.
    // Compact once before the loop starts so the first signal isn't processed
    // against an overflowing context. No-op when already within budget.
    if (this.controllerAgent.needsCompaction()) {
      this.ctx.logger.info('Cold-start: inherited context exceeds budget, compacting');
      await this.controllerAgent.performCompaction();
    }

    // Start controller loop (fire-and-forget, runs until abort)
    this.controllerLoop.start().catch((err) => {
      this.ctx.logger.error({ error: err.message }, 'Controller loop crashed');
    });

    this.ctx.logger.info('Supervisor started');
  }

  // --- Inquiry ---

  /** Resolve a pending controller inquiry with the user's answer. */
  resolveInquiry(answer: string): void {
    this.controllerAgent.resolveInquiry(answer);
  }

  // --- Read-only conversation index (WebUI / audit) ---

  /** Grouped turn view over the controller conversation. */
  getConversationIndex(): ConversationIndex {
    return this.controllerAgent.getConversationIndex();
  }

  /** Look up one turn of the controller conversation by id. */
  getTurn(turnId: string): TurnView | undefined {
    return this.controllerAgent.getTurn(turnId);
  }

  // --- Shutdown ---

  async shutdown(): Promise<void> {
    this.controllerLoop.shutdown();
    this.engine.abortAll();
    this.ctx.abortController.abort();

    // Release the session lock only after the loops above are stopped, so no
    // in-flight work can still write to the transcript once another process is
    // allowed in. Done before the log sink closes so a failed unlink can be
    // logged. release() is idempotent — shutdown() may be called more than
    // once (SIGTERM after an explicit SHUTDOWN, test teardown).
    try {
      this.sessionLock.release();
    } catch (err) {
      // A leftover lock is recoverable: the next process sees an expired
      // heartbeat and takes it over. Never let it break shutdown.
      this.ctx.logger.warn({ error: (err as Error).message }, 'Failed to release session lock');
    }

    this.ctx.logger.info('Supervisor shutdown complete');

    // Close the log sink last: everything above may still log, and this
    // waits for the pino transport worker thread to flush and exit. Before
    // this, that worker kept opening <sessionDir>/wayang.log for a while
    // after construction (even at level 'silent'), racing with anything
    // that cleans the session directory once shutdown() returns.
    await this.ctx.closeLogger();
  }
}
