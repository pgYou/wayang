// Direct unit tests for ConfigUpdateService (monorepo-design 4.1 运行时热更)
// — the semantics behind the eight RPC methods: declared-value in-place
// mutation, validate-on-clone, strict duplicate rejection, reference-list
// removal rejection, and reference-graph-derived impact lists.

import { describe, it, expect } from 'vitest';
import { ConfigUpdateService, removeProviderBlockers, removeModelBlockers, applyConfigUpdate } from '@/services/config/config-update';
import { parseConfigUpdateRequest, type WayangConfig } from '@wayang-ai/protocol';
import { RpcError, RPC_ERROR } from '@wayang-ai/protocol/rpc/protocol';

/**
 * One config exercising every reference shape:
 * - models.fast / models.big sit on provider `main`;
 * - controller.model names models.fast (key ref — the entry is the blocker);
 * - worker.model is a `main/gpt` composite (direct provider ref);
 * - workers.codex.model is an inline entry on `main`;
 * - workers.research.model is an inline entry on `other`.
 */
function makeConfig(): WayangConfig {
  return {
    providers: {
      main: { type: 'openai-compatible', baseURL: 'http://main', apiKey: 'k1' },
      other: { type: 'openai-compatible', baseURL: 'http://other', apiKey: 'k2' },
    },
    models: {
      fast: { provider: 'main', name: 'gpt-mini', contextWindowTokens: 128_000 },
      big: { provider: 'main', name: 'gpt-big', contextWindowTokens: 200_000 },
    },
    controller: { model: 'fast' },
    worker: { model: 'main/gpt', maxConcurrency: 1 },
    workers: {
      codex: { type: 'claude-code', description: 'coding', model: { provider: 'main', name: 'codex-model' } },
      research: { type: 'claude-code', description: 'research', model: { provider: 'other', name: 'research-model' } },
    },
  };
}

/** Expect a structured rejection and return its payload. */
function rejectionOf(fn: () => unknown): { reason: string; detail: string; blockers: Array<{ site: string; kind: string }> } {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(RpcError);
    const rpcErr = err as RpcError;
    expect(rpcErr.code).toBe(RPC_ERROR.INVALID_PARAMS);
    return rpcErr.data as { reason: string; detail: string; blockers: Array<{ site: string; kind: string }> };
  }
  throw new Error('expected the call to reject');
}

describe('ConfigUpdateService: updateProvider', () => {
  it('mutates the declared value in place — object identity preserved, no downstream rewrite', () => {
    const config = makeConfig();
    const service = new ConfigUpdateService(config);
    const providersRef = config.providers;

    const result = service.updateProvider('main', { baseURL: 'http://new-main' });

    // In place: the SAME config object and the SAME providers record carry
    // the new value — consumers reading ctx.config see it at their boundary.
    expect(config.providers).toBe(providersRef);
    expect(config.providers.main.baseURL).toBe('http://new-main');
    // No cascade: models entries and bindings are untouched copies-by-reference.
    expect(config.models!.fast.provider).toBe('main');
    expect(config.controller.model).toBe('fast');
    // Impact list: the bindings that resolve through `main` (worker composite
    // + codex inline), each with its effect boundary. controller.model goes
    // through models.fast, so it is affected as well — the graph is derived
    // from the BINDING's resolution, not the entry it names.
    expect(result.affected).toEqual([
      { kind: 'controller', via: 'fast', effective: 'next-turn' },
      { kind: 'worker', via: 'main/gpt', effective: 'next-spawn' },
      { kind: 'workerRow', workerId: 'codex', via: 'inline', effective: 'next-spawn' },
    ]);
  });

  it('rejects an unknown provider and leaves the config untouched', () => {
    const config = makeConfig();
    const service = new ConfigUpdateService(config);
    const payload = rejectionOf(() => service.updateProvider('nope', { baseURL: 'http://x' }));
    expect(payload.reason).toBe('not-found');
    expect(config.providers.main.baseURL).toBe('http://main');
  });

  it('validates the patch through the shared protocol validator — invalid values reject without partial writes', () => {
    const config = makeConfig();
    const service = new ConfigUpdateService(config);
    const payload = rejectionOf(() => service.updateProvider('main', { apiKey: '' }));
    expect(payload.reason).toBe('invalid');
    expect(payload.detail).toContain('apiKey');
    // apiKey is required non-empty by validateConfig → the live config must
    // still carry the old value.
    expect(config.providers.main.apiKey).toBe('k1');
  });
});

