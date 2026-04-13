/**
 * WorkerFactory — creates worker instances by type.
 *
 * 'puppet' → WorkerAgent (built-in LLM worker)
 * configured IDs (e.g. 'claude-code') → third-party workers
 */

import type { IWorkerInstance } from '@/types/worker';
import type { WorkerConfig, ProviderConfig } from '@/types/index';
import { SystemContext } from '@/infra/system-context';
import { WorkerAgent } from './agents/worker-agent';
import { ClaudeCodeWorker } from './agents/claude-code-worker';

/** Reserved worker type for the built-in LLM worker. */
export const PUPPET_WORKER_TYPE = 'puppet';

/** Dependencies needed to create any worker type. */
export interface WorkerCreateDeps {
  /** Provider config for puppet workers. */
  workerProvider: ProviderConfig;
  /** Session storage directory. */
  sessionDir: string;
  /** Workspace (tool cwd). */
  workspaceDir: string;
  /** System context. */
  ctx: SystemContext;
  /** Third-party worker configurations from WayangConfig.workers. */
  workerConfigs?: Record<string, WorkerConfig>;
}

export class WorkerFactory {
  /**
   * Create a worker instance for the given type.
   *
   * @throws Error if the worker type is unknown or unsupported.
   */
  create(workerType: string | undefined, deps: WorkerCreateDeps): IWorkerInstance {
    const type = workerType ?? PUPPET_WORKER_TYPE;

    // Built-in puppet worker
    if (type === PUPPET_WORKER_TYPE) {
      return new WorkerAgent(deps.workerProvider, deps.sessionDir, deps.workspaceDir, deps.ctx);
    }

    // Third-party worker — look up config
    const config = deps.workerConfigs?.[type];
    if (!config) {
      throw new Error(`Unknown worker type: "${type}". Available: ${Object.keys(deps.workerConfigs ?? {}).join(', ') || '(none)'}`);
    }
    if (config.enable === false) {
      throw new Error(`Worker type "${type}" is disabled`);
    }

    switch (config.type) {
      case 'claude-code':
        return new ClaudeCodeWorker(config, deps.sessionDir, deps.workspaceDir, deps.ctx);
      default:
        throw new Error(`Unsupported worker type: "${config.type}"`);
    }
  }

  /** Check whether a worker type is known (puppet or configured). */
  isKnownType(workerType: string | undefined, workerConfigs?: Record<string, WorkerConfig>): boolean {
    if (!workerType || workerType === PUPPET_WORKER_TYPE) return true;
    return !!workerConfigs?.[workerType];
  }
}
