// --- Config ---

import type { AcpTimeouts } from '@/services/acp/config';
import type { AcpCapabilities } from '@/services/acp/types';

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

/**
 * Implementation type identifiers for configured workers (05 booklet §1).
 * `WORKER_TYPES` is the single source of truth: the dispatch switch cases,
 * `validateConfig`'s allowed values, and error messages all reference it.
 */
export type WorkerType = 'claude-code' | 'acp' | 'codebuddy' | 'opencode';

/** Allowed `workers.<id>.type` values — see `WorkerType` (05 §1). */
export const WORKER_TYPES: readonly WorkerType[] = ['claude-code', 'acp', 'codebuddy', 'opencode'];

/**
 * Pre-0.9.x `workers.<id>.type` values, mapped to their current names.
 * `normalizeWorkerTypes` rewrites them (with a deprecation warning) at the
 * config-parse exit so no consumer ever sees the legacy spellings.
 */
const DEPRECATED_WORKER_TYPES: Readonly<Record<string, WorkerType>> = {
  'codebuddy-acp': 'codebuddy',
  'opencode-acp': 'opencode',
};

/**
 * Rewrite deprecated `workers.<id>.type` values in place, warning once per
 * affected row. Runs at the single config-parse exit (`loadConfig`) BEFORE
 * validation, so `validateConfig` and every downstream consumer only ever
 * see the canonical names — the normalization is not scattered to use sites.
 */
export function normalizeWorkerTypes(config: WayangConfig, warn: (message: string) => void): void {
  for (const [id, worker] of Object.entries(config.workers ?? {})) {
    if (typeof worker !== 'object' || worker === null) continue;
    const current = (worker as { type?: unknown }).type;
    if (typeof current !== 'string') continue;
    const canonical = DEPRECATED_WORKER_TYPES[current];
    if (!canonical) continue;
    (worker as { type: WorkerType }).type = canonical;
    warn(`worker type '${current}' is deprecated, use '${canonical}' (workers.${id})`);
  }
}

/**
 * Protocol-level overrides for `*-acp` workers (05 §3). Field names align
 * with the frozen `AcpTimeouts` (freeze page §2.1) — there is deliberately no
 * second timeout vocabulary. Shape-compatible with the worker layer's
 * `AcpProtocolOverrides` (asserted by tests; C2 must not fork it).
 */
export interface AcpProtocolConfig extends Partial<AcpTimeouts> {
  /**
   * Override the observed capabilities (permissionRequests / toolCalls) with
   * honest values — no downgrade assumptions (05 §3).
   */
  capabilities?: Partial<Pick<AcpCapabilities, 'permissionRequests' | 'toolCalls'>>;
  /**
   * opencode only (measured 2026-11-05, opencode 2.2.5): the agent's default
   * permission rules are allow-all, so `opencode acp` never sends
   * session/request_permission and the wayang permission bridge is inert.
   * `true` (default) makes the worker inject an ask-all permission matrix via
   * the child env's `OPENCODE_CONFIG`; `false` launches the agent untouched —
   * its tool operations then bypass the wayang permission gate. Inert for
   * codebuddy.
   */
  gatePermissions?: boolean;
}

/** Third-party worker configuration. */
export interface WorkerConfig {
  /**
   * Implementation type identifier — one of `WORKER_TYPES` (05 §1). Unknown
   * values are rejected at config load by `validateConfig`, not at dispatch.
   */
  type: WorkerType;
  /** Whether this worker is enabled. Defaults to true. */
  enable?: boolean;
  /** Display emoji for quick visual identification. */
  emoji?: string;
  /** Natural language description for Controller LLM. */
  description: string;
  /** Capability tags for task routing. */
  capabilities?: string[];
  /** Max agent execution turns. Ignored for `*-acp` (ACP has no turn cap). */
  maxTurns?: number;
  /** Path to the worker CLI executable (claude-code only). Defaults to auto-detect. */
  cliPath?: string;
  // --- `*-acp` rows (05 §2). Rejected for `claude-code` (validateConfig rule 4). ---

