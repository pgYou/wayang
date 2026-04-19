import { SystemContext } from '@/infra/system-context';
import { SignalQueue } from '@/services/signal/signal-queue';
import { TaskExecuteEngine } from '@/services/task-execute-engine';
import { ControllerLoop } from '@/services/controller-loop';
import { SessionManager } from '@/services/session/session-manager';
import { ControllerAgent } from './agents/controller-agent';
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
}

export class Supervisor {
  readonly ctx: SystemContext;
  readonly signalQueue: SignalQueue;
  readonly engine: TaskExecuteEngine;
  readonly controllerAgent: ControllerAgent;
  readonly sessionManager: SessionManager;
  private controllerLoop: ControllerLoop;

  constructor(options: SupervisorOptions) {
    const { config, workspaceDir, logLevel } = options;

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
    this.engine = new TaskExecuteEngine(this.ctx, this.signalQueue);
    this.controllerAgent = ControllerAgent.create({
      ctx: this.ctx,
      provider: this.ctx.controllerProvider,
      config,
      engine: this.engine,
      signalQueue: this.signalQueue,
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
    await Promise.all([
      this.sessionManager.restore(),
      this.controllerAgent.restore(),
      this.engine.restore(),
      this.signalQueue.restore(),
    ]);

    this.ctx.logger.info('Supervisor restored');
  }

  async start(): Promise<void> {
    // Set controller session info
    this.controllerAgent.initSession({
      id: this.ctx.sessionId,
      startedAt: this.ctx.startedAt,
    });

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
