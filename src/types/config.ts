// --- Config ---

/**
 * LLM tool-choice mode passed through to the provider (OpenAI `tool_choice`).
 * - 'auto': let the model decide. This is the default for puppet workers —
 *   thinking endpoints (DeepSeek/GLM) reject `tool_choice: "required"` with
 *   HTTP 400, so forcing tool calls cannot be the universal default; the
 *   worker system prompt already instructs finishing via done/fail.
 * - 'required': force the model to emit a tool call on every step. Use only
 *   on endpoints that support it, to guarantee termination via done/fail.
 * - 'none': disable tool calls.
 */
export type ToolChoice = 'auto' | 'required' | 'none';

export interface ProviderConfig {
  endpoint: string;
  apiKey: string;
  modelName: string;
  /**
   * Sampling temperature for this provider. Optional — recorded on
   * AssistantEntry.model when set. (Currently metadata-only: requests use
   * the provider default unless the endpoint is configured server-side.)
   */
  temperature?: number;
  /**
   * Max output tokens for this provider. Optional — recorded on
   * AssistantEntry.model when set. (Currently metadata-only.)
   */
  maxOutputTokens?: number;
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
  /**
   * Number of processed (read/discarded) signals retained in the hot window.
   * Unread signals are always kept. Defaults to 2000.
   */
  signalWindowSize?: number;
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
