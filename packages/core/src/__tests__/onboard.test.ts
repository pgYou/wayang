// Onboard writes the post-#88 config shape: a provider (type + baseURL), a
// `models.default` entry and `controller.model` / `worker.model` references.
// A new user must not start with the legacy provider fields' deprecation
// warnings (the review measured four on every startup).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildOnboardConfig, loadConfig } from '@/onboard';
import { validateConfig, collectProviderWarnings } from '@wayang-ai/protocol';

describe('onboard config generation (issue #88)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('builds the new shape: provider type + baseURL, models.default, model refs, no modelName', () => {
    const config = buildOnboardConfig({
      endpoint: 'https://api.example.com/v1',
      apiKey: 'sk-x',
      modelName: 'gpt-4o',
      contextWindowTokens: 128_000,
      maxConcurrency: 3,
    });

    expect(config.providers.default).toEqual({
      type: 'openai-compatible',
      baseURL: 'https://api.example.com/v1',
      apiKey: 'sk-x',
    });
    expect(config.providers.default).not.toHaveProperty('modelName');
    expect(config.models?.default).toEqual({
      provider: 'default',
      name: 'gpt-4o',
      contextWindowTokens: 128_000,
    });
    expect(config.controller.model).toBe('default');
    expect(config.worker.model).toBe('default');
    expect(config.worker.maxConcurrency).toBe(3);
    expect(validateConfig(config)).toBeNull();
    expect(collectProviderWarnings(config)).toEqual([]);
  });

  it('the env path writes the same new shape (no deprecated provider fields)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wayang-onboard-'));
    const configPath = join(dir, 'config.json');
    vi.stubEnv('WAYANG_LLM_API_KEY', 'sk-env');
    vi.stubEnv('WAYANG_ENDPOINT', 'http://env');
    vi.stubEnv('WAYANG_MODEL', 'env-model');
    vi.stubEnv('WAYANG_CONTEXT_WINDOW_TOKENS', '32000');

    try {
      const config = await loadConfig(configPath);

      expect(config.providers.default).not.toHaveProperty('modelName');
      expect(config.providers.default).not.toHaveProperty('contextWindowTokens');
      expect(config.providers.default).toEqual({
        type: 'openai-compatible',
        baseURL: 'http://env',
        apiKey: 'sk-env',
      });
      expect(config.models?.default).toEqual({
        provider: 'default',
        name: 'env-model',
        contextWindowTokens: 32_000,
      });
      expect(config.controller.model).toBe('default');
      expect(config.worker.model).toBe('default');
      expect(validateConfig(config)).toBeNull();
      expect(collectProviderWarnings(config)).toEqual([]);

      // What was actually written to disk carries the same shape.
      const raw = JSON.parse(readFileSync(configPath, 'utf8')) as {
        providers: Record<string, Record<string, unknown>>;
        models: Record<string, Record<string, unknown>>;
        controller: { model?: string };
        worker: { model?: string };
      };
      expect(raw.providers.default).not.toHaveProperty('modelName');
      expect(raw.models.default).toEqual({
        provider: 'default',
        name: 'env-model',
        contextWindowTokens: 32_000,
      });
      expect(raw.controller.model).toBe('default');
      expect(raw.worker.model).toBe('default');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
