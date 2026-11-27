// Onboard writes the post-#88 config shape: a provider (type + baseURL), a
// `models.default` entry and `controller.model` / `worker.model` references.
// A new user must not start with any deprecation warning.
//
// Migrated from packages/core/src/__tests__/onboard.test.ts together with the
// loader itself (monorepo-design 4.1 改造一): config loading is a host (cli)
// concern now. The loader suite below pins the CLI as THE config entry: the
// pre-#88 spellings are translated once here (protocol normalizeConfig), the
// WAYANG_* model fallback is materialized here, and what leaves is canonical
// — core accepts nothing else.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import prompts from 'prompts';
import { bindEnvModelFallback, buildOnboardConfig, loadConfig } from '@/config-loader';
import { validateConfig, findLegacyConfigKeys, validateCanonicalConfig } from '@wayang-ai/protocol';
import type { WayangConfig } from '@wayang-ai/protocol';

// The interactive path is exercised with a scripted prompts mock — the
// loader's prompts surface is exactly the library's default function.
vi.mock('prompts', () => ({ default: vi.fn() }));

const ENV_MODEL = { WAYANG_LLM_API_KEY: 'sk-env', WAYANG_ENDPOINT: 'http://env', WAYANG_MODEL: 'env-model' } as const;

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
    expect(findLegacyConfigKeys(config)).toEqual([]);
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
      expect(findLegacyConfigKeys(config)).toEqual([]);

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
// The CLI is the single config-resolution point: file parsing, the legacy
// spelling translation, the env model fallback, a custom --config path and
// the interactive onboard prompts all live HERE, and every path produces a
// validated, canonical object.

