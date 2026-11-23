import { describe, it, expect } from 'vitest';
import type { WayangConfig } from '@/types/config';
import { collectProviderWarnings } from '@/types/config';
import { resolveModelRef, ConfigError } from '@/services/config/model-resolution';

/** Pre-#88 config: providers carry the model, controller/worker point at them. */
function legacyConfig(overrides: Partial<WayangConfig> = {}): WayangConfig {
  return {
    providers: {
      default: {
        endpoint: 'http://localhost:8000/v1',
        apiKey: 'sk-test',
        modelName: 'gpt-4o',
        contextWindowTokens: 128_000,
        temperature: 0.2,
        maxOutputTokens: 4096,
      },
    },
    controller: { provider: 'default' },
    worker: { provider: 'default', maxConcurrency: 2 },
    ...overrides,
  };
}

describe('resolveModelRef: legacy config (pre-#88)', () => {
  it('resolves exactly like the old provider lookup — providerKey/modelName/baseURL/apiKey/window', () => {
    const config = legacyConfig();
    const resolved = resolveModelRef(config, undefined, config.controller.provider);
    expect(resolved).toEqual({
      providerKey: 'default',
      modelName: 'gpt-4o',
      baseURL: 'http://localhost:8000/v1',
      apiKey: 'sk-test',
      contextWindowTokens: 128_000,
      source: 'legacy-provider',
    });
    // #88: a legacy binding stays "recorded only" — the deprecated request
    // parameters must NOT reach `ResolvedModel` (base-agent would send them).
    expect(resolved.temperature).toBeUndefined();
    expect(resolved.maxOutputTokens).toBeUndefined();
  });

  it('prefers baseURL over the deprecated endpoint alias', () => {
    const config = legacyConfig({
      providers: { default: { baseURL: 'http://base', endpoint: 'http://alias', apiKey: 'k', modelName: 'm' } },
    });
    expect(resolveModelRef(config, undefined, 'default').baseURL).toBe('http://base');
  });
});

describe('resolveModelRef: named models (issue #88)', () => {
  it('resolves a short name through top-level models', () => {
    const config: WayangConfig = {
      providers: { openai: { baseURL: 'https://api.openai.com/v1', apiKey: 'sk-x' } },
      models: { 'gpt-4o': { provider: 'openai', name: 'gpt-4o', contextWindowTokens: 128_000 } },
      controller: { model: 'gpt-4o' },
      worker: { maxConcurrency: 1 },
    };
    expect(resolveModelRef(config, config.controller.model, config.controller.provider)).toEqual({
      providerKey: 'openai',
      modelName: 'gpt-4o',
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-x',
      contextWindowTokens: 128_000,
      maxOutputTokens: undefined,
      temperature: undefined,
      source: 'models',
    });
  });

  it('leaves contextWindowTokens undefined when neither model nor provider declares it', () => {
    const config: WayangConfig = {
      providers: { openai: { baseURL: 'https://api.openai.com/v1', apiKey: 'sk-x' } },
      models: { m: { provider: 'openai', name: 'gpt-4o' } },
      controller: { model: 'm' },
      worker: { maxConcurrency: 1 },
    };
    expect(resolveModelRef(config, 'm').contextWindowTokens).toBeUndefined();
  });
});

describe('resolveModelRef: "provider/name" composite', () => {
  const config: WayangConfig = {
    providers: { openai: { baseURL: 'https://api.openai.com/v1', apiKey: 'sk-x' } },
    controller: { model: 'openai/gpt-4o' },
    worker: { maxConcurrency: 1 },
  };

  it('splits on the first slash into providerKey + modelName', () => {
    expect(resolveModelRef(config, 'openai/gpt-4o')).toEqual({
      providerKey: 'openai',
      modelName: 'gpt-4o',
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-x',
      contextWindowTokens: undefined,
      maxOutputTokens: undefined,
      temperature: undefined,
      source: 'composite',
    });
  });

  it('keeps later slashes in the model name', () => {
    expect(resolveModelRef(config, 'openai/org/model').modelName).toBe('org/model');
  });

  it('throws and lists the available provider keys when the provider is unknown', () => {
    let message = '';
    try {
      resolveModelRef(config, 'nope/gpt-4o');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      message = (err as Error).message;
    }
    expect(message).toContain('provider "nope" not found');
    expect(message).toContain('openai');
  });
});

