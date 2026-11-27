import { describe, it, expect } from 'vitest';
import { validateConfig, type WayangConfig } from '@wayang-ai/protocol/types/config';

/**
 * Canonical config (#88): models + model refs — the only shape validateConfig
 * understands. The pre-#88 spellings are translated by the host at its config
 * entry (protocol normalizeConfig, covered by its own suite) and refused by
 * core's intake (validateCanonicalConfig).
 */
function newConfig(overrides: Partial<WayangConfig> = {}): WayangConfig {
  return {
    providers: { openai: { baseURL: 'https://api.openai.com/v1', apiKey: 'sk-x' } },
    models: { 'gpt-4o': { provider: 'openai', name: 'gpt-4o' } },
    controller: { model: 'gpt-4o' },
    worker: { maxConcurrency: 1 },
    ...overrides,
  };
}

describe('validateConfig: models (#88)', () => {
  it('accepts a models + model-ref config', () => {
    expect(validateConfig(newConfig())).toBeNull();
  });

  it('rejects a provider without a base URL', () => {
    expect(validateConfig(newConfig({ providers: { openai: { apiKey: 'k' } } }))).toBe('providers.openai.baseURL is required');
  });

  it('does not understand the legacy endpoint alias — the host translates it before validation', () => {
    const legacy = newConfig({
      providers: { openai: { endpoint: 'http://alias', apiKey: 'k' } } as unknown as WayangConfig['providers'],
    });
    expect(validateConfig(legacy)).toBe('providers.openai.baseURL is required');
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
});