describe('config-loader: file / env / --config path / prompts', () => {
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
    // Hermetic by default: the developer's shell may carry a complete
    // WAYANG_* triplet, which would turn every unbound fixture into a
    // fallback. Tests that need the env model set it explicitly.
    vi.stubEnv('WAYANG_LLM_API_KEY', '');
    vi.stubEnv('WAYANG_ENDPOINT', '');
    vi.stubEnv('WAYANG_MODEL', '');
    vi.stubEnv('WAYANG_CONTEXT_WINDOW_TOKENS', '');
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
    // A canonical file is translated to itself: nothing to report.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('translates a pre-#88 config file once, at the entry — canonical result, one warning per spelling, file untouched', async () => {
    const configPath = join(dir, 'config.json');
    const legacyFile = JSON.stringify({
      providers: { legacy: { endpoint: 'http://legacy-endpoint', apiKey: 'legacy-key', modelName: 'legacy-model', contextWindowTokens: 128_000 } },
      controller: { provider: 'legacy' },
      worker: { provider: 'legacy', maxConcurrency: 1 },
      permission: { deniedDirs: ['/vault'] },
    });
    writeFileSync(configPath, legacyFile);

    const config = await loadConfig(configPath);

    // The loader must not reject the legacy spelling — it translates it.
    // (toEqual, not toStrictEqual: fillApiKeys leaves a `tavilyApiKey: undefined`
    // key behind when no Tavily key is configured — pre-existing, harmless.)
    expect(config).toEqual({
      providers: { legacy: { baseURL: 'http://legacy-endpoint', apiKey: 'legacy-key' } },
      models: { legacy: { provider: 'legacy', name: 'legacy-model', contextWindowTokens: 128_000 } },
      controller: { model: 'legacy' },
      worker: { model: 'legacy', maxConcurrency: 1 },
      permission: { sensitiveDirs: ['/vault'] },
    });
    expect(findLegacyConfigKeys(config)).toEqual([]);
    expect(validateCanonicalConfig(config)).toBeNull();
    // Every translation is surfaced once.
    const warned = warnSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(warned).toEqual([
      'Warning: providers.legacy.endpoint is deprecated — translated to baseURL',
      'Warning: providers.legacy.modelName is deprecated — translated to models.legacy',
      'Warning: controller.provider is deprecated — translated to controller.model = "legacy"',
      'Warning: worker.provider is deprecated — translated to worker.model = "legacy"',
      'Warning: providers.legacy.contextWindowTokens is deprecated — moved onto models.legacy',
      'Warning: permission.deniedDirs is deprecated — merged into permission.sensitiveDirs',
    ]);
    // The user's file is never rewritten.
    expect(readFileSync(configPath, 'utf-8')).toBe(legacyFile);
  });

  it('reads exactly the given --config path (config not at the default location)', async () => {
    mkdirSync(join(dir, 'nested'), { recursive: true });
    const customPath = join(dir, 'nested', 'custom-name.json');
    writeFileSync(customPath, JSON.stringify({
      providers: { custom: { baseURL: 'http://custom', apiKey: 'k' } },
      models: { m: { provider: 'custom', name: 'x' } },
      controller: { model: 'm' },
      worker: { model: 'm', maxConcurrency: 1 },
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

// --- The WAYANG_* model fallback, materialized at the entry -----------------
//
// core has no env fallback any more (it never reads process.env for its
// config): the documented priority binding > env > error is realised HERE, as
// a real provider + models entry, so what reaches core is canonical.

const unbound: WayangConfig = {
  providers: { file: { baseURL: 'http://file', apiKey: 'file-key' } },
  models: { m: { provider: 'file', name: 'file-model' } },
  controller: { model: 'm' },
  worker: { maxConcurrency: 2 },
};

describe('bindEnvModelFallback (the env model, materialized at the config entry)', () => {
  it('binds a still-empty binding to the env model — a real provider + models entry, the onboard shape', () => {
    const config = bindEnvModelFallback({ ...unbound, controller: {} }, { ...ENV_MODEL, WAYANG_CONTEXT_WINDOW_TOKENS: '32000' });

    expect(config.providers.default).toEqual({ type: 'openai-compatible', baseURL: 'http://env', apiKey: 'sk-env' });
    expect(config.models?.default).toEqual({ provider: 'default', name: 'env-model', contextWindowTokens: 32_000 });
    expect(config.controller).toEqual({ model: 'default' });
    expect(config.worker.model).toBe('default');
    expect(validateCanonicalConfig(config)).toBeNull();
  });

  it('binds only the missing side — a present binding is never overridden', () => {
    const config = bindEnvModelFallback(unbound, ENV_MODEL);

    expect(config.controller).toEqual({ model: 'm' });
    expect(config.worker.model).toBe('default');
  });

  it('leaves a fully bound config alone, even with a complete environment', () => {
    const bound: WayangConfig = { ...unbound, worker: { model: 'm', maxConcurrency: 2 } };
    expect(bindEnvModelFallback(bound, ENV_MODEL)).toBe(bound);
  });

  it('is no fallback for a partial environment — the binding stays empty for core to report', () => {
    const config = bindEnvModelFallback({ ...unbound, controller: {} }, { WAYANG_LLM_API_KEY: 'sk-env', WAYANG_ENDPOINT: 'http://env' });

    expect(config).toStrictEqual({ ...unbound, controller: {} });
    // Structurally valid, but unbound: core's model resolution reports it.
    expect(validateConfig(config)).toBeNull();
  });

  it('ignores an invalid context window instead of inventing one', () => {
    const config = bindEnvModelFallback(unbound, { ...ENV_MODEL, WAYANG_CONTEXT_WINDOW_TOKENS: 'soon' });
    expect(config.models?.default).toEqual({ provider: 'default', name: 'env-model' });
  });

  it('picks a free entry key when `default` is already taken', () => {
    const taken: WayangConfig = {
      providers: { default: { baseURL: 'http://file', apiKey: 'file-key' } },
      models: { default: { provider: 'default', name: 'file-model' } },
      controller: { model: 'default' },
      worker: { maxConcurrency: 1 },
    };
    const config = bindEnvModelFallback(taken, ENV_MODEL);

    expect(Object.keys(config.providers)).toEqual(['default', 'default-2']);
    expect(config.models?.['default-2']).toEqual({ provider: 'default-2', name: 'env-model' });
    expect(config.worker.model).toBe('default-2');
    expect(config.controller.model).toBe('default');
  });
});

describe('loadConfig: the env model fallback through the loader', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it('materializes the env model for a config file that binds nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wayang-loader-env-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      providers: { file: { baseURL: 'http://file' } },
      controller: {},
      worker: { maxConcurrency: 1 },
    }));
    vi.stubEnv('WAYANG_LLM_API_KEY', 'sk-env');
    vi.stubEnv('WAYANG_ENDPOINT', 'http://env');
    vi.stubEnv('WAYANG_MODEL', 'env-model');
    try {
      const config = await loadConfig(configPath);

      // fillApiKeys filled the file provider's key; the binding went to the env model.
      expect(config.providers.file.apiKey).toBe('sk-env');
      expect(config.controller.model).toBe('default');
      expect(config.worker.model).toBe('default');
      expect(validateCanonicalConfig(config)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
