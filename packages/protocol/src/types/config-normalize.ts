// --- Config normalization (legacy spellings → canonical shape) ---
//
// Hosts (the CLI's `loadConfig`, the desktop's CLI-config import) call
// normalizeConfig ONCE at their config entry, before validateConfig.
// Everything downstream — core, the desktop UI — then only ever sees the
// canonical shape introduced by issue #88: top-level `models` entries
// referenced through `controller.model` / `worker.model` / `workers.<id>.model`.
// The deprecated spellings are not part of the `WayangConfig` TYPE any more —
// this module reads them through untyped record views, which is why it is the
// only place that can.
//
// findLegacyConfigKeys inventories what is still deprecated;
// validateCanonicalConfig is the intake check built on it (core refuses any
// config that still carries a legacy key).
//
// The translation is behaviour-preserving — it mirrors the pre-#88 resolution
// rule by rule, so a legacy config resolves to the same model (name, base URL,
// window budget, request parameters) as before the split:
// - `endpoint` → `baseURL` (baseURL already wins when both are present);
// - a provider's implicit model (`modelName` + the window budget) → a
//   top-level `models` entry, keyed by the provider key (the CLI onboard's
//   provider/model same-key convention) — so the legacy binding value
//   `controller.provider = P` becomes `controller.model = "P"` verbatim;
//   `temperature` / `maxOutputTokens` are dropped: the legacy resolution
//   never sent them;
// - the provider `contextWindowTokens` is the default budget of every model
//   referencing the provider: it is moved onto the `models` entries and the
//   inline references, and a `"provider/name"` composite is materialized as
//   an entry carrying it;
// - `controller.provider` / `worker.provider` → the `model` reference of the
//   provider's implicit model (a `model` reference already present wins, as
//   it did in the former resolution); the legacy key is always removed;
// - deprecated `workers.<id>.type` spellings → canonical names
//   (normalizeWorkerTypes — the protocol's own rewriter);
// - `permission.deniedDirs` → merged into `sensitiveDirs` (current key first,
//   deduped, declared order kept).
//
// Zero Node built-ins in this file (protocol discipline): pure functions.
// Validation is NOT done here — the shape is translated, validateConfig
// still decides whether the result is a usable config.

import {
  DEPRECATED_WORKER_TYPES,
  normalizeWorkerTypes,
  validateConfig,
  type ModelConfig,
  type ModelRef,
  type ProviderConfig,
  type WayangConfig,
} from './config';

