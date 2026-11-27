// Behavioural lock for normalizeConfig / findLegacyConfigKeys /
// validateCanonicalConfig — the single translation point from legacy config
// spellings to the canonical shape, and the intake check built on it. Every
// translation case pins behaviour preservation against the pre-#88 resolution
// rules: same model name, base URL, window budget and request parameters
// before and after the translation.

import { describe, it, expect } from 'vitest';
import { normalizeConfig, findLegacyConfigKeys, validateCanonicalConfig } from '../config-normalize';
import { validateConfig, type WayangConfig } from '../config';

// --- Fixtures ------------------------------------------------------------

/**
 * A pre-#88 config. The legacy spellings are not part of the `WayangConfig`
 * TYPE any more — that is the point of the split — so legacy fixtures are
 * built untyped and cast here, exactly like the JSON a host reads off disk.
 */
const pre88 = (config: unknown): WayangConfig => config as WayangConfig;

/** A real pre-#88 CLI config: one provider per model, provider-key bindings. */
const legacy: WayangConfig = pre88({
  providers: {
    'ds-flash': { endpoint: 'https://api.deepseek.com', apiKey: 'k1', modelName: 'deepseek-flash' },
    hub: {
      endpoint: 'https://hub/v3',
      apiKey: 'k2',
      modelName: 'ds-v4',
      contextWindowTokens: 1_000_000,
      temperature: 0.3,
      maxOutputTokens: 8192,
    },
  },
  controller: { provider: 'hub' },
  worker: { provider: 'hub', maxConcurrency: 3, toolChoice: 'auto', maxTurns: 1000 },
  workers: { cc: { type: 'claude-code', description: 'coding' } },
});

/** What `legacy` must become: models entries keyed by the provider key, bindings by reference. */
const canonical: WayangConfig = {
  providers: {
    'ds-flash': { baseURL: 'https://api.deepseek.com', apiKey: 'k1' },
    hub: { baseURL: 'https://hub/v3', apiKey: 'k2' },
  },
  models: {
    'ds-flash': { provider: 'ds-flash', name: 'deepseek-flash' },
    hub: { provider: 'hub', name: 'ds-v4', contextWindowTokens: 1_000_000 },
  },
  controller: { model: 'hub' },
  worker: { model: 'hub', maxConcurrency: 3, toolChoice: 'auto', maxTurns: 1000 },
  workers: { cc: { type: 'claude-code', description: 'coding' } },
};

