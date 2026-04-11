// --- Config ---

export interface ProviderConfig {
  endpoint: string;
  apiKey: string;
  modelName: string;
}

/** Third-party worker configuration. */
export interface WorkerConfig {
  /** Implementation type identifier (e.g. 'claude-code'). */
  type: string;
  /** Whether this worker is enabled. Defaults to true. */
  enable?: boolean;
  /** Display emoji for quick visual identification. */
  emoji?: string;
  /** Natural language description for Controller LLM. */
  description: string;
  /** Capability tags for task routing. */
  capabilities?: string[];
  /** Max agent execution turns. */
  maxTurns?: number;
  /** Path to the worker CLI executable. Defaults to auto-detect. */
  cliPath?: string;
}

export interface WayangConfig {
  providers: Record<string, ProviderConfig>;
  controller: { provider: string };
  worker: { provider: string; maxConcurrency: number };
  /** Third-party worker definitions, keyed by worker ID. */
  workers?: Record<string, WorkerConfig>;
}

/** Validate required fields, return error message or null */
export function validateConfig(config: WayangConfig): string | null {
  for (const [name, provider] of Object.entries(config.providers)) {
    if (!provider.endpoint) return `providers.${name}.endpoint is required`;
    if (!provider.apiKey) return `providers.${name}.apiKey is required (set WAYANG_LLM_API_KEY or configure in config file)`;
    if (!provider.modelName) return `providers.${name}.modelName is required`;
  }
  const cp = config.controller.provider;
  if (!config.providers[cp]) return `controller.provider "${cp}" not found`;
  const wp = config.worker.provider;
  if (!config.providers[wp]) return `worker.provider "${wp}" not found`;
  return null;
}
