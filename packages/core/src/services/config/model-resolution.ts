import type { ModelConfig, ModelRef, ProviderConfig, WayangConfig } from '@wayang-ai/protocol/types/config';

/**
 * Where a resolved model came from (issue #88):
 * - `models`: a named entry under top-level `models`, referenced by key.
 * - `composite`: a `"provider/name"` reference.
 * - `inline`: an inline model object (an anonymous `models` entry).
 * - `legacy-provider`: an implicit model built from a provider's deprecated
 *   `modelName` / window / temperature fields (pre-#88 configs).
 * - `env`: the `WAYANG_*` environment fallback.
 */
export type ResolvedModelSource = 'models' | 'composite' | 'inline' | 'legacy-provider' | 'env';

/** A fully resolved model, ready for `createModel`. */
export interface ResolvedModel {
  /** Key of `providers` the model runs on. */
  providerKey: string;
  /** Model name sent to the provider. */
  modelName: string;
  /** OpenAI-compatible base URL (`baseURL`, or the deprecated `endpoint`). */
  baseURL: string;
  apiKey: string;
  /** Undefined when undeclared — ContextManager applies the 256k default. */
  contextWindowTokens?: number;
  /**
   * Request parameters. Filled only by the `models` / `inline` sources (and
   * env) when the entry declares them: a `legacy-provider` resolution
   * deliberately leaves them undefined so pre-#88 configs keep their
   * recorded-only behaviour, and a `composite` reference has no declaration
   * surface — the provider's deprecated values are never inherited.
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

/** Environment fallback used when neither a model ref nor a legacy provider key exists. */
export interface EnvModelFallback {
  apiKey?: string;
  baseURL?: string;
  modelName?: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  temperature?: number;
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
  const baseURL = provider.baseURL ?? provider.endpoint;
  if (!baseURL) {
    throw new ConfigError(`providers.${providerKey}.baseURL is required (set baseURL or the deprecated endpoint alias)`);
  }
  return baseURL;
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
    // The window budget is a compaction budget, not a request parameter, and
    // was effective before #88 — the provider's value stays the entry's
    // default. The deprecated REQUEST parameters are model-level ONLY: an
    // entry that does not declare temperature/maxOutputTokens resolves them
    // undefined; inheriting the provider's would silently change sampling for
    // mixed configs. Undeclared stays undefined — ContextManager owns the
    // 256k default for the window.
    contextWindowTokens: model.contextWindowTokens ?? provider.contextWindowTokens,
    maxOutputTokens: model.maxOutputTokens,
    temperature: model.temperature,
    source,
  };
}

/**
 * Resolve the model a controller / worker / `workers.<id>` row should use
 * (issue #88).
 *
 * Priority:
 * 1. An explicit `ref` — a `models` key, a `"provider/name"` composite, or an
 *    inline model object (an anonymous `models` entry, never registered).
 * 2. Otherwise the provider named by `legacyProviderKey`, used as an implicit
 *    model (`modelName` + the deprecated window budget; the deprecated
 *    temperature / maxOutputTokens stay recorded only — see the branch).
 * 3. Otherwise the `envFallback`, when it carries apiKey + baseURL + modelName.
 * 4. Otherwise a `ConfigError`.
 */
export function resolveModelRef(
  config: WayangConfig,
  ref: ModelRef | undefined,
  legacyProviderKey?: string,
  envFallback?: EnvModelFallback,
): ResolvedModel {
  if (ref !== undefined) {
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
        return {
          providerKey,
          modelName,
          baseURL: requireBaseURL(providerKey, provider),
          apiKey: requireApiKey(providerKey, provider),
          // A composite reference has no per-model declaration surface, so the
          // provider's deprecated request parameters never apply here — only
          // the window budget (a compaction budget, effective pre-#88) is
          // inherited from the provider.
          contextWindowTokens: provider.contextWindowTokens,
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

  if (legacyProviderKey !== undefined) {
    const provider = requireProvider(config, legacyProviderKey);
    if (provider.modelName) {
      // #88 — a legacy provider binding keeps its pre-#88 behaviour EXACTLY:
      // `modelName` + the window budget resolve, while `temperature` /
      // `maxOutputTokens` stay "recorded only". They were never sent before #88
      // (base-agent reads them off `ResolvedModel` unconditionally), so filling
      // them here would silently change sampling for every existing config.
      // `contextWindowTokens` IS filled: it is a compaction budget, not a request
      // parameter, and it was effective before #88 too. The new `models` /
      // composite / inline forms opt in through `fromModelConfig` / the composite
      // branch above.
      return {
        providerKey: legacyProviderKey,
        modelName: provider.modelName,
        baseURL: requireBaseURL(legacyProviderKey, provider),
        apiKey: requireApiKey(legacyProviderKey, provider),
        contextWindowTokens: provider.contextWindowTokens,
        source: 'legacy-provider',
      };
    }
    // No `modelName` on the legacy provider: fall through to the environment
    // fallback (configuration.md §priority: legacy binding > env > error).
    // Throwing here made that documented env fallback unreachable whenever a
    // provider key was bound.
  }

  if (envFallback) {
    const { apiKey, baseURL, modelName, contextWindowTokens, maxOutputTokens, temperature } = envFallback;
    if (apiKey && baseURL && modelName) {
      return {
        providerKey: 'default',
        modelName,
        baseURL,
        apiKey,
        contextWindowTokens,
        maxOutputTokens,
        temperature,
        source: 'env',
      };
    }
  }

  throw new ConfigError('controller.model 未配置，且 provider 未声明 modelName');
}
