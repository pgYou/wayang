import type { WayangConfig } from '@/types/index';
import type { Logger } from './logger';
import { createFileLogger, type FileLogger } from './logger';
import { LifecycleHooks } from '@/services/lifecycle-hooks';

export class SystemContext {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly workspaceDir: string;
  readonly startedAt: number;
  readonly logLevel: string;
  readonly logger: Logger;
  readonly abortController: AbortController;
  readonly config: WayangConfig;
  readonly hooks: LifecycleHooks;
  /** The log sink this context owns; `logger` above is a child of it. */
  private readonly logSink: FileLogger;
  private closeLoggerPromise?: Promise<void>;

  constructor(config: WayangConfig, sessionId: string, sessionDir: string, workspaceDir: string, logLevel?: string) {
    this.config = config;
    this.sessionId = sessionId;
    this.sessionDir = sessionDir;
    this.workspaceDir = workspaceDir;
    this.startedAt = Date.now();
    this.logLevel = logLevel ?? 'info';
    this.abortController = new AbortController();
    this.hooks = new LifecycleHooks();

    // The sink writes <sessionDir>/wayang.log through pino-pretty on the main
    // thread, rotating by size (config `logging`, defaults 10MB × 3 backups —
    // issue #52). SystemContext owns that sink so callers get an awaitable
    // teardown — see closeLogger().
    this.logSink = createFileLogger(this.logLevel, `${sessionDir}/wayang.log`, {
      maxFileSizeBytes: config.logging?.maxFileSizeBytes,
      maxFiles: config.logging?.maxFiles,
    });
    this.logger = this.logSink.logger.child({
      session: sessionId,
    });
  }

  /**
   * Flush and close the log sink, ending its transport worker thread.
   *
   * Once the returned promise resolves, this context's logger will never
   * touch the session directory again: the log file is fully flushed and
   * the worker thread has exited. Idempotent — repeated calls return the
   * same promise — and log calls made afterwards are safely ignored.
   */
  closeLogger(): Promise<void> {
    this.closeLoggerPromise ??= this.logSink.close();
    return this.closeLoggerPromise;
  }

  get controllerProvider() {
    return this.config.providers[this.config.controller.provider];
  }
  get workerProvider() {
    return this.config.providers[this.config.worker.provider];
  }
  get maxConcurrency() {
    return this.config.worker.maxConcurrency;
  }
}
