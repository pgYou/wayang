// Type- and parser-level tests for the config hot-update contract
// (monorepo-design 4.1 运行时热更). The parser's behaviour must match the
// doc's field whitelists exactly — every method's schema IS its whitelist.

import { describe, it, expect } from 'vitest';
import { parseConfigUpdateRequest, isConfigUpdateMethod, bindingSites, modelRefProvider, modelRefKey, type ConfigUpdateRequest } from '../config-update';
import type { WayangConfig } from '../config';
import { METHOD } from '../../rpc/protocol';
import { RpcError } from '../../rpc/protocol';

// --- Compile-time locks -------------------------------------------------

/**
 * Exhaustiveness lock: a switch over the union must handle all eight
 * members. Adding a method to ConfigUpdateRequest without a case fails
 * `tsc` (not just this runtime test).
 */
function methodName(request: ConfigUpdateRequest): string {
  switch (request.method) {
    case 'update_provider': return 'update_provider';
    case 'update_model': return 'update_model';
    case 'add_provider': return 'add_provider';
    case 'add_model': return 'add_model';
    case 'remove_provider': return 'remove_provider';
    case 'remove_model': return 'remove_model';
    case 'update_controller_model': return 'update_controller_model';
    case 'update_worker_settings': return 'update_worker_settings';
  }
}

type Expect<T extends true> = T;
/** The wire method names are exactly the documented eight, nothing more. */
type _EightMethods = Expect<ConfigUpdateRequest['method'] extends
  | 'update_provider' | 'update_model' | 'add_provider' | 'add_model'
  | 'remove_provider' | 'remove_model' | 'update_controller_model' | 'update_worker_settings'
  ? true : false>;

// --- Fixtures ------------------------------------------------------------

/** One config carrying every reference shape the graph helpers must see. */
function fixtureConfig(): WayangConfig {
  return {
    providers: {
      openai: { type: 'openai-compatible', baseURL: 'http://openai', apiKey: 'k1' },
      other: { type: 'openai-compatible', baseURL: 'http://other', apiKey: 'k2' },
    },
    models: {
      fast: { provider: 'openai', name: 'gpt-4o-mini', contextWindowTokens: 128_000 },
      big: { provider: 'openai', name: 'gpt-4o', contextWindowTokens: 200_000 },
    },
    controller: { model: 'fast' },
    worker: { model: 'big', maxConcurrency: 2 },
    workers: {
      codex: {
        type: 'claude-code',
        description: 'coding worker',
        model: 'openai/o3',
      },
      research: {
        type: 'claude-code',
        description: 'research worker',
        model: { provider: 'other', name: 'inline-model' },
      },
    },
  };
}

// --- METHOD constants -----------------------------------------------------

describe('METHOD constants: the eight hot-update methods', () => {
  it('carries the type-level exhaustiveness lock (runtime mirror)', () => {
    // Same pattern as the AcpProtocolConfig shape lock: the compile-time
    // assertions above fail `tsc` when the union drifts; this mirror keeps
    // the type referenced (and visible in coverage).
    const lock: [_EightMethods] = [true];
    expect(lock).toEqual([true]);
  });

  it('carry the documented method names', () => {
    expect(METHOD.UPDATE_PROVIDER).toBe('update_provider');
    expect(METHOD.UPDATE_MODEL).toBe('update_model');
    expect(METHOD.ADD_PROVIDER).toBe('add_provider');
    expect(METHOD.ADD_MODEL).toBe('add_model');
    expect(METHOD.REMOVE_PROVIDER).toBe('remove_provider');
    expect(METHOD.REMOVE_MODEL).toBe('remove_model');
    expect(METHOD.UPDATE_CONTROLLER_MODEL).toBe('update_controller_model');
    expect(METHOD.UPDATE_WORKER_SETTINGS).toBe('update_worker_settings');
  });

  it('isConfigUpdateMethod accepts exactly the eight names', () => {
    for (const name of [
      'update_provider', 'update_model', 'add_provider', 'add_model',
      'remove_provider', 'remove_model', 'update_controller_model', 'update_worker_settings',
    ]) {
      expect(isConfigUpdateMethod(name)).toBe(true);
    }
    expect(isConfigUpdateMethod('update_config')).toBe(false);
    expect(isConfigUpdateMethod('submit_input')).toBe(false);
    expect(isConfigUpdateMethod('')).toBe(false);
  });
});

