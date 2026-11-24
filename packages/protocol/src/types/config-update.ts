// --- Config hot-update methods (monorepo-design 4.1 运行时热更) ---
//
// Grain-sized update methods — one method per config slice, the method's
// schema IS its field whitelist. All methods mutate DECLARED values only:
// effect happens lazily at the consumption points (worker at next spawn,
// controller each turn); in-flight turns/spawns keep their old resolved
// snapshot. Updates never cascade and never rewrite downstream entries.
//
// Zero Node built-ins in this file (protocol discipline): the parsers are
// pure functions hosts (desktop included) can use to pre-validate a request
// before sending it over RPC.

import { RpcError, RPC_ERROR } from '../rpc/protocol';
import type { ModelRef, ToolChoice, WayangConfig } from './config';

// --- Request payloads (field whitelists, design 4.1 table) ---

/** `updateProvider(name, patch)` — `{baseURL?, apiKey?, type?}`. */
export interface ProviderPatch {
  baseURL?: string;
  apiKey?: string;
  type?: 'openai-compatible';
}

/** `updateModel(name, patch)` — `{provider?, contextWindowTokens?, temperature?, maxOutputTokens?}`. */
export interface ModelPatch {
  provider?: string;
  contextWindowTokens?: number;
  temperature?: number;
  maxOutputTokens?: number;
}

/** `addProvider(name, def)` — `{type, baseURL, apiKey}`. */
export interface ProviderDefinition {
  type: 'openai-compatible';
  baseURL: string;
  apiKey: string;
}

/**
 * `addModel(name, def)`. The design table's whitelist is
 * `{provider, contextWindowTokens, temperature?, maxOutputTokens?}`; `name`
 * (the model name sent to the provider) is additionally REQUIRED because
 * `validateConfig` rejects a nameless `models.<key>` row — a definition
 * without it could never pass the shared protocol validator.
 */
export interface ModelDefinition {
  provider: string;
  /** Model name sent to the provider (the OpenAI `model` field). */
  name: string;
  contextWindowTokens: number;
  temperature?: number;
  maxOutputTokens?: number;
}

/** `updateWorkerSettings(patch)` — `{model?, maxConcurrency?, toolChoice?}`. */
export interface WorkerSettingsPatch {
  model?: ModelRef;
  maxConcurrency?: number;
  toolChoice?: ToolChoice;
}

/** The typed request for one of the eight hot-update methods. */
export type ConfigUpdateRequest =
  | { method: 'update_provider'; name: string; patch: ProviderPatch }
  | { method: 'update_model'; name: string; patch: ModelPatch }
  | { method: 'add_provider'; name: string; def: ProviderDefinition }
  | { method: 'add_model'; name: string; def: ModelDefinition }
  | { method: 'remove_provider'; name: string }
  | { method: 'remove_model'; name: string }
  | { method: 'update_controller_model'; model: ModelRef }
  | { method: 'update_worker_settings'; patch: WorkerSettingsPatch };

// --- Responses ---

/** One binding affected by a declaration change (reference-graph derived). */
export interface ConfigUpdateAffected {
  /**
   * Binding that consumes the changed provider/model:
   * - `controller` — the `controller.model` (or legacy `controller.provider`) binding; effective next TURN;
   * - `worker` — the default puppet worker binding (`worker.model` / legacy `worker.provider`); effective next SPAWN;
   * - `workerRow` — a third-party `workers.<id>.model` row; effective next SPAWN.
   */
  kind: 'controller' | 'worker' | 'workerRow';
  /** Worker id — set only for kind `workerRow`. */
  workerId?: string;
  /** The model-reference spelling the binding uses ('' when it has none). */
  via: string;
  /** When the new declared value takes effect at this binding. */
  effective: 'next-turn' | 'next-spawn';
}

/** Success payload of every update/add/remove method: the impact list. */
export interface ConfigUpdateResult {
  affected: ConfigUpdateAffected[];
}

/**
 * One reference that blocks a removal — a `models.<key>` entry pointing at
 * the provider, or a binding (`controller.model` / `worker.model` /
 * `workers.<id>.model`) resolving through it / naming the model.
 */
export interface ConfigUpdateBlocker {
  /** Reference site, e.g. `models.fast`, `controller.model`, `workers.codex.model`. */
  site: string;
  /** `models` — a named model entry; `binding` — a model reference site. */
  kind: 'models' | 'binding';
}