describe('resolveModelRef: inline model object', () => {
  it('resolves like an anonymous models entry and does not register a name', () => {
    const config: WayangConfig = {
      providers: { openai: { baseURL: 'https://api.openai.com/v1', apiKey: 'sk-x', contextWindowTokens: 64_000 } },
      models: { existing: { provider: 'openai', name: 'gpt-4o' } },
      controller: { model: { provider: 'openai', name: 'gpt-4o-mini', temperature: 0.5 } },
      worker: { maxConcurrency: 1 },
    };
    const resolved = resolveModelRef(config, config.controller.model);
    expect(resolved).toMatchObject({
      providerKey: 'openai',
      modelName: 'gpt-4o-mini',
      contextWindowTokens: 64_000,
      temperature: 0.5,
      source: 'inline',
    });
    expect(Object.keys(config.models ?? {})).toEqual(['existing']);
  });

  it('throws ConfigError for an unknown provider or an empty name', () => {
    const config: WayangConfig = {
      providers: { openai: { baseURL: 'https://api.openai.com/v1', apiKey: 'sk-x' } },
      controller: {},
      worker: { maxConcurrency: 1 },
    };
    expect(() => resolveModelRef(config, { provider: 'nope', name: 'm' })).toThrow(ConfigError);
    expect(() => resolveModelRef(config, { provider: 'openai', name: '' })).toThrow(ConfigError);
  });
});

describe('resolveModelRef: new and old declarations together', () => {
  it('lets the model ref win and warns that providers.<x>.modelName was ignored', () => {
    const config = legacyConfig({
      models: { 'gpt-4o-mini': { provider: 'default', name: 'gpt-4o-mini' } },
      controller: { provider: 'default', model: 'gpt-4o-mini' },
    });
    const resolved = resolveModelRef(config, config.controller.model, config.controller.provider);
    expect(resolved.modelName).toBe('gpt-4o-mini');
    expect(resolved.source).toBe('models');

    const warnings = collectProviderWarnings(config);
    expect(warnings.some((w) => w.includes('已忽略 providers.default.modelName'))).toBe(true);
  });
});

describe('resolveModelRef: nothing configured', () => {
  it('throws ConfigError when no ref, no legacy provider and no env fallback exist', () => {
    const config: WayangConfig = {
      providers: { openai: { baseURL: 'https://api.openai.com/v1', apiKey: 'sk-x' } },
      controller: {},
      worker: { maxConcurrency: 1 },
    };
    expect(() => resolveModelRef(config, undefined, config.controller.provider)).toThrow(ConfigError);
    expect(() => resolveModelRef(config, undefined, config.controller.provider)).toThrow(
      'controller.model 未配置，且 provider 未声明 modelName',
    );
  });

  it('throws the same error when the legacy provider declares no modelName', () => {
    const config: WayangConfig = {
      providers: { openai: { baseURL: 'https://api.openai.com/v1', apiKey: 'sk-x' } },
      controller: { provider: 'openai' },
      worker: { maxConcurrency: 1 },
    };
    expect(() => resolveModelRef(config, undefined, 'openai')).toThrow('controller.model 未配置，且 provider 未声明 modelName');
  });
});

