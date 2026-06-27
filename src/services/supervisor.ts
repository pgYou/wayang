import { SystemContext } from '@/infra/system-context';
import { SignalQueue } from '@/services/signal/signal-queue';
import { TaskExecuteEngine } from '@/services/task-execute-engine';
import { ControllerLoop } from '@/services/controller-loop';
import { SessionManager } from '@/services/session/session-manager';
import { ControllerAgent } from './agents/controller-agent';
import { SkillRegistry } from '@/services/skills/registry';
import { resolveSkillDirs } from '@/services/skills/skill-dir';
import { readSessionUnfinishedTasks } from '@/infra/session-helpers';
import type { WayangConfig } from '@/types/index';

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
   * resumed session has unfinished tasks. Defaults to true (sessionless).
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
  private controllerLoop: ControllerLoop;
  private readonly resumeSessionDir?: string;
  private readonly injectPreviousTasks: boolean;

  constructor(options: SupervisorOptions) {
    const { config, workspaceDir, logLevel } = options;
    this.resumeSessionDir = options.resume?.sessionDir;
    this.injectPreviousTasks = options.injectPreviousTasks ?? true;

    // Create session manager
    if (options.resume) {
      this.sessionManager = SessionManager.resume(options.resume.sessionId, options.resume.sessionDir);
    } else {
      if (!options.homeDir) throw new Error('homeDir is required for new sessions');
      this.sessionManager = SessionManager.create(options.homeDir, workspaceDir);
    }

    // Create system context (logger, providers, hooks, abort controller)
    this.ctx = new SystemContext(
      config,
      this.sessionManager.sessionId,
      this.sessionManager.sessionDir,
      workspaceDir,
      logLevel,
    );

    this.ctx.logger.info(
      { controllerEndpoint: this.ctx.controllerProvider.endpoint, controllerModel: this.ctx.controllerProvider.modelName },
      'Provider config',
    );

    // Create services
    this.signalQueue = new SignalQueue(this.ctx);

    // Shared skill registry (global + project + config dirs).
    this.skills = new SkillRegistry(
      resolveSkillDirs(workspaceDir, config.skillsDirs),
      this.ctx.logger,
    );

    this.engine = new TaskExecuteEngine(this.ctx, this.signalQueue, this.skills);
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

    await Promise.all([
      this.sessionManager.restore(),
      this.controllerAgent.restore(),
      this.engine.restore(),
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

  // --- Shutdown ---

  async shutdown(): Promise<void> {
    this.controllerLoop.shutdown();
    this.engine.abortAll();
    this.ctx.abortController.abort();

    this.ctx.logger.info('Supervisor shutdown complete');
  }
}