  /** Override the provider's ACP executable; must be resolvable from PATH. */
  command?: string;
  /** Override the provider's default args (`['--acp']` / `['acp']`). */
  args?: string[];
  /** Extra env merged over `process.env` for the child process (worker layer merges). */
  env?: Record<string, string>;
  /** Timeout / capability overrides; provider defaults apply when omitted. */
  protocol?: AcpProtocolConfig;
  /**
   * `'client'` (default): wayang bridges `request_permission` through the
   * shared permission bridge; `'agent'`: the agent owns its permissions — a
   * request that still arrives is answered cancelled and audited, never
   * silently allowed (04 booklet §6).
   */
  permissionMode?: 'client' | 'agent';
  /**
   * ACP only (type 'acp'; the dedicated codebuddy/opencode rows keep their
   * own measured policy): whether session/updates arriving AFTER a cancel
   * are still trusted and written to the transcript. Defaults to false —
   * the conservative choice, post-cancel updates are dropped and counted.
   * Inert for `claude-code`.
   */
  trustUpdatesAfterCancel?: boolean;
  /**
   * ACP only: per-run Wayang MCP injection (`update_progress` / `ask_controller`).
   * Enabled by default; `fallbackMs` overrides the 120s idle fallback window.
   * Inert for `claude-code` (which uses its own in-process SDK MCP server).
   */
  mcp?: {
    enabled?: boolean;
    fallbackMs?: number;
  };
}

/**
 * Upper bound accepted for `workerRunTimeoutMs` (and add_task's
 * `runTimeoutMs`): 6 hours. A guard value, not a working default — it exists
 * so a mistyped value cannot silently pin a worker forever.
 */
