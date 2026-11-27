import { describe, it, expect } from 'vitest';
import type { WayangConfig } from '@wayang-ai/protocol/types/config';
import { resolveModelRef, ConfigError } from '@/services/config/model-resolution';

/**
 * core resolves canonical model references only (issue #88). The pre-#88
 * spellings and the env fallback never reach this layer: the host translates
 * them at its config entry (protocol normalizeConfig) and core's intake
 * refuses a config that still carries a legacy key.
 */

describe('resolveModelRef: named models (issue #88)', () => {
  it('resolves a short name through top-level models', () => {
    const config: WayangConfig = {
      providers: { openai: { baseURL: 'https://api.openai.com/v1', apiKey: 'sk-x' } },
      models: { 'gpt-4o': { provider: 'openai', name: 'gpt-4o', contextWindowTokens: 128_000 } },
      controller: { model: 'gpt-4o' },
      worker: { maxConcurrency: 1 },
    };
    expect(resolveModelRef(config, config.controller.model)).toEqual({
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

  it('leaves contextWindowTokens undefined when the model does not declare it', () => {
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
      providers: { openai: { baseURL: 'https://api.openai.com/v1', apiKey: 'sk-x' } },
      models: { existing: { provider: 'openai', name: 'gpt-4o' } },
      controller: { model: { provider: 'openai', name: 'gpt-4o-mini', temperature: 0.5, contextWindowTokens: 64_000 } },
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

describe('resolveModelRef: request parameters', () => {
  const config: WayangConfig = {
    providers: { openai: { baseURL: 'https://api.openai.com/v1', apiKey: 'sk-x' } },
    models: { 'gpt-4o': { provider: 'openai', name: 'gpt-4o', contextWindowTokens: 128_000 } },
    controller: { model: 'gpt-4o' },
    worker: { maxConcurrency: 1 },
  };

  it('a models entry without request parameters resolves them undefined', () => {
    const named = resolveModelRef(config, 'gpt-4o');
    expect(named.temperature).toBeUndefined();
    expect(named.maxOutputTokens).toBeUndefined();
    expect(named.contextWindowTokens).toBe(128_000);
  });

  it('a "provider/model" composite carries neither a window budget nor request parameters (no declaration surface)', () => {
    const composite = resolveModelRef(config, 'openai/gpt-4o');
    expect(composite).toEqual({
      providerKey: 'openai',
      modelName: 'gpt-4o',
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-x',
      maxOutputTokens: undefined,
      temperature: undefined,
      source: 'composite',
    });
  });

  it('model-level explicit declarations still apply (named entry and inline)', () => {
    const tuned: WayangConfig = {
      ...config,
      models: { tuned: { provider: 'openai', name: 'gpt-4o', temperature: 0.7, maxOutputTokens: 99 } },
    };
    expect(resolveModelRef(tuned, 'tuned')).toMatchObject({ temperature: 0.7, maxOutputTokens: 99 });

    const inline = resolveModelRef(config, {
      provider: 'openai',
      name: 'gpt-4o',
      temperature: 0.7,
      maxOutputTokens: 99,
    });
    expect(inline.temperature).toBe(0.7);
    expect(inline.maxOutputTokens).toBe(99);
  });
});

describe('resolveModelRef: nothing configured', () => {
  it('throws ConfigError when the binding is empty — core has no fallback', () => {
    const config: WayangConfig = {
      providers: { openai: { baseURL: 'https://api.openai.com/v1', apiKey: 'sk-x' } },
      controller: {},
      worker: { maxConcurrency: 1 },
    };
    expect(() => resolveModelRef(config, undefined)).toThrow(ConfigError);
    expect(() => resolveModelRef(config, undefined)).toThrow('model reference is not configured');
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