describe('normalizeConfig (legacy → canonical)', () => {
  it('translates a pre-#88 config into models entries + model references, and leaves the input untouched', () => {
    const pristine = structuredClone(legacy);
    const { config, notes } = normalizeConfig(legacy);

    expect(config).toStrictEqual(canonical);
    // The canonical reading order (the result lands in user-readable files):
    // `models` right after `providers`, `baseURL` / `model` leading their objects.
    expect(Object.keys(config)).toStrictEqual(['providers', 'models', 'controller', 'worker', 'workers']);
    expect(Object.keys(config.providers.hub)).toStrictEqual(['baseURL', 'apiKey']);
    expect(Object.keys(config.worker)).toStrictEqual(['model', 'maxConcurrency', 'toolChoice', 'maxTurns']);
    // The result is canonical and usable as-is.
    expect(findLegacyConfigKeys(config)).toStrictEqual([]);
    expect(validateCanonicalConfig(config)).toBeNull();
    // The caller's object is never mutated (the CLI file content, a draft…).
    expect(legacy).toStrictEqual(pristine);
    // One line per translated spelling, in config order.
    expect(notes).toStrictEqual([
      'providers.ds-flash.endpoint is deprecated — translated to baseURL',
      'providers.hub.endpoint is deprecated — translated to baseURL',
      'providers.ds-flash.modelName is deprecated — translated to models.ds-flash',
      'providers.hub.modelName is deprecated — translated to models.hub',
      'controller.provider is deprecated — translated to controller.model = "hub"',
      'worker.provider is deprecated — translated to worker.model = "hub"',
      'providers.hub.contextWindowTokens is deprecated — moved onto models.hub',
      'providers.hub.temperature / maxOutputTokens are deprecated — dropped (the legacy resolution never sent them)',
    ]);
  });

  it('is the identity on canonical input', () => {
    expect(normalizeConfig(canonical)).toStrictEqual({ config: canonical, notes: [] });
    // Twice is once: normalizing an already-normalized config changes nothing.
    expect(normalizeConfig(normalizeConfig(legacy).config)).toStrictEqual({ config: canonical, notes: [] });
  });

  it('findLegacyConfigKeys inventories every deprecated key, in config order', () => {
    expect(
      findLegacyConfigKeys(
        pre88({
          ...legacy,
          permission: { deniedDirs: ['/secrets'] },
          workers: {
            // The deprecated spelling is not a WorkerType any more — that is the point.
            cb: { type: 'codebuddy-acp', description: 'x' },
            cc: { type: 'claude-code', description: 'y' },
          },
        }),
      ),
    ).toStrictEqual([
      'providers.ds-flash.endpoint',
      'providers.ds-flash.modelName',
      'providers.hub.endpoint',
      'providers.hub.modelName',
      'providers.hub.contextWindowTokens',
      'providers.hub.temperature',
      'providers.hub.maxOutputTokens',
      'controller.provider',
      'worker.provider',
      'permission.deniedDirs',
      'workers.cb.type',
    ]);
    expect(findLegacyConfigKeys(canonical)).toStrictEqual([]);
  });

  it('baseURL wins over a coexisting endpoint alias', () => {
    const { config } = normalizeConfig(
      pre88({
        providers: { hub: { baseURL: 'https://a/v1', endpoint: 'https://b/v1', apiKey: 'k' } },
        controller: {},
        worker: { maxConcurrency: 1 },
      }),
    );
    expect(config.providers.hub).toStrictEqual({ baseURL: 'https://a/v1', apiKey: 'k' });
  });
});

