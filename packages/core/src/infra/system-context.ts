import { join } from 'node:path';
import type { StoragePaths, WayangConfig, WorkspacePolicy } from '@wayang-ai/protocol';
import type { Logger } from './logger';
import { createFileLogger, type FileLogger } from './logger';
import { LifecycleHooks } from '../services/lifecycle-hooks';
import { resolveModelRef, type EnvModelFallback, type ResolvedModel } from '../services/config/model-resolution';

/**
 * The deployment facts SystemContext runs on (monorepo-design 4.2 改造二).
 * Both groups are INJECTED — resolved by the host (or by the Supervisor's
 * CLI-default assembly, which assigns the already-resolved session dir /
 * launch workspace) — never derived inside this class from the session
 * layout or the process state.
 */
export interface SystemContextPaths {
  /** Storage locations: data root, session log dir, session cache dir. */
  storage: StoragePaths;
  /** Workspace anchors: controller dispatch baseline, default worker workspace. */
  workspace: WorkspacePolicy;
}

export class SystemContext {
  readonly sessionId: string;
  readonly sessionDir: string;
  /**
   * The controller's workspace (dispatch baseline + controller tool cwd).
   * Compatibility alias of `workspacePolicy.controllerWorkspace` — the field
   * name predates the policy split and is read all over core.
   */
  readonly workspaceDir: string;
  /** Injected storage paths (monorepo-design 4.2). */
  readonly storagePaths: StoragePaths;
  /** Injected workspace anchors (monorepo-design 4.2). */
  readonly workspacePolicy: WorkspacePolicy;
  readonly startedAt: number;
  readonly logLevel: string;
  readonly logger: Logger;
  readonly abortController: AbortController;
  readonly config: WayangConfig;
  readonly hooks: LifecycleHooks;
  /** The log sink this context owns; `logger` above is a child of it. */
  private readonly logSink: FileLogger;
  private closeLoggerPromise?: Promise<void>;

  constructor(
    config: WayangConfig,
    sessionId: string,
    sessionDir: string,
    logLevel: string | undefined,
    paths: SystemContextPaths,
  ) {
    this.config = config;
    this.sessionId = sessionId;
    this.sessionDir = sessionDir;
    this.workspacePolicy = paths.workspace;
    this.workspaceDir = paths.workspace.controllerWorkspace;
    this.storagePaths = paths.storage;
    this.startedAt = Date.now();
    this.logLevel = logLevel ?? 'info';
    this.abortController = new AbortController();
    this.hooks = new LifecycleHooks();

    // The sink writes <logDir>/wayang.log through pino-pretty on the main
    // thread, rotating by size (config `logging`, defaults 10MB × 3 backups —
    // issue #52). SystemContext owns that sink so callers get an awaitable
    // teardown — see closeLogger(). The logDir is the INJECTED one (CLI
    // default: the session directory — the 0.9.9 layout unchanged).
    this.logSink = createFileLogger(this.logLevel, this.logFilePath, {
      maxFileSizeBytes: config.logging?.maxFileSizeBytes,
      maxFiles: config.logging?.maxFiles,
    });
    this.logger = this.logSink.logger.child({
      session: sessionId,
    });
  }

  /** Absolute path of this context's log file (`<storagePaths.logDir>/wayang.log`). */
  get logFilePath(): string {
    return join(this.storagePaths.logDir, 'wayang.log');
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

  /**
   * Model the controller runs on (issue #88): `controller.model` (a `models`
   * key, `"provider/name"` composite or inline entry) first, then the legacy
   * `controller.provider` binding as an implicit model, then the `WAYANG_*`
   * environment fallback.
   */
  get controllerModel(): ResolvedModel {
    return resolveModelRef(
      this.config,
      this.config.controller.model,
      this.config.controller.provider,
      envModelFallback(),
    );
  }
  /** Same resolution for the default puppet worker model (`worker.model` / legacy `worker.provider`). */
  get workerModel(): ResolvedModel {
    return resolveModelRef(
      this.config,
      this.config.worker.model,
      this.config.worker.provider,
      envModelFallback(),
    );
  }
  get maxConcurrency() {
    return this.config.worker.maxConcurrency;
  }
}

/**
 * Implicit `default` model built from the `WAYANG_*` environment variables
 * (the same values onboard writes into `providers.default`). Only complete
 * triplets qualify — the resolution layer ignores a partial fallback.
 */
function envModelFallback(): EnvModelFallback | undefined {
  const apiKey = process.env.WAYANG_LLM_API_KEY;
  const baseURL = process.env.WAYANG_ENDPOINT;
  const modelName = process.env.WAYANG_MODEL;
  if (!apiKey || !baseURL || !modelName) return undefined;
  const rawWindow = process.env.WAYANG_CONTEXT_WINDOW_TOKENS;
  const contextWindowTokens = rawWindow ? Number(rawWindow) : NaN;
  return {
    apiKey,
    baseURL,
    modelName,
    ...(Number.isFinite(contextWindowTokens) && contextWindowTokens > 0 && { contextWindowTokens }),
  };
}