/**
 * Structured rejection data (RpcError payload) — why an update was refused.
 * - `not-found`: update/remove targeted an entry that does not exist;
 * - `duplicate`: add would overwrite an existing name (strict, no force);
 * - `referenced`: removal blocked by the listed references (no cascade, no force);
 * - `invalid`: the changed config failed the shared protocol validator.
 */
export interface ConfigUpdateRejection {
  reason: 'not-found' | 'duplicate' | 'referenced' | 'invalid';
  /** References blocking a removal — empty for the other reasons. */
  blockers: ConfigUpdateBlocker[];
  /** Human-readable detail (the validator message, or the duplicate name). */
  detail: string;
}

// --- Request parser ---
//
// The RPC layer delivers `params: Record<string, unknown>`; these parsers
// enforce the per-method field whitelist and primitive shapes, throwing
// RpcError(INVALID_PARAMS) on anything else. The server's handlers use the
// SAME parsers, so a request that parses here is exactly what core accepts.

const UPDATE_METHODS = [
  'update_provider',
  'update_model',
  'add_provider',
  'add_model',
  'remove_provider',
  'remove_model',
  'update_controller_model',
  'update_worker_settings',
] as const satisfies readonly string[];

/** The method names of the eight hot-update RPCs (values of the METHOD map). */
export type ConfigUpdateMethod = (typeof UPDATE_METHODS)[number];

/** Whether `method` is one of the eight config-update methods. */
export function isConfigUpdateMethod(method: string): method is ConfigUpdateMethod {
  return (UPDATE_METHODS as readonly string[]).includes(method);
}

function invalid(message: string): never {
  throw new RpcError(RPC_ERROR.INVALID_PARAMS, message);
}

function requireString(params: Record<string, unknown>, method: string, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value.length === 0) {
    invalid(`${method}: "${key}" must be a non-empty string`);
  }
  return value;
}