describe('ConfigUpdateService: updateModel', () => {
  it('patches only whitelisted fields and returns the key-bound bindings', () => {
    const config = makeConfig();
    const service = new ConfigUpdateService(config);

    const result = service.updateModel('fast', { temperature: 0.3, maxOutputTokens: 512 });

    expect(config.models!.fast.temperature).toBe(0.3);
    expect(config.models!.fast.maxOutputTokens).toBe(512);
    expect(config.models!.fast.contextWindowTokens).toBe(128_000); // untouched
    // Only controller.model names the key 'fast' (worker.model is a composite).
    expect(result.affected).toEqual([{ kind: 'controller', via: 'fast', effective: 'next-turn' }]);
  });

  it('rejects a provider retarget to an unknown provider (validator, no partial write)', () => {
    const config = makeConfig();
    const service = new ConfigUpdateService(config);
    const payload = rejectionOf(() => service.updateModel('fast', { provider: 'ghost' }));
    expect(payload.reason).toBe('invalid');
    expect(payload.detail).toContain('models.fast.provider');
    expect(config.models!.fast.provider).toBe('main');
  });

  it('rejects an unknown model key', () => {
    const service = new ConfigUpdateService(makeConfig());
    expect(rejectionOf(() => service.updateModel('ghost', { temperature: 1 })).reason).toBe('not-found');
  });
});

describe('ConfigUpdateService: addProvider / addModel — strict duplicates', () => {
  it('addProvider inserts a validated entry with an empty impact list', () => {
    const config = makeConfig();
    const service = new ConfigUpdateService(config);

    const result = service.addProvider('extra', { type: 'openai-compatible', baseURL: 'http://extra', apiKey: 'kx' });

    expect(config.providers.extra).toEqual({ type: 'openai-compatible', baseURL: 'http://extra', apiKey: 'kx' });
    expect(result.affected).toEqual([]); // nothing references a brand-new entry
  });

  it('addProvider strictly rejects an existing name — no overwrite', () => {
    const config = makeConfig();
    const service = new ConfigUpdateService(config);
    const payload = rejectionOf(() => service.addProvider('main', { type: 'openai-compatible', baseURL: 'http://x', apiKey: 'k' }));
    expect(payload.reason).toBe('duplicate');
    expect(config.providers.main.baseURL).toBe('http://main'); // unchanged
  });

  it('addModel registers the entry; nothing references it yet', () => {
    const config = makeConfig();
    const service = new ConfigUpdateService(config);

    const result = service.addModel('m2', { provider: 'other', name: 'model-2', contextWindowTokens: 64_000 });

    expect(config.models!.m2).toEqual({ provider: 'other', name: 'model-2', contextWindowTokens: 64_000 });
    expect(result.affected).toEqual([]);
  });

  it('addModel strictly rejects an existing key', () => {
    const config = makeConfig();
    const service = new ConfigUpdateService(config);
    expect(rejectionOf(() => service.addModel('fast', { provider: 'main', name: 'x', contextWindowTokens: 1 })).reason).toBe('duplicate');
    expect(config.models!.fast.name).toBe('gpt-mini');
  });

  it('addModel rejects a definition whose provider does not exist (validator)', () => {
    const config = makeConfig();
    const service = new ConfigUpdateService(config);
    const payload = rejectionOf(() => service.addModel('m2', { provider: 'ghost', name: 'x', contextWindowTokens: 64_000 }));
    expect(payload.reason).toBe('invalid');
    expect(config.models!.m2).toBeUndefined();
  });
});

