// --- Config ---

/**
 * LLM tool-choice mode passed through to the provider (OpenAI `tool_choice`).
 * - 'required': force the model to emit a tool call on every step. This is the
 *   default for puppet workers — it guarantees the worker eventually finishes
 *   via the done/fail tools instead of stopping on plain text.
 * - 'auto': let the model decide. Needed for OpenAI-compatible endpoints that
 *   reject `tool_choice: "required"` with HTTP 400 (e.g. internal llmproxy).
 * - 'none': disable tool calls.
 */
export type ToolChoice = 'auto' | 'required' | 'none';

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
  worker: {
    provider: string;
    maxConcurrency: number;
    /**
     * Tool-choice mode for puppet workers. Defaults to 'required' — the worker
     * is forced to call tools each step so it must terminate via done/fail.
     * Some OpenAI-compatible endpoints (e.g. internal llmproxy) reject
     * `tool_choice: "required"` with HTTP 400; set to 'auto' for those.
     */
    toolChoice?: ToolChoice;
  };
  /** Third-party worker definitions, keyed by worker ID. */
  workers?: Record<string, WorkerConfig>;
  /** Tavily API key for web_search tool. Optional — tool returns error if unset. */
  tavilyApiKey?: string;
  /** Extra directories to scan for skills (in addition to global + workspace). */
  skillsDirs?: string[];
  /** Idle timeout (ms) for multi-stage workers before they are reaped. Defaults to 30 min. */
  idleTimeoutMs?: number;
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
