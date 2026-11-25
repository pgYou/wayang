import { describe, it, expect } from 'vitest';
import { validateConfig, collectProviderWarnings, type WayangConfig } from '@wayang-ai/protocol/types/config';

/** New-style config (#88): models + model refs, no provider.modelName. */
function newConfig(overrides: Partial<WayangConfig> = {}): WayangConfig {
  return {
    providers: { openai: { baseURL: 'https://api.openai.com/v1', apiKey: 'sk-x' } },
    models: { 'gpt-4o': { provider: 'openai', name: 'gpt-4o' } },
    controller: { model: 'gpt-4o' },
    worker: { maxConcurrency: 1 },
    ...overrides,
  };
}

/** Pre-#88 config: providers carry the model, refs point at providers. */
function legacyConfig(): WayangConfig {
  return {
    providers: { p: { endpoint: 'http://localhost', apiKey: 'k', modelName: 'm' } },
    controller: { provider: 'p' },
    worker: { provider: 'p', maxConcurrency: 1 },
  };
}

describe('validateConfig: models (#88)', () => {
  it('accepts a models + model-ref config with no provider.modelName', () => {
    expect(validateConfig(newConfig())).toBeNull();
  });

  it('keeps accepting a legacy config that only declares provider.modelName', () => {
    expect(validateConfig(legacyConfig())).toBeNull();
  });

  it('accepts the deprecated endpoint alias and rejects a provider without any base URL', () => {
    expect(validateConfig(newConfig({ providers: { openai: { endpoint: 'http://alias', apiKey: 'k' } } }))).toBeNull();
    const err = validateConfig(newConfig({ providers: { openai: { apiKey: 'k' } } }));
    expect(err).toContain('providers.openai.baseURL is required');
  });

  it('rejects a provider type other than openai-compatible', () => {
    const err = validateConfig(
      newConfig({ providers: { openai: { baseURL: 'http://x', apiKey: 'k', type: 'anthropic' as never } } }),
    );
    expect(err).toContain("providers.openai.type must be 'openai-compatible'");
  });

  it('rejects a models entry whose provider does not exist, listing the available providers', () => {
    const err = validateConfig(newConfig({ models: { m: { provider: 'nope', name: 'x' } } }));
    expect(err).toContain('models.m.provider "nope" not found');
    expect(err).toContain('openai');
  });

  it('rejects an empty model name', () => {
    expect(validateConfig(newConfig({ models: { m: { provider: 'openai', name: '' } } }))).toContain(
      'models.m.name must be a non-empty string',
    );
  });

  it.each([0, -1, 1.5])('rejects a non-positive-integer contextWindowTokens (%s)', (bad) => {
    expect(validateConfig(newConfig({ models: { m: { provider: 'openai', name: 'x', contextWindowTokens: bad } } }))).toContain(
      'models.m.contextWindowTokens must be a positive integer',
    );
  });
});

describe('validateConfig: model refs (#88)', () => {
  it('accepts a models key, a "provider/name" composite, and an inline object', () => {
    expect(validateConfig(newConfig())).toBeNull();
    expect(validateConfig(newConfig({ controller: { model: 'openai/other' } }))).toBeNull();
    expect(validateConfig(newConfig({ controller: { model: { provider: 'openai', name: 'inline-model' } } }))).toBeNull();
  });

  it('rejects an unknown controller.model string and lists the available model names', () => {
    const err = validateConfig(newConfig({ controller: { model: 'nope' } }));
    expect(err).toContain('controller.model "nope" is not a known model');
    expect(err).toContain('gpt-4o');
    expect(err).toContain('provider/name');
  });

  it('rejects an unknown worker.model string and an unknown workers.<id>.model string', () => {
    expect(validateConfig(newConfig({ worker: { maxConcurrency: 1, model: 'nope' } }))).toContain('worker.model "nope"');
    expect(
      validateConfig(
        newConfig({
          workers: { 'claude-code': { type: 'claude-code', description: 'x', model: 'nope' } },
        }),
      ),
    ).toContain('workers.claude-code.model "nope"');
  });

  it('still rejects an unknown legacy controller/worker provider', () => {
    expect(validateConfig(newConfig({ controller: { provider: 'nope' } }))).toContain('controller.provider "nope" not found');
    expect(validateConfig(newConfig({ worker: { maxConcurrency: 1, provider: 'nope' } }))).toContain('worker.provider "nope" not found');
  });
});

describe('collectProviderWarnings (#88)', () => {
  it('returns one warning per provider that still declares deprecated model fields', () => {
    const warnings = collectProviderWarnings(legacyConfig());
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('providers.p.modelName');
    expect(warnings[0]).toContain('models');
    // A legacy provider with no competing model ref keeps its modelName.
    expect(warnings.some((w) => w.includes('已忽略'))).toBe(false);
  });

  it('returns no warning for a clean models config', () => {
    expect(collectProviderWarnings(newConfig())).toEqual([]);
  });

  it('warns that providers.<x>.modelName is ignored when a model ref targets that provider', () => {
    const config = newConfig({
      providers: { openai: { baseURL: 'https://api.openai.com/v1', apiKey: 'sk-x', modelName: 'legacy-model' } },
    });
    const warnings = collectProviderWarnings(config);
    expect(warnings.some((w) => w.includes('providers.openai.modelName') && w.includes('models'))).toBe(true);
    expect(warnings.some((w) => w.includes('已忽略 providers.openai.modelName'))).toBe(true);
  });

  it('does not report "ignored" when the provider is only used through its legacy provider key', () => {
    const config: WayangConfig = {
      providers: { openai: { baseURL: 'https://api.openai.com/v1', apiKey: 'sk-x', modelName: 'legacy-model' } },
      models: { other: { provider: 'openai', name: 'other-model' } },
      controller: { provider: 'openai' },
      worker: { provider: 'openai', maxConcurrency: 1 },
    };
    const warnings = collectProviderWarnings(config);
    expect(warnings.some((w) => w.includes('已忽略'))).toBe(false);
  });

  it('collects one warning per provider when several providers are deprecated', () => {
    const config: WayangConfig = {
      providers: {
        a: { endpoint: 'http://a', apiKey: 'k', modelName: 'm' },
        b: { baseURL: 'http://b', apiKey: 'k', contextWindowTokens: 128_000 },
      },
      controller: { provider: 'a' },
      worker: { provider: 'a', maxConcurrency: 1 },
    };
    const warnings = collectProviderWarnings(config);
    expect(warnings.filter((w) => w.includes('providers.a.'))).toHaveLength(1);
    expect(warnings.filter((w) => w.includes('providers.b.'))).toHaveLength(1);
  });
});
