import type { WayangConfig, ProviderConfig } from '@/types/index';
import type { Logger } from './logger';
import { createLogger } from './logger';

export class SystemContext {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly workspaceDir: string;
  readonly startedAt: number;
  readonly logLevel: string;
  readonly controllerProvider: ProviderConfig;
  readonly workerProvider: ProviderConfig;
  readonly maxConcurrency: number;
  readonly logger: Logger;
  readonly abortController: AbortController;

  constructor(config: WayangConfig, sessionId: string, sessionDir: string, workspaceDir: string, logLevel?: string) {
    this.sessionId = sessionId;
    this.sessionDir = sessionDir;
    this.workspaceDir = workspaceDir;
    this.startedAt = Date.now();
    this.logLevel = logLevel ?? 'info';
    this.abortController = new AbortController();

    this.controllerProvider = config.providers[config.controller.provider];
    this.workerProvider = config.providers[config.worker.provider];
    this.maxConcurrency = config.worker.maxConcurrency;

    this.logger = createLogger(this.logLevel, `${sessionDir}/wayang.log`).child({
      session: sessionId,
    });
  }
}
