import { describe, it, expect } from 'vitest';
import { parseConfigUpdateRequest } from '@wayang-ai/protocol';
import { planConfigUpdates } from '../config-update-plan';

/**
 * The §2.4 field→method mapping (the "mapping lives with the contract"
 * requirement). Every op must be exactly what core's parser accepts — the
 * pin below round-trips each planned op through `parseConfigUpdateRequest`.
 */

import type { WayangConfig } from '@wayang-ai/protocol';

const prev: WayangConfig = {
  providers: {
    main: { type: 'openai-compatible', baseURL: 'https://a.example/v1', apiKey: 'sk-1' },
    old: { type: 'openai-compatible', baseURL: 'https://old.example/v1', apiKey: 'sk-9' },
  },
  models: {
    fast: { provider: 'main', name: 'gpt-x', contextWindowTokens: 128000 },
    gone: { provider: 'old', name: 'm-gone' },
  },
  controller: { model: 'fast' },
  worker: { model: 'fast', maxConcurrency: 2 },
};

/** Every planned op parses through protocol's wire parser (no rejects). */
function expectParses(next: WayangConfig): void {
  const plan = planConfigUpdates(prev, next);
  for (const op of plan.ops) {
    expect(() => parseConfigUpdateRequest(op.method, op.params)).not.toThrow();
  }
}

describe('planConfigUpdates (§2.4 八方法映射)', () => {
  it('identical configs plan nothing', () => {
    expect(planConfigUpdates(prev, prev)).toEqual({ ops: [], restartRequired: [] });
  });

  it('provider changes map to add/update/remove_provider', () => {
    const next: WayangConfig = {
      ...prev,
      providers: {
        main: { ...prev.providers.main, apiKey: 'sk-rotated' },
        extra: { type: 'openai-compatible', baseURL: 'https://e.example/v1', apiKey: 'sk-e' },
      },
    };
    const plan = planConfigUpdates(prev, next);
    expect(plan.ops.map((op) => `${op.method}:${(op.params as { name?: string }).name ?? ''}`)).toEqual([
      'add_provider:extra',
      'update_provider:main',
      'remove_provider:old',
    ]);
    expectParses(next);
    // The wire patch is the whitelist subset only.
    const update = plan.ops.find((op) => op.method === 'update_provider')!;
    expect(update.params).toEqual({ name: 'main', patch: { apiKey: 'sk-rotated' } });
  });

  it('model changes map to add_model/update_model/remove_model; a changed `name` is restart-only', () => {
    const next: WayangConfig = {
      ...prev,
      models: {
        fast: { provider: 'main', name: 'gpt-y', contextWindowTokens: 64000 },
        swift: { provider: 'main', name: 'gpt-swift', contextWindowTokens: 96000 },
      },
    };
    const plan = planConfigUpdates(prev, next);
    expect(plan.ops.map((op) => op.method)).toEqual(['add_model', 'update_model', 'remove_model']);
    const update = plan.ops.find((op) => op.method === 'update_model')!;
    expect(update.params).toEqual({ name: 'fast', patch: { contextWindowTokens: 64000 } });
    // `name` (the model id sent to the provider) is outside update_model's
    // whitelist — reported as restart-required, never silently dropped.
    expect(plan.restartRequired).toContain('models.fast.name（模型名不在 update_model 白名单，需重启生效）');
    expectParses(next);
  });

  it('an added model without contextWindowTokens cannot cross the wire: restart-required', () => {
    const next: WayangConfig = {
      ...prev,
      models: { ...prev.models, swift: { provider: 'main', name: 'gpt-swift' } },
    };
    const plan = planConfigUpdates(prev, next);
    expect(plan.ops.map((op) => op.method)).toEqual([]);
    expect(plan.restartRequired.join(' ')).toMatch(/models\.swift.*contextWindowTokens/);
  });

  it('controller/worker binding changes map to update_controller_model / update_worker_settings', () => {
    const next: WayangConfig = {
      ...prev,
      controller: { model: 'gone' },
      worker: { model: 'gone', maxConcurrency: 8, toolChoice: 'auto' },
    };
    const plan = planConfigUpdates(prev, next);
    expect(plan.ops.map((op) => op.method)).toEqual(['update_controller_model', 'update_worker_settings']);
    expect(plan.ops[0].params).toEqual({ model: 'gone' });
    expect(plan.ops[1].params).toEqual({ patch: { model: 'gone', maxConcurrency: 8, toolChoice: 'auto' } });
    expectParses(next);
  });

  it('sections outside the eight methods are restart-required', () => {
    const next: WayangConfig = {
      ...prev,
      workers: { codex: { type: 'claude-code', description: 'row' } },
      permission: { allowedDirs: ['/tmp'] },
      logging: { maxFiles: 5 },
    };
    const plan = planConfigUpdates(prev, next);
    expect(plan.ops).toEqual([]);
    expect(plan.restartRequired.join(' ')).toMatch(/workers/);
    expect(plan.restartRequired.join(' ')).toMatch(/permission/);
    expect(plan.restartRequired.join(' ')).toMatch(/logging/);
  });

  it('removals are sequenced LAST so unbinding first keeps the plan self-consistent', () => {
    // controller moves off `fast`; `fast` and its provider are then removed.
    const next: WayangConfig = {
      ...prev,
      providers: { old: prev.providers.old },
      models: { gone: prev.models!.gone },
      controller: { model: 'gone' },
      worker: { model: 'gone', maxConcurrency: 2 },
    };
    const plan = planConfigUpdates(prev, next);
    const methods = plan.ops.map((op) => op.method);
    expect(methods).toEqual(['update_controller_model', 'update_worker_settings', 'remove_model', 'remove_provider']);
    expect(methods.indexOf('remove_model')).toBeGreaterThan(methods.indexOf('update_controller_model'));
    expect(methods.indexOf('remove_provider')).toBeGreaterThan(methods.indexOf('remove_model'));
    expectParses(next);
  });

  it('clearing a binding (legacy fallback) is restart-required, not a hot op', () => {
    const next: WayangConfig = { ...prev, worker: { provider: 'main', maxConcurrency: 2 } };
    const plan = planConfigUpdates(prev, next);
    expect(plan.ops.map((op) => op.method)).toEqual([]);
    expect(plan.restartRequired.join(' ')).toMatch(/worker\.model 被清空/);
    expect(plan.restartRequired.join(' ')).toMatch(/worker\.provider/);
  });
});