// --- Parser: happy shapes -------------------------------------------------

describe('parseConfigUpdateRequest: valid requests parse to the union', () => {
  it('parses all eight documented request shapes', () => {
    const cases: Array<[string, Record<string, unknown>, (req: ConfigUpdateRequest) => void]> = [
      ['update_provider', { name: 'openai', patch: { baseURL: 'http://new' } }, (req) => {
        expect(req).toEqual({ method: 'update_provider', name: 'openai', patch: { baseURL: 'http://new' } });
      }],
      ['update_model', { name: 'fast', patch: { temperature: 0.7, maxOutputTokens: 512 } }, (req) => {
        expect(req.method).toBe('update_model');
        if (req.method === 'update_model') {
          expect(req.name).toBe('fast');
          expect(req.patch.temperature).toBe(0.7);
        }
      }],
      ['add_provider', { name: 'extra', def: { type: 'openai-compatible', baseURL: 'http://extra', apiKey: 'k' } }, (req) => {
        expect(req.method).toBe('add_provider');
        if (req.method === 'add_provider') expect(req.def).toEqual({ type: 'openai-compatible', baseURL: 'http://extra', apiKey: 'k' });
      }],
      ['add_model', { name: 'm2', def: { provider: 'openai', name: 'model-x', contextWindowTokens: 64_000, temperature: 0.2 } }, (req) => {
        expect(req.method).toBe('add_model');
        if (req.method === 'add_model') expect(req.def.name).toBe('model-x');
      }],
      ['remove_provider', { name: 'other' }, (req) => {
        expect(req).toEqual({ method: 'remove_provider', name: 'other' });
      }],
      ['remove_model', { name: 'big' }, (req) => {
        expect(req).toEqual({ method: 'remove_model', name: 'big' });
      }],
      ['update_controller_model', { model: 'big' }, (req) => {
        expect(req).toEqual({ method: 'update_controller_model', model: 'big' });
      }],
      ['update_worker_settings', { patch: { model: 'fast', maxConcurrency: 4, toolChoice: 'auto' } }, (req) => {
        expect(req.method).toBe('update_worker_settings');
        if (req.method === 'update_worker_settings') {
          expect(req.patch.model).toBe('fast');
          expect(req.patch.maxConcurrency).toBe(4);
          expect(req.patch.toolChoice).toBe('auto');
        }
      }],
    ];
    for (const [method, params, check] of cases) {
      const req = parseConfigUpdateRequest(method, params);
      expect(methodName(req)).toBe(method);
      check(req);
    }
  });

  it('accepts the METHOD constants directly as the method argument', () => {
    const req = parseConfigUpdateRequest(METHOD.UPDATE_PROVIDER, { name: 'p', patch: { apiKey: 'k' } });
    expect(req.method).toBe('update_provider');
  });

  it('update_controller_model accepts an inline model object', () => {
    const req = parseConfigUpdateRequest('update_controller_model', { model: { provider: 'other', name: 'x' } });
    expect(req.method).toBe('update_controller_model');
    if (req.method === 'update_controller_model') expect(req.model).toEqual({ provider: 'other', name: 'x' });
  });

  it('update_worker_settings accepts an inline model reference for the worker binding', () => {
    const req = parseConfigUpdateRequest('update_worker_settings', { patch: { model: { provider: 'openai', name: 'y' } } });
    if (req.method !== 'update_worker_settings') throw new Error('unexpected method');
    expect(req.patch.model).toEqual({ provider: 'openai', name: 'y' });
  });
});

// --- Parser: whitelist enforcement ---------------------------------------