describe('validateCanonicalConfig (the intake check)', () => {
  it('accepts a canonical, structurally valid config', () => {
    expect(validateCanonicalConfig(canonical)).toBeNull();
  });

  it('refuses a config that still carries a legacy key — naming every one of them', () => {
    expect(validateCanonicalConfig(legacy)).toBe(
      'config carries deprecated keys (providers.ds-flash.endpoint, providers.ds-flash.modelName, providers.hub.endpoint, ' +
        'providers.hub.modelName, providers.hub.contextWindowTokens, providers.hub.temperature, providers.hub.maxOutputTokens, ' +
        'controller.provider, worker.provider) — the host must call normalizeConfig at its config entry before handing a config to core',
    );
    // A single leftover key is enough — e.g. a host that only half-translated.
    expect(validateCanonicalConfig({ ...canonical, controller: { model: 'hub', provider: 'hub' } as unknown as WayangConfig['controller'] })).toMatch(
      /^config carries deprecated keys \(controller\.provider\)/,
    );
  });

  it('falls through to the structural validation once the shape is canonical', () => {
    const broken: WayangConfig = { ...canonical, providers: { hub: { apiKey: 'k' } } };
    expect(validateCanonicalConfig(broken)).toBe('providers.hub.baseURL is required');
  });

  it('reports a malformed top level as a problem instead of throwing (an intake never leaks a TypeError)', () => {
    expect(validateCanonicalConfig({ controller: {}, worker: {} } as unknown as WayangConfig)).toMatch(/^malformed config \(/);
  });
});

describe('normalizeConfig (window budget: moved, never lost, never invented)', () => {
  it('moves a provider window onto the entries and references that inherit it; materializes composites', () => {
    const { config } = normalizeConfig(
      pre88({
        providers: { hub: { baseURL: 'https://hub/v3', apiKey: 'k', modelName: 'old', contextWindowTokens: 200_000 } },
        models: {
          fast: { provider: 'hub', name: 'fast-model' },
          big: { provider: 'hub', name: 'big-model', contextWindowTokens: 64_000 },
        },
        controller: { model: 'fast' },
        // A composite inherited the provider's window — it becomes an entry carrying it.
        worker: { model: 'hub/other', maxConcurrency: 1 },
      }),
    );
    // The implicit model lands under the PROVIDER key ("hub"), not its model name.
    expect(config.models).toStrictEqual({
      fast: { provider: 'hub', name: 'fast-model', contextWindowTokens: 200_000 },
      big: { provider: 'hub', name: 'big-model', contextWindowTokens: 64_000 },
      hub: { provider: 'hub', name: 'old', contextWindowTokens: 200_000 },
      other: { provider: 'hub', name: 'other', contextWindowTokens: 200_000 },
    });
    expect(config.controller).toStrictEqual({ model: 'fast' });
    expect(config.worker.model).toBe('other');
    expect(config.providers.hub).toStrictEqual({ baseURL: 'https://hub/v3', apiKey: 'k' });
  });

  it('leaves a composite alone when the provider declares no window budget', () => {
    const { config, notes } = normalizeConfig({
      providers: { hub: { baseURL: 'https://hub/v3', apiKey: 'k' } },
      controller: { model: 'hub/x' },
      worker: { model: 'hub/x', maxConcurrency: 1 },
    });
    expect(config.controller.model).toBe('hub/x');
    expect(config.models).toBeUndefined();
    expect(notes).toStrictEqual([]);
  });

  it('fills an inline reference with the provider window it inherits', () => {
    const { config } = normalizeConfig(
      pre88({
        providers: { hub: { baseURL: 'https://hub/v3', apiKey: 'k', contextWindowTokens: 128_000 } },
        controller: { model: { provider: 'hub', name: 'x' } },
        worker: { model: { provider: 'hub', name: 'y', contextWindowTokens: 8_000 }, maxConcurrency: 1 },
        workers: { cc: { type: 'claude-code', description: 'd', model: { provider: 'hub', name: 'z' } } },
      }),
    );
    expect(config.controller.model).toStrictEqual({ provider: 'hub', name: 'x', contextWindowTokens: 128_000 });
    // An entry's own window is never overridden.
    expect(config.worker.model).toStrictEqual({ provider: 'hub', name: 'y', contextWindowTokens: 8_000 });
    // workers.<id>.model references are rewritten like the two bindings.
    expect(config.workers?.cc.model).toStrictEqual({ provider: 'hub', name: 'z', contextWindowTokens: 128_000 });
  });

  it('drops a window nothing references', () => {
    // The bindings point at ANOTHER provider: nothing inherits hub's window.
    const { config, notes } = normalizeConfig(
      pre88({
        providers: {
          hub: { baseURL: 'https://hub/v3', apiKey: 'k', contextWindowTokens: 128_000 },
          other: { baseURL: 'https://other/v1', apiKey: 'k2' },
        },
        controller: { model: 'other/x' },
        worker: { model: 'other/x', maxConcurrency: 1 },
      }),
    );
    expect(config.providers.hub).toStrictEqual({ baseURL: 'https://hub/v3', apiKey: 'k' });
    expect(notes).toStrictEqual(['providers.hub.contextWindowTokens is deprecated — dropped (no model referenced it)']);
  });
});

describe('normalizeConfig (entry keys and bindings)', () => {
  it('reuses the entry that already is the implicit model — no duplicate', () => {
    const { config } = normalizeConfig(
      pre88({
        providers: { hub: { baseURL: 'https://hub/v3', apiKey: 'k', modelName: 'fast-model' } },
        models: { fast: { provider: 'hub', name: 'fast-model' } },
        controller: { provider: 'hub' },
        worker: { provider: 'hub', maxConcurrency: 1 },
      }),
    );
    expect(config.models).toStrictEqual({ fast: { provider: 'hub', name: 'fast-model' } });
    expect(config.controller).toStrictEqual({ model: 'fast' });
    expect(config.worker.model).toBe('fast');
  });

  it('keeps a same-name entry with a different window apart (the legacy binding resolved the provider window)', () => {
    const { config } = normalizeConfig(
      pre88({
        providers: { hub: { baseURL: 'https://hub/v3', apiKey: 'k', modelName: 'fast-model', contextWindowTokens: 200_000 } },
        models: { fast: { provider: 'hub', name: 'fast-model', contextWindowTokens: 64_000 } },
        controller: { provider: 'hub' },
        worker: { provider: 'hub', maxConcurrency: 1 },
      }),
    );
    expect(config.models).toStrictEqual({
      fast: { provider: 'hub', name: 'fast-model', contextWindowTokens: 64_000 },
      hub: { provider: 'hub', name: 'fast-model', contextWindowTokens: 200_000 },
    });
    expect(config.controller).toStrictEqual({ model: 'hub' });
  });

  it('falls back to -2 when the provider key is taken by another model', () => {
    const { config } = normalizeConfig(
      pre88({
        providers: { hub: { baseURL: 'https://hub/v3', apiKey: 'k', modelName: 'm' } },
        models: { hub: { provider: 'other', name: 'x' } },
        controller: { provider: 'hub' },
        worker: { provider: 'hub', maxConcurrency: 1 },
      }),
    );
    expect(Object.keys(config.models ?? {})).toStrictEqual(['hub', 'hub-2']);
    expect(config.controller).toStrictEqual({ model: 'hub-2' });
  });

  it('leaves the binding empty when the legacy provider declares no modelName (the env fallback was a host concern)', () => {
    const { config, notes } = normalizeConfig(
      pre88({
        providers: { hub: { baseURL: 'https://hub/v3', apiKey: 'k' } },
        controller: { provider: 'hub' },
        worker: { provider: 'hub', maxConcurrency: 1 },
      }),
    );
    expect(config.controller).toStrictEqual({});
    expect(config.worker).toStrictEqual({ maxConcurrency: 1 });
    expect(notes).toStrictEqual([
      'controller.provider = "hub" is deprecated and names no model — the binding is left empty',
      'worker.provider = "hub" is deprecated and names no model — the binding is left empty',
    ]);
  });

  it('a present model reference wins over the legacy provider key', () => {
    const { config } = normalizeConfig(
      pre88({
        providers: { hub: { baseURL: 'https://hub/v3', apiKey: 'k', modelName: 'old' } },
        controller: { provider: 'hub', model: 'hub/direct' },
        worker: { provider: 'hub', maxConcurrency: 1 },
      }),
    );
    expect(config.controller).toStrictEqual({ model: 'hub/direct' });
    expect(config.worker.model).toBe('hub');
  });

  it('rewrites deprecated worker type spellings, merges deniedDirs, drops removed keys', () => {
    const { config, notes } = normalizeConfig(
      pre88({
        ...canonical,
        permission: { sensitiveDirs: ['/a', '/shared'], deniedDirs: ['/shared', '/b'], sensitiveMode: 'deny' },
        workers: { cb: { type: 'codebuddy-acp', description: 'x' } },
        workerRunTimeoutMs: 60_000,
      }),
    );
    expect(config.workers?.cb.type).toBe('codebuddy');
    expect(config.permission).toStrictEqual({ sensitiveDirs: ['/a', '/shared', '/b'], sensitiveMode: 'deny' });
    expect((config as unknown as Record<string, unknown>).workerRunTimeoutMs).toBeUndefined();
    expect(notes).toStrictEqual([
      "worker type 'codebuddy-acp' is deprecated, use 'codebuddy' (workers.cb)",
      'permission.deniedDirs is deprecated — merged into permission.sensitiveDirs',
      'workerRunTimeoutMs is deprecated and ignored — dropped',
    ]);
  });

  it('drops a permission section that the merge leaves empty', () => {
    const { config } = normalizeConfig(pre88({ ...canonical, permission: { deniedDirs: [] } }));
    expect(config.permission).toBeUndefined();
  });
});

describe('normalizeConfig (robustness)', () => {
  it('passes malformed shapes through for validateConfig to report — never throws', () => {
    const malformed = pre88({
      providers: { broken: null },
      controller: null,
      worker: { provider: 'broken', maxConcurrency: 1 },
      models: { bad: 'nope' },
      permission: { deniedDirs: 'not-a-list' },
      workers: { cb: { type: 'codebuddy-acp', description: 'x' } },
    });
    const { config } = normalizeConfig(malformed);
    // The translation only touched what it understands.
    expect(config.workers?.cb.type).toBe('codebuddy');
    expect(config.permission).toStrictEqual({ deniedDirs: 'not-a-list' } as unknown as WayangConfig['permission']);
    // The structural problems are the validator's to report.
    expect(validateConfig(config)).toMatch(/providers\.broken must be an object/);
  });
});