describe('ConfigUpdateService: removals — reference integrity, no cascade, no force', () => {
  it('removeProvider is refused with the reference list while models/bindings point at it', () => {
    const config = makeConfig();
    const service = new ConfigUpdateService(config);

    const payload = rejectionOf(() => service.removeProvider('main'));

    expect(payload.reason).toBe('referenced');
    // models.fast + models.big name the provider; worker.model (composite
    // main/gpt) and workers.codex.model (inline on main) reference it
    // directly; controller.model goes through models.fast, so the ENTRY is
    // its blocker, not the binding.
    expect(payload.blockers).toEqual([
      { site: 'models.fast', kind: 'models' },
      { site: 'models.big', kind: 'models' },
      { site: 'worker.model', kind: 'binding' },
      { site: 'workers.codex.model', kind: 'binding' },
    ]);
    // No mutation on refusal.
    expect(config.providers.main).toBeDefined();
    expect(config.models!.fast.provider).toBe('main');
  });

  it('removeProvider succeeds once nothing references it, and the removal is real', () => {
    const config = makeConfig();
    delete config.workers!.research; // the research row was the only reference to 'other'
    const service = new ConfigUpdateService(config);

    const result = service.removeProvider('other');

    expect(result.affected).toEqual([]); // nothing referenced it — that is why it could go
    expect(config.providers.other).toBeUndefined();
    // The removal is real: re-adding the same name succeeds afterwards.
    expect(() => service.addProvider('other', { type: 'openai-compatible', baseURL: 'http://other2', apiKey: 'k' })).not.toThrow();
    expect(config.providers.other.baseURL).toBe('http://other2');
  });

  it('removeModel is refused with the binding list while a binding names the key', () => {
    const config = makeConfig();
    const service = new ConfigUpdateService(config);

    const payload = rejectionOf(() => service.removeModel('fast'));

    expect(payload.reason).toBe('referenced');
    expect(payload.blockers).toEqual([{ site: 'controller.model', kind: 'binding' }]);
    expect(config.models!.fast).toBeDefined();
  });

  it('removeModel succeeds once unbound; a second removal is not-found', () => {
    const config = makeConfig();
    config.controller.model = 'big'; // unbind from 'fast'
    const service = new ConfigUpdateService(config);

    const result = service.removeModel('fast');
    expect(result.affected).toEqual([]);
    expect(config.models!.fast).toBeUndefined();

    expect(rejectionOf(() => service.removeModel('fast')).reason).toBe('not-found');
  });
});

describe('ConfigUpdateService: updateControllerModel / updateWorkerSettings', () => {
  it('updateControllerModel rebinds the controller binding with a next-turn impact', () => {
    const config = makeConfig();
    const service = new ConfigUpdateService(config);

    const result = service.updateControllerModel('big');

    expect(config.controller.model).toBe('big');
    expect(result.affected).toEqual([{ kind: 'controller', via: 'big', effective: 'next-turn' }]);
  });

  it('updateControllerModel rejects an unknown model key through the validator', () => {
    const config = makeConfig();
    const service = new ConfigUpdateService(config);
    const payload = rejectionOf(() => service.updateControllerModel('ghost'));
    expect(payload.reason).toBe('invalid');
    expect(payload.detail).toContain('controller.model');
    expect(config.controller.model).toBe('fast');
  });

  it('updateWorkerSettings patches model/maxConcurrency/toolChoice lazily-consumed values', () => {
    const config = makeConfig();
    const service = new ConfigUpdateService(config);

    const result = service.updateWorkerSettings({ model: 'fast', maxConcurrency: 3, toolChoice: 'auto' });

    expect(config.worker.model).toBe('fast');
    expect(config.worker.maxConcurrency).toBe(3);
    expect(config.worker.toolChoice).toBe('auto');
    expect(result.affected).toEqual([{ kind: 'worker', via: 'fast', effective: 'next-spawn' }]);
  });

  it('updateWorkerSettings rejects an unknown worker model ref (validator, no partial write)', () => {
    const config = makeConfig();
    const service = new ConfigUpdateService(config);
    const payload = rejectionOf(() => service.updateWorkerSettings({ model: 'ghost' }));
    expect(payload.reason).toBe('invalid');
    expect(config.worker.model).toBe('main/gpt');
    expect(config.worker.maxConcurrency).toBe(1);
  });
});

describe('applyConfigUpdate dispatch + parser integration', () => {
  it('routes a parsed wire request to the right service method', () => {
    const config = makeConfig();
    const service = new ConfigUpdateService(config);
    const request = parseConfigUpdateRequest('update_provider', { name: 'main', patch: { apiKey: 'new-key' } });

    const result = applyConfigUpdate(service, request);

    expect(config.providers.main.apiKey).toBe('new-key');
    expect(result.affected.length).toBe(3);
  });
});

describe('blocker derivation helpers (exported for hosts/tests)', () => {
  it('removeProviderBlockers distinguishes entry references from direct binding references', () => {
    expect(removeProviderBlockers(makeConfig(), 'main').map((b) => b.site)).toEqual([
      'models.fast', 'models.big', 'worker.model', 'workers.codex.model',
    ]);
    expect(removeProviderBlockers(makeConfig(), 'other').map((b) => b.site)).toEqual(['workers.research.model']);
  });

  it('removeModelBlockers lists only bindings that NAME the key', () => {
    expect(removeModelBlockers(makeConfig(), 'fast').map((b) => b.site)).toEqual(['controller.model']);
    expect(removeModelBlockers(makeConfig(), 'big')).toEqual([]);
  });
});