describe('parseConfigUpdateRequest: the schema is the field whitelist', () => {
  it.each([
    ['update_provider', { name: 'p', patch: { baseURL: 'http://x', modelName: 'nope' } }],
    ['update_model', { name: 'm', patch: { provider: 'p', tools: true } }],
    ['add_provider', { name: 'p', def: { type: 'openai-compatible', baseURL: 'http://x', apiKey: 'k', endpoint: 'nope' } }],
    ['add_model', { name: 'm', def: { provider: 'p', name: 'x', contextWindowTokens: 1, workers: 2 } }],
    ['update_worker_settings', { patch: { maxConcurrency: 2, idleTimeoutMs: 1000 } }],
  ])('%s rejects a non-whitelisted patch field', (method, params) => {
    expect(() => parseConfigUpdateRequest(method, params)).toThrow(RpcError);
    expect(() => parseConfigUpdateRequest(method, params)).toThrow(/field whitelist/);
  });

  it('rejects a wrong primitive shape inside a whitelisted field', () => {
    expect(() => parseConfigUpdateRequest('update_provider', { name: 'p', patch: { baseURL: 42 } })).toThrow(/baseURL/);
    expect(() => parseConfigUpdateRequest('update_model', { name: 'm', patch: { contextWindowTokens: 'big' } })).toThrow(/contextWindowTokens/);
    expect(() => parseConfigUpdateRequest('update_worker_settings', { patch: { maxConcurrency: 0 } })).toThrow(/maxConcurrency/);
    expect(() => parseConfigUpdateRequest('update_worker_settings', { patch: { toolChoice: 'maybe' } })).toThrow(/toolChoice/);
    expect(() => parseConfigUpdateRequest('add_provider', { name: 'p', def: { type: 'anthropic', baseURL: 'http://x', apiKey: 'k' } })).toThrow(/type/);
  });

  it('rejects missing required fields per method', () => {
    expect(() => parseConfigUpdateRequest('update_provider', { patch: { apiKey: 'k' } })).toThrow(/name/);
    expect(() => parseConfigUpdateRequest('update_provider', { name: 'p' })).toThrow(/patch/);
    expect(() => parseConfigUpdateRequest('add_provider', { name: 'p', def: { type: 'openai-compatible', baseURL: 'http://x' } })).toThrow(/apiKey/);
    expect(() => parseConfigUpdateRequest('add_model', { name: 'm', def: { provider: 'p', name: 'x' } })).toThrow(/contextWindowTokens/);
    expect(() => parseConfigUpdateRequest('remove_provider', {})).toThrow(/name/);
    expect(() => parseConfigUpdateRequest('update_controller_model', {})).toThrow(/model/);
    expect(() => parseConfigUpdateRequest('update_worker_settings', { patch: {} })).toThrow(/at least one field/);
    expect(() => parseConfigUpdateRequest('update_provider', { name: 'p', patch: {} })).toThrow(/at least one field/);
  });

  it('rejects a non-config-update method outright', () => {
    expect(() => parseConfigUpdateRequest('submit_input', { text: 'x' })).toThrow(/not a config-update method/);
  });
});

// --- Reference-graph helpers ----------------------------------------------

describe('reference-graph helpers (pure, host-previewable)', () => {
  it('bindingSites lists controller, worker and every workers.<id> row', () => {
    const sites = bindingSites(fixtureConfig());
    expect(sites.map((s) => s.site)).toEqual([
      'controller.model',
      'worker.model',
      'workers.codex.model',
      'workers.research.model',
    ]);
    expect(sites[0]).toMatchObject({ kind: 'controller', ref: 'fast' });
    expect(sites[1]).toMatchObject({ kind: 'worker', ref: 'big' });
    expect(sites[2]).toMatchObject({ kind: 'workerRow', workerId: 'codex', ref: 'openai/o3' });
  });

  it('modelRefProvider resolves through models entries, composites, inline entries and legacy keys', () => {
    const config = fixtureConfig();
    // Key ref: through the entry's provider.
    expect(modelRefProvider(config, 'fast')).toBe('openai');
    // Composite: the prefix before the first '/'.
    expect(modelRefProvider(config, 'other/inline-model')).toBe('other');
    // Inline entry: its own provider field.
    expect(modelRefProvider(config, { provider: 'other', name: 'x' })).toBe('other');
    // No ref: the legacy provider key, when given.
    expect(modelRefProvider(config, undefined, 'openai')).toBe('openai');
    expect(modelRefProvider(config, undefined)).toBeNull();
    // A ref wins over a legacy key — resolution order preserved.
    expect(modelRefProvider(config, 'fast', 'other')).toBe('openai');
  });

  it('modelRefKey names the models entry a string ref addresses (null for composite/inline)', () => {
    expect(modelRefKey('fast')).toBe('fast');
    expect(modelRefKey('openai/o3')).toBeNull();
    expect(modelRefKey(undefined)).toBeNull();
    expect(modelRefKey({ provider: 'openai', name: 'x' })).toBeNull();
  });
});