/** Provider keys that only exist in the legacy (pre-#88) spelling. */
const LEGACY_PROVIDER_KEYS = ['endpoint', 'modelName', 'contextWindowTokens', 'temperature', 'maxOutputTokens'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The key of an entry that already IS this model — same provider, same name, same window budget. */
function findEquivalentModelKey(
  models: Record<string, ModelConfig>,
  provider: string,
  name: string,
  window: number | undefined,
): string | null {
  for (const [key, model] of Object.entries(models)) {
    if (model?.provider === provider && model?.name === name && model.contextWindowTokens === window) return key;
  }
  return null;
}

/** The first free entry key: a taken candidate falls back to `-2`, `-3`, … */
function freeModelKey(models: Record<string, ModelConfig>, candidate: string): string {
  if (!(candidate in models)) return candidate;
  for (let n = 2; ; n += 1) {
    const key = `${candidate}-${n}`;
    if (!(key in models)) return key;
  }
}

export interface NormalizeConfigResult {
  /** The canonical config — a fresh object; the input is never touched. */
  config: WayangConfig;
  /** One line per translated legacy spelling (hosts surface them once at load). */
  notes: string[];
}

/** Translate every legacy spelling in `input` to the canonical shape. Idempotent on canonical input. */
export function normalizeConfig(input: WayangConfig): NormalizeConfigResult {
  const notes: string[] = [];
  // Work on a private deep copy: the caller's object stays untouched.
  const config: WayangConfig = structuredClone(input);
  const providers = config.providers;
  const models: Record<string, ModelConfig> = { ...(config.models ?? {}) };

  normalizeWorkerTypes(config, (message) => notes.push(message));

  const record = (key: string): Record<string, unknown> | undefined => {
    const provider: unknown = providers[key];
    return isRecord(provider) ? provider : undefined;
  };
  const providerWindow = (key: string): number | undefined => {
    const window = record(key)?.contextWindowTokens;
    return typeof window === 'number' ? window : undefined;
  };
  /** Where a provider's window budget landed (for the notes). */
  const windowReceivers = new Map<string, string[]>();
  const carryWindow = (providerKey: string, target: string): void => {
    windowReceivers.set(providerKey, [...(windowReceivers.get(providerKey) ?? []), target]);
  };

  for (const [key, provider] of Object.entries(providers)) {
    if (!isRecord(provider) || provider.endpoint === undefined) continue;
    // Rebuilt with `baseURL` leading, so the entry reads in the canonical order.
    const rest: Record<string, unknown> = { ...provider };
    delete rest.endpoint;
    delete rest.baseURL;
    providers[key] = { baseURL: provider.baseURL ?? provider.endpoint, ...rest } as ProviderConfig;
    notes.push(`providers.${key}.endpoint is deprecated — translated to baseURL`);
  }

  // The window budget moves onto the entries that inherit it — BEFORE the
  // provider field is stripped (step ④) and before the equivalence lookups
  // below compare windows.
  for (const key of Object.keys(providers)) {
    const window = providerWindow(key);
    if (window === undefined) continue;
    for (const [modelKey, model] of Object.entries(models)) {
      if (model?.provider === key && model.contextWindowTokens === undefined) {
        model.contextWindowTokens = window;
        carryWindow(key, `models.${modelKey}`);
      }
    }
  }

  // provider key → the models key carrying its implicit (`modelName`) model.
  const implicitModelKeys = new Map<string, string>();
  for (const [key, provider] of Object.entries(providers)) {
    if (!isRecord(provider) || typeof provider.modelName !== 'string' || provider.modelName.length === 0) continue;
    const window = providerWindow(key);
    const modelKey = findEquivalentModelKey(models, key, provider.modelName, window) ?? freeModelKey(models, key);
    if (models[modelKey] === undefined) {
      models[modelKey] = { provider: key, name: provider.modelName, ...(window !== undefined && { contextWindowTokens: window }) };
      carryWindow(key, `models.${modelKey}`);
    }
    implicitModelKeys.set(key, modelKey);
    notes.push(`providers.${key}.modelName is deprecated — translated to models.${modelKey}`);
  }

  /** Rewrite one model reference into a form that no longer leans on a provider's deprecated fields. */
  const canonicalRef = (ref: ModelRef | undefined, site: string): ModelRef | undefined => {
    if (ref === undefined) return undefined;
    if (typeof ref === 'string') {
      const slash = ref.indexOf('/');
      // A models key (or a malformed reference — validateConfig reports it): unchanged.
      if (slash <= 0) return ref;
      const providerKey = ref.slice(0, slash);
      const name = ref.slice(slash + 1);
      const window = providerWindow(providerKey);
      // A composite is already canonical; it is materialized only when it
      // inherits the provider's window budget.
      if (!name || window === undefined) return ref;
      const modelKey = findEquivalentModelKey(models, providerKey, name, window) ?? freeModelKey(models, name);
      if (models[modelKey] === undefined) {
        models[modelKey] = { provider: providerKey, name, contextWindowTokens: window };
        carryWindow(providerKey, `models.${modelKey}`);
      }
      notes.push(`${site} "${ref}" is a composite inheriting the provider's contextWindowTokens — rewritten to models.${modelKey}`);
      return modelKey;
    }
    if (isRecord(ref)) {
      const providerKey = ref.provider;
      const window = typeof providerKey === 'string' ? providerWindow(providerKey) : undefined;
      if (window !== undefined && ref.contextWindowTokens === undefined) {
        carryWindow(providerKey as string, `${site} (inline model)`);
        return { ...(ref as unknown as ModelConfig), contextWindowTokens: window };
      }
    }
    return ref;
  };

  // Bindings: the legacy provider key → the implicit model's reference. A
  // provider without `modelName` relied on the WAYANG_* env fallback (a host
  // concern) — the binding is left empty for the host to resolve. The section
  // is rebuilt with `model` leading and the legacy key gone.
  const rebind = (name: 'controller' | 'worker'): void => {
    const section: unknown = config[name];
    if (!isRecord(section)) return;
    let ref = section.model as ModelRef | undefined;
    const legacyKey = section.provider;
    if (ref === undefined && typeof legacyKey === 'string') {
      const modelKey = implicitModelKeys.get(legacyKey);
      if (modelKey !== undefined) {
        ref = modelKey;
        notes.push(`${name}.provider is deprecated — translated to ${name}.model = "${modelKey}"`);
      } else {
        notes.push(`${name}.provider = "${legacyKey}" is deprecated and names no model — the binding is left empty`);
      }
    }
    const next = canonicalRef(ref, name);
    const rest: Record<string, unknown> = { ...section };
    delete rest.provider;
    delete rest.model;
    const rebound = { ...(next !== undefined && { model: next }), ...rest };
    if (name === 'controller') config.controller = rebound as WayangConfig['controller'];
    else config.worker = rebound as WayangConfig['worker'];
  };
  rebind('controller');
  rebind('worker');
  for (const [id, worker] of Object.entries(config.workers ?? {})) {
    if (!isRecord(worker) || worker.model === undefined) continue;
    worker.model = canonicalRef(worker.model as ModelRef, `workers.${id}.model`);
  }

  // Strip the deprecated provider fields — their meaning now lives on the
  // models entries and the references.
  for (const [key, provider] of Object.entries(providers)) {
    if (!isRecord(provider)) continue;
    if (provider.contextWindowTokens !== undefined) {
      const receivers = windowReceivers.get(key) ?? [];
      notes.push(
        receivers.length > 0
          ? `providers.${key}.contextWindowTokens is deprecated — moved onto ${receivers.join(', ')}`
          : `providers.${key}.contextWindowTokens is deprecated — dropped (no model referenced it)`,
      );
    }
    if (provider.temperature !== undefined || provider.maxOutputTokens !== undefined) {
      notes.push(`providers.${key}.temperature / maxOutputTokens are deprecated — dropped (the legacy resolution never sent them)`);
    }
    for (const field of LEGACY_PROVIDER_KEYS) delete provider[field];
  }

  // permission.deniedDirs → sensitiveDirs. A malformed shape is left alone
  // for validateConfig to report.
  const permission: unknown = config.permission;
  if (isRecord(permission)) {
    const denied = permission.deniedDirs;
    const current = permission.sensitiveDirs;
    if (Array.isArray(denied) && (current === undefined || Array.isArray(current))) {
      const seen = new Set<string>();
      const merged = [...(current ?? []), ...denied].filter((entry): entry is string => {
        if (typeof entry !== 'string' || entry.length === 0 || seen.has(entry)) return false;
        seen.add(entry);
        return true;
      });
      if (merged.length > 0) permission.sensitiveDirs = merged;
      else delete permission.sensitiveDirs;
      delete permission.deniedDirs;
      if (Object.keys(permission).length === 0) delete config.permission;
      notes.push('permission.deniedDirs is deprecated — merged into permission.sensitiveDirs');
    }
  }

  // Removed top-level key (core ignores it): never carried into a canonical config.
  const top = config as unknown as Record<string, unknown>;
  if (top.workerRunTimeoutMs !== undefined) {
    delete top.workerRunTimeoutMs;
    notes.push('workerRunTimeoutMs is deprecated and ignored — dropped');
  }

  if (Object.keys(models).length === 0 && config.models === undefined) return { config, notes };
  // `models` sits right after `providers` — the canonical reading order.
  const rest: Record<string, unknown> = { ...config };
  delete rest.providers;
  delete rest.models;
  return { config: { providers, models, ...rest } as unknown as WayangConfig, notes };
}

/**
 * Every deprecated key still present in `config`, as config paths
 * (`providers.hub.endpoint`, `controller.provider`, `workers.x.type`, …).
 * Empty means the config is canonical — the condition core and the desktop
 * store enforce at their intake.
 */
export function findLegacyConfigKeys(config: WayangConfig): string[] {
  const found: string[] = [];
  for (const [name, provider] of Object.entries(config.providers ?? {})) {
    if (!isRecord(provider)) continue;
    for (const key of LEGACY_PROVIDER_KEYS) {
      if (provider[key] !== undefined) found.push(`providers.${name}.${key}`);
    }
  }
  for (const name of ['controller', 'worker'] as const) {
    const section: unknown = config[name];
    if (isRecord(section) && section.provider !== undefined) found.push(`${name}.provider`);
  }
  const permission: unknown = config.permission;
  if (isRecord(permission) && permission.deniedDirs !== undefined) found.push('permission.deniedDirs');
  for (const [id, worker] of Object.entries(config.workers ?? {})) {
    const type = isRecord(worker) ? worker.type : undefined;
    if (typeof type === 'string' && type in DEPRECATED_WORKER_TYPES) found.push(`workers.${id}.type`);
  }
  return found;
}

/**
 * The intake check for every core entry point. A config is accepted only when
 * it is canonical — no deprecated key may remain (hosts translate them once
 * at their config entry with normalizeConfig; core has no compat branch) —
 * AND it passes the structural validateConfig. Returns the error message, or
 * null when the config is accepted.
 */
export function validateCanonicalConfig(config: WayangConfig): string | null {
  const legacyKeys = findLegacyConfigKeys(config);
  if (legacyKeys.length > 0) {
    return `config carries deprecated keys (${legacyKeys.join(', ')}) — the host must call normalizeConfig at its config entry before handing a config to core`;
  }
  // validateConfig assumes a well-shaped top level; an intake must never leak
  // a TypeError for a malformed payload — report it like any other problem.
  try {
    return validateConfig(config);
  } catch (err) {
    return `malformed config (${err instanceof Error ? err.message : String(err)})`;
  }
}
