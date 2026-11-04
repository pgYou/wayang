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
  /**
   * Context window budget (input side) for this provider's model — NOT the
   * OpenAI-protocol `max_tokens` (which caps output). Drives controller
   * compaction, which triggers at 90% of this budget (workers do not compact
   * yet). Optional — defaults to 256k tokens; set it for smaller-window
   * models (e.g. 128k), otherwise the provider rejects the request before
   * compaction ever triggers. Must be a positive integer.
   */
  contextWindowTokens?: number;
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

/**
 * How sensitive (credential/tool-config) paths are handled.
 * - 'ask' (default): a hit in EITHER direction — read or write — requests
 *   controller approval. The request and the audit record name the matched
 *   entry, the canonical path and the direction, and the operation only
 *   proceeds once approved.
 * - 'deny': restore the pre-0.8.1 behaviour — refuse reads and writes without
 *   ever asking. Escape hatch for users who never want to be prompted.
 *
 * Neither mode can make a sensitive hit pass without review: the sensitive list
 * outranks every allow rule (workspace, task `allowedDirs`, config
 * `allowedDirs` / `autoAllowRoots`), so the only choice is "ask or refuse".
 */
export type SensitiveMode = 'ask' | 'deny';

/**
 * Path permission policy (consumed by `src/infra/permission/policy.ts`).
 * All fields are optional and additive: omitting the section keeps the
 * previous behaviour exactly. Relative entries resolve against the user's
 * home directory.
 */
export interface PermissionConfig {
  /** Directories always allowed, for both reads and writes. */
  allowedDirs?: string[];
  /** Extra roots auto-allowed (no approval prompt). */
  autoAllowRoots?: string[];
  /**
   * Extra sensitive directories, appended to the built-in sensitive list
   * (which cannot be removed). Reads AND writes there ask for approval, or are
   * refused when `sensitiveMode` is 'deny'. Also accepts the deprecated
   * `deniedDirs` alias — see there.
   */
  sensitiveDirs?: string[];
  /**
   * @deprecated Use `sensitiveDirs`. Kept as an alias so existing configs keep
   * protecting the directories they declare (a config file lives on disk with
   * no migration tool). Still read, merged with `sensitiveDirs` and deduped;
   * using it logs a one-time deprecation warning at config load.
   */
  deniedDirs?: string[];
  /** How sensitive hits are handled. Defaults to 'ask'. */
  sensitiveMode?: SensitiveMode;
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
  /** Path permission policy. Optional — the defaults apply when omitted. */
  permission?: PermissionConfig;
}

/** Validate required fields, return error message or null */
export function validateConfig(config: WayangConfig): string | null {
  for (const [name, provider] of Object.entries(config.providers)) {
    if (!provider.endpoint) return `providers.${name}.endpoint is required`;
    if (!provider.apiKey) return `providers.${name}.apiKey is required (set WAYANG_LLM_API_KEY or configure in config file)`;
    if (!provider.modelName) return `providers.${name}.modelName is required`;
    const window = provider.contextWindowTokens;
    if (window !== undefined && !(Number.isInteger(window) && window > 0)) {
      return `providers.${name}.contextWindowTokens must be a positive integer (got ${JSON.stringify(window)})`;
    }
  }
  const cp = config.controller.provider;
  if (!config.providers[cp]) return `controller.provider "${cp}" not found`;
  const wp = config.worker.provider;
  if (!config.providers[wp]) return `worker.provider "${wp}" not found`;
  const permission = config.permission;
  if (permission !== undefined && permission !== null) {
    // `deniedDirs` is the deprecated alias of `sensitiveDirs`; both are read,
    // so both get the same shape check.
    const keys = ['allowedDirs', 'autoAllowRoots', 'sensitiveDirs', 'deniedDirs'] as const;
    for (const key of keys) {
      const value = permission[key];
      if (value === undefined) continue;
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        return `permission.${key} must be an array of strings (got ${JSON.stringify(value)})`;
      }
    }
    const mode = permission.sensitiveMode;
    if (mode !== undefined && mode !== 'ask' && mode !== 'deny') {
      return `permission.sensitiveMode must be 'ask' or 'deny' (got ${JSON.stringify(mode)})`;
    }
  }
  return null;
}
