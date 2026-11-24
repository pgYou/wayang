// Onboard writes the post-#88 config shape: a provider (type + baseURL), a
// `models.default` entry and `controller.model` / `worker.model` references.
// A new user must not start with the legacy provider fields' deprecation
// warnings (the review measured four on every startup).
//
// Migrated from packages/core/src/__tests__/onboard.test.ts together with the
// loader itself (monorepo-design 4.1 改造一): config loading is a host (cli)
// concern now.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import prompts from 'prompts';
import { buildOnboardConfig, loadConfig } from '@/config-loader';
import { validateConfig, collectProviderWarnings } from '@wayang-ai/protocol';

// The interactive path is exercised with a scripted prompts mock — the
// loader's prompts surface is exactly the library's default function.
vi.mock('prompts', () => ({ default: vi.fn() }));

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

// --- Host-side loader suite (monorepo-design 4.1 改造一) ---
//
// The CLI is the single config-resolution point: file parsing, env fallback,
// the deprecated endpoint alias, a custom --config path and the interactive
// onboard prompts all live HERE, and every path produces a validated object.

describe('config-loader: file / env / alias / --config path / prompts', () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wayang-loader-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    vi.unstubAllEnvs();
    vi.mocked(prompts).mockReset();
  });

  it('parses an existing config file into a validated object (file path)', async () => {
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      providers: { main: { type: 'openai-compatible', baseURL: 'http://file', apiKey: 'file-key' } },
      models: { m: { provider: 'main', name: 'file-model', contextWindowTokens: 64_000 } },
      controller: { model: 'm' },
      worker: { model: 'm', maxConcurrency: 2 },
    }));

    const config = await loadConfig(configPath);

    expect(config.providers.main.baseURL).toBe('http://file');
    expect(config.models?.m.name).toBe('file-model');
    expect(config.controller.model).toBe('m');
    expect(validateConfig(config)).toBeNull();
  });

  it('honours the deprecated `endpoint` alias of `baseURL` (no error, value preserved)', async () => {
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      providers: { legacy: { endpoint: 'http://legacy-endpoint', apiKey: 'legacy-key', modelName: 'legacy-model' } },
      controller: { provider: 'legacy' },
      worker: { provider: 'legacy', maxConcurrency: 1 },
    }));

    // The alias loads and validates — the resolution layer reads
    // `baseURL ?? endpoint`; the loader must not reject the legacy spelling.
    const config = await loadConfig(configPath);
    expect(config.providers.legacy.endpoint).toBe('http://legacy-endpoint');
    expect(validateConfig(config)).toBeNull();
  });

  it('reads exactly the given --config path (config not at the default location)', async () => {
    mkdirSync(join(dir, 'nested'), { recursive: true });
    const customPath = join(dir, 'nested', 'custom-name.json');
    writeFileSync(customPath, JSON.stringify({
      providers: { custom: { baseURL: 'http://custom', apiKey: 'k' } },
      controller: { provider: 'custom' },
      worker: { provider: 'custom', maxConcurrency: 1 },
    }));

    const config = await loadConfig(customPath);

    expect(config.providers.custom.baseURL).toBe('http://custom');
    // The default location is NOT consulted: nothing was created there.
    expect(readFileSync(customPath, 'utf-8')).toContain('http://custom');
  });

  it('onboard prompts (mocked TTY) build and persist the config when no file and no env exist', async () => {
    vi.mocked(prompts)
      // First call: the five main questions (endpoint/apiKey/model/window/concurrency).
      .mockResolvedValueOnce({
        endpoint: 'http://prompted',
        apiKey: 'sk-prompted',
        modelName: 'prompted-model',
        contextWindowTokens: 96_000,
        maxConcurrency: 2,
      } as never)
      // Second call: the Claude Code worker confirm — declined.
      .mockResolvedValueOnce({ enable: false } as never);
    vi.stubEnv('WAYANG_LLM_API_KEY', '');
    vi.stubEnv('WAYANG_ENDPOINT', '');
    vi.stubEnv('WAYANG_MODEL', '');
    vi.stubEnv('WAYANG_TAVILY_API_KEY', '');

    const configPath = join(dir, 'fresh', 'wayang.config.json');
    const config = await loadConfig(configPath);

    // The prompts answers produced the post-#88 shape…
    expect(config.providers.default).toEqual({
      type: 'openai-compatible',
      baseURL: 'http://prompted',
      apiKey: 'sk-prompted',
    });
    expect(config.models?.default).toEqual({
      provider: 'default',
      name: 'prompted-model',
      contextWindowTokens: 96_000,
    });
    expect(config.worker.maxConcurrency).toBe(2);
    expect(config.workers).toBeUndefined(); // worker confirm declined
    expect(validateConfig(config)).toBeNull();
    // …and the config was persisted for the next run.
    const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as { providers: Record<string, unknown> };
    expect(raw.providers.default).toEqual({ type: 'openai-compatible', baseURL: 'http://prompted', apiKey: 'sk-prompted' });
    // The interactive flow ran exactly the two prompt rounds.
    expect(prompts).toHaveBeenCalledTimes(2);
  });

  it('non-interactive (server-host) mode: missing file AND incomplete env is a hard error, never a prompt', async () => {
    vi.stubEnv('WAYANG_LLM_API_KEY', '');
    vi.stubEnv('WAYANG_ENDPOINT', '');
    vi.stubEnv('WAYANG_MODEL', '');

    await expect(loadConfig(join(dir, 'config.json'), { nonInteractive: true }))
      .rejects.toThrow(/Config not found at .* and WAYANG_\* env vars are incomplete/);
    expect(prompts).not.toHaveBeenCalled();
  });

  it('non-interactive mode: broken JSON in the config file is a hard error naming the path', async () => {
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, '{ not json');

    await expect(loadConfig(configPath, { nonInteractive: true }))
      .rejects.toThrow(new RegExp(`Invalid config JSON at ${configPath.replace(/[/\\\\]/g, (c) => `\\${c}`)}`));
    expect(prompts).not.toHaveBeenCalled();
  });
});