export const MAX_RUN_TIMEOUT_MS = 21_600_000;

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
 * How long an approval is remembered for (issue #46).
 * - 'task' (default): approving a READ of a path once lets the same path be
 *   read again inside the SAME task without asking again. The grant dies with
 *   the task (completed / failed / cancelled), is never shared across tasks or
 *   sessions, and is not persisted — a `--resume`d session starts empty.
 *   Reads only, by canonical path: writes always ask again, and a sensitive
 *   hit (`~/.ssh`, …) always asks again, whatever this setting says.
 * - 'off': no memory at all — every ask is asked (the pre-#46 behaviour).
 */
export type ApprovalMemoryMode = 'task' | 'off';

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
  /**
   * Whether an approval is remembered within the task it was given in.
   * Defaults to 'task' (read grants per task, cleared when the task ends);
   * 'off' restores plain one-approval-per-call. See `ApprovalMemoryMode`.
   */
  approvalMemory?: ApprovalMemoryMode;
}

/**
 * Session log rotation policy (issue #52). All fields optional — omitted
 * keeps the defaults. The log file (`<sessionDir>/wayang.log`) rotates by
 * size; rotated files are kept as `wayang.log.1` … `wayang.log.N`, oldest
 * dropped. Total disk used by logs is bounded at roughly
 * `maxFileSizeBytes × (maxFiles + 1)`.
 */
export interface LoggingConfig {
  /** Max bytes the active log file may reach before rotation. Defaults to 10MB. */
  maxFileSizeBytes?: number;
  /** Number of rotated log files to retain. Defaults to 3. */
  maxFiles?: number;
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
   * Wall-time limit (ms) for ONE worker run (#76): when it expires the run is
   * terminated and reported. Positive integer, at most 6 hours
   * (`MAX_RUN_TIMEOUT_MS`). Per-task `add_task` `runTimeoutMs` overrides it;
   * default 3600000 (60 min). A warning progress is sent once 5 minutes
   * before expiry.
   */
  workerRunTimeoutMs?: number;
  /**
   * Number of processed (read/discarded) signals retained in the hot window.
   * Unread signals are always kept. Defaults to 2000.
   */
  signalWindowSize?: number;
  /** Path permission policy. Optional — the defaults apply when omitted. */
  permission?: PermissionConfig;
  /** Session log rotation policy. Optional — the defaults apply when omitted. */
  logging?: LoggingConfig;
}

/** Whether `type` is one of the ACP worker rows (generic + the two providers). */
function isAcpWorkerType(type: WorkerType): type is 'acp' | 'codebuddy' | 'opencode' {
  return type === 'acp' || type === 'codebuddy' || type === 'opencode';
}

/** Timeout fields of `AcpProtocolConfig` (05 §3); `promptMs` alone allows 0. */
const ACP_TIMEOUT_KEYS = ['handshakeMs', 'sessionNewMs', 'promptMs', 'permissionMs', 'cancelGraceMs', 'sigtermWaitMs'] as const;

/** Allowed keys of `protocol.capabilities` (05 §3). */
const ACP_CAPABILITY_KEYS = ['permissionRequests', 'toolCalls'] as const;

/**
 * Validate one `workers.<id>` row (05 §5). Returns the error message or null.
 *
 * Values arrive from `JSON.parse`, so every field is checked defensively —
 * the `WorkerConfig` typing is what the config CLAIMS, not what it is.
 * `enable: false` rows are validated too: a config error must not hide
 * behind a disabled row (rule 7).
 */
function validateWorkerEntry(id: string, worker: WorkerConfig): string | null {
  const at = `workers.${id}`;
  if (typeof worker !== 'object' || worker === null) {
    return `${at} must be an object`;
  }

  // Rule 1 + 2: type is required, 'puppet' gets its own message, unknown
  // values list every allowed one.
  const type = worker.type as string;
  if (typeof type !== 'string' || type.length === 0) {
    return `${at}.type is required (allowed: ${WORKER_TYPES.join(', ')})`;
  }
  if (type === 'puppet') {
    return `${at}.type: puppet is a built-in worker type, do not declare it under workers`;
  }
  if (!(WORKER_TYPES as readonly string[]).includes(type)) {
    return `${at}.type "${type}" is not supported (allowed: ${WORKER_TYPES.join(', ')})`;
  }

  // Rule 3: common field shapes.
  if (typeof worker.description !== 'string' || worker.description.length === 0) {
    return `${at}.description must be a non-empty string`;
  }
  if (worker.capabilities !== undefined && (!Array.isArray(worker.capabilities) || worker.capabilities.some((c) => typeof c !== 'string'))) {
    return `${at}.capabilities must be an array of strings (got ${JSON.stringify(worker.capabilities)})`;
  }
  if (worker.emoji !== undefined && typeof worker.emoji !== 'string') {
    return `${at}.emoji must be a string (got ${JSON.stringify(worker.emoji)})`;
  }

  // Rule 4: claude-code must not mix in the ACP launch semantics.
  if (type === 'claude-code') {
    for (const key of ['command', 'args', 'env', 'protocol', 'trustUpdatesAfterCancel', 'mcp'] as const) {
      if (worker[key] !== undefined) {
        return `${at}.${key} is not supported for type "claude-code" (claude-code uses cliPath)`;
      }
    }
  }

  // Rule 5: ACP row shapes.
  if (isAcpWorkerType(worker.type)) {
    // The generic 'acp' type has no built-in executable — command is required.
    if (worker.type === 'acp' && (worker.command === undefined || worker.command === '')) {
      return `${at}.command is required for type "acp" (set workers.${id}.command to the ACP agent executable)`;
    }
    if (worker.command !== undefined && (typeof worker.command !== 'string' || worker.command.length === 0)) {
      return `${at}.command must be a non-empty string (got ${JSON.stringify(worker.command)})`;
    }
    if (worker.trustUpdatesAfterCancel !== undefined && typeof worker.trustUpdatesAfterCancel !== 'boolean') {
      return `${at}.trustUpdatesAfterCancel must be a boolean (got ${JSON.stringify(worker.trustUpdatesAfterCancel)})`;
    }
    const mcp = worker.mcp;
    if (mcp !== undefined) {
      if (typeof mcp !== 'object' || mcp === null || Array.isArray(mcp)) {
        return `${at}.mcp must be an object (got ${JSON.stringify(mcp)})`;
      }
      const record = mcp as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (key !== 'enabled' && key !== 'fallbackMs') return `${at}.mcp.${key} is not a known option (allowed: enabled, fallbackMs)`;
      }
      if (record.enabled !== undefined && typeof record.enabled !== 'boolean') {
        return `${at}.mcp.enabled must be a boolean (got ${JSON.stringify(record.enabled)})`;
      }
      if (record.fallbackMs !== undefined && !(typeof record.fallbackMs === 'number' && Number.isFinite(record.fallbackMs) && record.fallbackMs > 0)) {
        return `${at}.mcp.fallbackMs must be a positive number (got ${JSON.stringify(record.fallbackMs)})`;
      }
    }
    if (worker.args !== undefined && (!Array.isArray(worker.args) || worker.args.some((a) => typeof a !== 'string'))) {
      return `${at}.args must be an array of strings (got ${JSON.stringify(worker.args)})`;
    }
    const env = worker.env;
    if (env !== undefined && (typeof env !== 'object' || env === null || Array.isArray(env) || Object.values(env).some((v) => typeof v !== 'string'))) {
      return `${at}.env must be a record of string to string (got ${JSON.stringify(env)})`;
    }
    const protocol = worker.protocol;
    if (protocol !== undefined) {
      if (typeof protocol !== 'object' || protocol === null || Array.isArray(protocol)) {
        return `${at}.protocol must be an object (got ${JSON.stringify(protocol)})`;
      }
      const record = protocol as Record<string, unknown>;
      for (const key of ACP_TIMEOUT_KEYS) {
        const value = record[key];
        if (value === undefined) continue;
        const ok = typeof value === 'number' && Number.isFinite(value) && (key === 'promptMs' ? value >= 0 : value > 0);
        if (!ok) {
          return `${at}.protocol.${key} must be a ${key === 'promptMs' ? 'non-negative' : 'positive'} number (got ${JSON.stringify(value)})`;
        }
      }
      const caps = record.capabilities;
      if (caps !== undefined) {
        if (typeof caps !== 'object' || caps === null || Array.isArray(caps)) {
          return `${at}.protocol.capabilities must be an object (got ${JSON.stringify(caps)})`;
        }
        for (const [key, value] of Object.entries(caps as Record<string, unknown>)) {
          if (!(ACP_CAPABILITY_KEYS as readonly string[]).includes(key)) {
            return `${at}.protocol.capabilities.${key} is not a known capability (allowed: ${ACP_CAPABILITY_KEYS.join(', ')})`;
          }
          if (typeof value !== 'boolean') {
            return `${at}.protocol.capabilities.${key} must be a boolean (got ${JSON.stringify(value)})`;
          }
        }
      }
      const gatePermissions = record.gatePermissions;
      if (gatePermissions !== undefined && typeof gatePermissions !== 'boolean') {
        return `${at}.protocol.gatePermissions must be a boolean (got ${JSON.stringify(gatePermissions)})`;
      }
    }
  }

  // Rule 6: permissionMode value (checked for every type).
  const permissionMode = worker.permissionMode;
  if (permissionMode !== undefined && permissionMode !== 'client' && permissionMode !== 'agent') {
    return `${at}.permissionMode must be 'client' or 'agent' (got ${JSON.stringify(permissionMode)})`;
  }

  return null;
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
  const workers = config.workers;
  if (workers !== undefined && workers !== null) {
    for (const [id, worker] of Object.entries(workers)) {
      const err = validateWorkerEntry(id, worker);
      if (err) return err;
    }
  }
  const runTimeout = config.workerRunTimeoutMs;
  if (runTimeout !== undefined
    && !(Number.isInteger(runTimeout) && runTimeout > 0 && runTimeout <= MAX_RUN_TIMEOUT_MS)) {
    return `workerRunTimeoutMs must be a positive integer of milliseconds, at most ${MAX_RUN_TIMEOUT_MS} (6 hours) (got ${JSON.stringify(runTimeout)})`;
  }
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
    const approvalMemory = permission.approvalMemory;
    if (approvalMemory !== undefined && approvalMemory !== 'task' && approvalMemory !== 'off') {
      return `permission.approvalMemory must be 'task' or 'off' (got ${JSON.stringify(approvalMemory)})`;
    }
  }
  const logging = config.logging;
  if (logging !== undefined && logging !== null) {
    const size = logging.maxFileSizeBytes;
    if (size !== undefined && !(Number.isInteger(size) && size > 0)) {
      return `logging.maxFileSizeBytes must be a positive integer (got ${JSON.stringify(size)})`;
    }
    const files = logging.maxFiles;
    if (files !== undefined && !(Number.isInteger(files) && files > 0)) {
      return `logging.maxFiles must be a positive integer (got ${JSON.stringify(files)})`;
    }
  }
  return null;
}

/**
 * Collect non-fatal `workers` warnings (05 §4): `maxTurns` and `cliPath` have
 * no effect on `*-acp` rows (ACP has no turn cap — the agent's own config
 * decides; the executable is chosen via `command`). Existing configs must
 * keep loading, so these warn instead of failing validation. The caller
 * prints them once at config load.
 */
export function collectWorkerWarnings(config: WayangConfig): string[] {
  const warnings: string[] = [];
  for (const [id, worker] of Object.entries(config.workers ?? {})) {
    if (typeof worker !== 'object' || worker === null) continue;
    if (!isAcpWorkerType(worker.type)) continue;
    if (worker.maxTurns !== undefined) {
      warnings.push(`workers.${id}.maxTurns has no effect on type "${worker.type}" (ACP has no turn cap)`);
    }
    if (worker.cliPath !== undefined) {
      warnings.push(`workers.${id}.cliPath has no effect on type "${worker.type}" (ACP workers use "command")`);
    }
  }
  return warnings;
}
