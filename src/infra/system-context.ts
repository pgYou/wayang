import type { WayangConfig, ProviderConfig } from '@/types/index';
import type { Logger } from './logger';
import { createLogger } from './logger';

export class SystemContext {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly workspaceDir: string;
  readonly startedAt: number;
  readonly logLevel: string;
  readonly logger: Logger;
  readonly abortController: AbortController;
  readonly config: WayangConfig;

  constructor(config: WayangConfig, sessionId: string, sessionDir: string, workspaceDir: string, logLevel?: string) {
    this.config = config;
    this.sessionId = sessionId;
    this.sessionDir = sessionDir;
    this.workspaceDir = workspaceDir;
    this.startedAt = Date.now();
    this.logLevel = logLevel ?? 'info';
    this.abortController = new AbortController();

    this.logger = createLogger(this.logLevel, `${sessionDir}/wayang.log`).child({
      session: sessionId,
    });
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