function requireObject(params: Record<string, unknown>, method: string, key: string): Record<string, unknown> {
  const value = params[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(`${method}: "${key}" must be an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Enforce the field whitelist of one patch/def object: every key must be
 * known, every present value must satisfy its check. Returns the allowed
 * subset untouched (no deep copy — the caller decides what to do with it).
 */
function pickWhitelist(
  method: string,
  at: string,
  raw: Record<string, unknown>,
  allowed: Readonly<Record<string, (value: unknown) => boolean>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const check = allowed[key];
    if (check === undefined) {
      invalid(`${method}: "${at}.${key}" is not in the field whitelist (allowed: ${Object.keys(allowed).join(', ')})`);
    }
    if (value === undefined) continue;
    if (!check(value)) {
      invalid(`${method}: "${at}.${key}" has an invalid value (got ${JSON.stringify(value)})`);
    }
    out[key] = value;
  }
  return out;
}

const isString = (value: unknown): boolean => typeof value === 'string' && value.length > 0;
const isCompatType = (value: unknown): boolean => value === 'openai-compatible';
const isFiniteNumber = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value);
const isPositiveInteger = (value: unknown): boolean => typeof value === 'number' && Number.isInteger(value) && value > 0;
const isToolChoice = (value: unknown): boolean => value === 'auto' || value === 'required' || value === 'none';
const isModelRef = (value: unknown): boolean =>
  (typeof value === 'string' && value.length > 0) ||
  (typeof value === 'object' && value !== null && !Array.isArray(value));

/**
 * Parse one hot-update request. Throws RpcError(INVALID_PARAMS) on a bad
 * method, a missing field, a non-whitelisted field, or a wrong value shape.
 * Deep semantics (existence, duplicates, references) are the server's job —
 * this layer only guarantees the wire shape.
 */
export function parseConfigUpdateRequest(method: string, params: Record<string, unknown>): ConfigUpdateRequest {
  switch (method) {
    case 'update_provider': {
      const patch = pickWhitelist(method, 'patch', requireObject(params, method, 'patch'), {
        baseURL: isString,
        apiKey: isString,
        type: isCompatType,
      });
      if (Object.keys(patch).length === 0) invalid(`${method}: patch must set at least one field`);
      return { method, name: requireString(params, method, 'name'), patch };
    }
    case 'update_model': {
      const patch = pickWhitelist(method, 'patch', requireObject(params, method, 'patch'), {
        provider: isString,
        contextWindowTokens: isFiniteNumber,
        temperature: isFiniteNumber,
        maxOutputTokens: isFiniteNumber,
      });
      if (Object.keys(patch).length === 0) invalid(`${method}: patch must set at least one field`);
      return { method, name: requireString(params, method, 'name'), patch };
    }
    case 'add_provider': {
      const def = pickWhitelist(method, 'def', requireObject(params, method, 'def'), {
        type: isCompatType,
        baseURL: isString,
        apiKey: isString,
      });
      for (const key of ['type', 'baseURL', 'apiKey'] as const) {
        if (def[key] === undefined) invalid(`${method}: def.${key} is required`);
      }
      return { method, name: requireString(params, method, 'name'), def: def as unknown as ProviderDefinition };
    }
    case 'add_model': {
      const def = pickWhitelist(method, 'def', requireObject(params, method, 'def'), {
        provider: isString,
        name: isString,
        contextWindowTokens: isPositiveInteger,
        temperature: isFiniteNumber,
        maxOutputTokens: isFiniteNumber,
      });
      for (const key of ['provider', 'name', 'contextWindowTokens'] as const) {
        if (def[key] === undefined) invalid(`${method}: def.${key} is required`);
      }
      return { method, name: requireString(params, method, 'name'), def: def as unknown as ModelDefinition };
    }
    case 'remove_provider':
    case 'remove_model':
      return { method, name: requireString(params, method, 'name') };
    case 'update_controller_model': {
      const model = params.model;
      if (!isModelRef(model)) invalid(`${method}: "model" must be a model reference (string or inline object)`);
      return { method, model: model as ModelRef };
    }
    case 'update_worker_settings': {
      const raw = requireObject(params, method, 'patch');
      const patch = pickWhitelist(method, 'patch', raw, {
        model: isModelRef,
        maxConcurrency: isPositiveInteger,
        toolChoice: isToolChoice,
      });
      if (Object.keys(patch).length === 0) invalid(`${method}: patch must set at least one field`);
      return { method, patch: patch as unknown as WorkerSettingsPatch };
    }
    default:
      invalid(`not a config-update method: ${method}`);
  }
}

// --- Reference-graph helpers (pure, shared by hosts for preview) ---

/** One model-binding site of a config (the reference-graph's outer layer). */
export interface BindingSite {
  /** Reference site path, e.g. `controller.model`, `workers.codex.model`. */
  site: string;
  /** Which binding: the two global ones, or a third-party worker row. */
  kind: 'controller' | 'worker' | 'workerRow';
  /** Worker id — set only for kind `workerRow`. */
  workerId?: string;
  /** The model reference the binding declares, if any. */
  ref: ModelRef | undefined;
  /** Deprecated legacy provider key still honoured when `ref` is absent. */
  legacyProvider?: string;
}

/** The binding sites that may reference a model — order matters for output. */
export function bindingSites(config: WayangConfig): BindingSite[] {
  const sites: BindingSite[] = [
    { site: 'controller.model', kind: 'controller', ref: config.controller.model, legacyProvider: config.controller.provider },
    { site: 'worker.model', kind: 'worker', ref: config.worker.model, legacyProvider: config.worker.provider },
  ];
  for (const [id, worker] of Object.entries(config.workers ?? {})) {
    if (typeof worker !== 'object' || worker === null) continue;
    sites.push({ site: `workers.${id}.model`, kind: 'workerRow', workerId: id, ref: worker.model });
  }
  return sites;
}

/**
 * Which provider key a model reference resolves THROUGH (not the entry's
 * final provider — a `models.<key>` ref resolves through the key's entry,
 * whose `provider` field names the provider). Returns null when the ref
 * names no provider at all.
 */
export function modelRefProvider(config: WayangConfig, ref: ModelRef | undefined, legacyProviderKey?: string): string | null {
  if (ref !== undefined) {
    if (typeof ref === 'string') {
      const named = config.models?.[ref];
      if (named) return named.provider;
      const slash = ref.indexOf('/');
      return slash > 0 ? ref.slice(0, slash) : null;
    }
    return typeof ref.provider === 'string' && ref.provider.length > 0 ? ref.provider : null;
  }
  return legacyProviderKey ?? null;
}

/** Which `models` key a string model reference names, or null (composite / inline / none). */
export function modelRefKey(ref: ModelRef | undefined): string | null {
  if (typeof ref !== 'string') return null;
  if (ref.includes('/')) return null;
  return ref;
}
