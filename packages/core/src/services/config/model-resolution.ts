import type { ModelConfig, ModelRef, ProviderConfig, WayangConfig } from '@wayang-ai/protocol/types/config';

/**
 * Where a resolved model came from (issue #88):
 * - `models`: a named entry under top-level `models`, referenced by key.
 * - `composite`: a `"provider/name"` reference.
 * - `inline`: an inline model object (an anonymous `models` entry).
 *
 * There is no legacy-provider or environment source any more: hosts translate
 * the pre-#88 spellings at their config entry (protocol `normalizeConfig`)
 * and materialize the `WAYANG_*` env fallback themselves, so every model a
 * config yields is declared through one of the three forms above.
 */
export type ResolvedModelSource = 'models' | 'composite' | 'inline';

/** A fully resolved model, ready for `createModel`. */
export interface ResolvedModel {
  /** Key of `providers` the model runs on. */
  providerKey: string;
  /** Model name sent to the provider. */
  modelName: string;
  /** OpenAI-compatible base URL (`providers.<key>.baseURL`). */
  baseURL: string;
  apiKey: string;
  /** Undefined when undeclared — ContextManager applies the 256k default. */
  contextWindowTokens?: number;
  /**
   * Request parameters. Filled only by the `models` / `inline` sources when
   * the entry declares them; a `composite` reference has no declaration
   * surface, so it never carries any.
   */
  maxOutputTokens?: number;
  temperature?: number;
  source: ResolvedModelSource;
}

/** Thrown when a model reference cannot be resolved from the config. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function availableProviders(config: WayangConfig): string {
  const keys = Object.keys(config.providers ?? {});
  return keys.length > 0 ? keys.join(', ') : 'none';
}

function availableModels(config: WayangConfig): string {
  const keys = Object.keys(config.models ?? {});
  return keys.length > 0 ? keys.join(', ') : 'none';
}

function requireProvider(config: WayangConfig, providerKey: string): ProviderConfig {
  const provider = config.providers?.[providerKey];
  if (!provider) {
    throw new ConfigError(`provider "${providerKey}" not found (available: ${availableProviders(config)})`);
  }
  return provider;
}

function requireBaseURL(providerKey: string, provider: ProviderConfig): string {
  if (!provider.baseURL) {
    throw new ConfigError(`providers.${providerKey}.baseURL is required`);
  }
  return provider.baseURL;
}

function requireApiKey(providerKey: string, provider: ProviderConfig): string {
  if (!provider.apiKey) {
    throw new ConfigError(`providers.${providerKey}.apiKey is required (set WAYANG_LLM_API_KEY or configure in config file)`);
  }
  return provider.apiKey;
}

/** Resolve an explicit model entry (named or inline) against its provider. */
function fromModelConfig(config: WayangConfig, model: ModelConfig, source: ResolvedModelSource): ResolvedModel {
  if (typeof model !== 'object' || model === null || Array.isArray(model)) {
    throw new ConfigError('model must be an object with provider and name');
  }
  if (typeof model.provider !== 'string' || model.provider.length === 0) {
    throw new ConfigError('model.provider is required');
  }
  const provider = requireProvider(config, model.provider);
  if (typeof model.name !== 'string' || model.name.length === 0) {
    throw new ConfigError(`model for provider "${model.provider}" must declare a non-empty name`);
  }
  return {
    providerKey: model.provider,
    modelName: model.name,
    baseURL: requireBaseURL(model.provider, provider),
    apiKey: requireApiKey(model.provider, provider),
    // The entry's own settings, nothing inherited: an undeclared window stays
    // undefined (ContextManager owns the 256k default) and undeclared request
    // parameters are never sent.
    contextWindowTokens: model.contextWindowTokens,
    maxOutputTokens: model.maxOutputTokens,
    temperature: model.temperature,
    source,
  };
}

/**
 * Resolve the model a controller / worker / `workers.<id>` row should use
 * (issue #88): the `ref` is a `models` key, a `"provider/name"` composite, or
 * an inline model object (an anonymous `models` entry, never registered).
 *
 * A missing or unresolvable `ref` is a `ConfigError` — core has no fallback.
 * Legacy spellings and the `WAYANG_*` env fallback belong to the host's
 * config entry (protocol `normalizeConfig`), and core's intake refuses any
 * config that still carries a legacy key.
 */
export function resolveModelRef(config: WayangConfig, ref: ModelRef | undefined): ResolvedModel {
  if (ref === undefined) {
    throw new ConfigError('model reference is not configured (bind controller.model / worker.model / workers.<id>.model)');
  }
  if (typeof ref === 'string') {
    const named = config.models?.[ref];
    if (named) return fromModelConfig(config, named, 'models');

    // Composite: split on the FIRST '/' so model names may contain '/'.
    const slash = ref.indexOf('/');
    if (slash >= 0) {
      const providerKey = ref.slice(0, slash);
      const modelName = ref.slice(slash + 1);
      if (!providerKey || !modelName) {
        throw new ConfigError(`Invalid model reference "${ref}" (expected "provider/model")`);
      }
      const provider = requireProvider(config, providerKey);
      // A composite reference has no per-model declaration surface: neither a
      // window budget nor request parameters come with it.
      return {
        providerKey,
        modelName,
        baseURL: requireBaseURL(providerKey, provider),
        apiKey: requireApiKey(providerKey, provider),
        source: 'composite',
      };
    }

    throw new ConfigError(`Unknown model "${ref}" (available models: ${availableModels(config)}; or use "provider/model")`);
  }

  if (typeof ref !== 'object' || ref === null || Array.isArray(ref)) {
    throw new ConfigError('model reference must be a model name, "provider/model", or an inline model object');
  }
  return fromModelConfig(config, ref, 'inline');
}