describe('resolveModelRef: env fallback', () => {
  it('uses the env model when nothing is configured, with source "env"', () => {
    const config: WayangConfig = {
      providers: {},
      controller: {},
      worker: { maxConcurrency: 1 },
    };
    const resolved = resolveModelRef(config, undefined, undefined, {
      apiKey: 'sk-env',
      baseURL: 'http://env',
      modelName: 'env-model',
      contextWindowTokens: 32_000,
    });
    expect(resolved).toEqual({
      providerKey: 'default',
      modelName: 'env-model',
      baseURL: 'http://env',
      apiKey: 'sk-env',
      contextWindowTokens: 32_000,
      maxOutputTokens: undefined,
      temperature: undefined,
      source: 'env',
    });
  });

  it('falls back to env when the legacy provider declares no modelName (P1-4)', () => {
    const config: WayangConfig = {
      providers: { default: { baseURL: 'http://base', apiKey: 'sk-file' } },
      controller: { provider: 'default' },
      worker: { maxConcurrency: 1 },
    };
    const resolved = resolveModelRef(config, undefined, 'default', {
      apiKey: 'sk-env',
      baseURL: 'http://env',
      modelName: 'env-model',
      contextWindowTokens: 64_000,
    });
    expect(resolved).toEqual({
      providerKey: 'default',
      modelName: 'env-model',
      baseURL: 'http://env',
      apiKey: 'sk-env',
      contextWindowTokens: 64_000,
      maxOutputTokens: undefined,
      temperature: undefined,
      source: 'env',
    });
  });

  it('still throws when the legacy provider has no modelName and env is incomplete', () => {
    const config: WayangConfig = {
      providers: { default: { baseURL: 'http://base', apiKey: 'sk-file' } },
      controller: { provider: 'default' },
      worker: { maxConcurrency: 1 },
    };
    expect(() => resolveModelRef(config, undefined, 'default', { apiKey: 'sk-env' })).toThrow(
      'controller.model 未配置，且 provider 未声明 modelName',
    );
  });
});

describe('resolveModelRef: request parameters (#88 legacy vs new writings)', () => {
  it('the legacy provider binding stays recorded-only while every new writing passes them through', () => {
    const config = legacyConfig({
      models: { 'gpt-4o': { provider: 'default', name: 'gpt-4o' } },
      controller: { provider: 'default', model: 'gpt-4o' },
    });

    // Legacy: the deprecated request parameters are NOT sent.
    const legacy = resolveModelRef(config, undefined, config.controller.provider);
    expect(legacy.contextWindowTokens).toBe(128_000);
    expect(legacy.temperature).toBeUndefined();
    expect(legacy.maxOutputTokens).toBeUndefined();

    // Named `models` entry: provider fields fill what the entry left undeclared.
    const named = resolveModelRef(config, 'gpt-4o');
    expect(named.temperature).toBe(0.2);
    expect(named.maxOutputTokens).toBe(4096);

    // Composite `"provider/model"`.
    const composite = resolveModelRef(config, 'default/gpt-4o');
    expect(composite.temperature).toBe(0.2);
    expect(composite.maxOutputTokens).toBe(4096);

    // Inline object: its own values win over the provider defaults.
    const inline = resolveModelRef(config, {
      provider: 'default',
      name: 'gpt-4o',
      temperature: 0.7,
      maxOutputTokens: 99,
    });
    expect(inline.temperature).toBe(0.7);
    expect(inline.maxOutputTokens).toBe(99);
  });
});

describe('resolveModelRef: workers.<id>.model', () => {
  it('resolves the model of a third-party worker row (not consumed until step 2)', () => {
    const config: WayangConfig = {
      providers: { openai: { baseURL: 'https://api.openai.com/v1', apiKey: 'sk-x' } },
      models: { coder: { provider: 'openai', name: 'gpt-4o' } },
      controller: { model: 'coder' },
      worker: { maxConcurrency: 1 },
      workers: {
        'claude-code': { type: 'claude-code', description: 'coding worker', model: 'coder' },
      },
    };
    const ref = config.workers?.['claude-code']?.model;
    expect(resolveModelRef(config, ref)).toMatchObject({ providerKey: 'openai', modelName: 'gpt-4o', source: 'models' });
  });
});
