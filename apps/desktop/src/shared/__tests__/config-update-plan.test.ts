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
      models: { fast: prev.models!.fast }, // `gone` leaves together with its provider `old`
    };
    const plan = planConfigUpdates(prev, next);
    expect(plan.ops.map((op) => `${op.method}:${(op.params as { name?: string }).name ?? ''}`)).toEqual([
      'add_provider:extra',
      'update_provider:main',
      'remove_model:gone',
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
    // 文案说人话（「未声明上下文窗口」），不摆字段名。
    expect(plan.restartRequired.join(' ')).toMatch(/models\.swift（未声明上下文窗口/);
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

  it('fields outside the hot path are reported restart-required, never silently dropped', () => {
    const next: WayangConfig = {
      ...prev,
      worker: { ...prev.worker, maxTurns: 40 },
      tavilyApiKey: 'tvly-x',
      skillsDirs: ['/skills'],
      idleTimeoutMs: 60000,
      signalWindowSize: 500,
    };
    const plan = planConfigUpdates(prev, next);
    expect(plan.ops).toEqual([]);
    const notes = plan.restartRequired.join(' ');
    for (const field of ['worker.maxTurns', 'tavilyApiKey', 'skillsDirs', 'idleTimeoutMs', 'signalWindowSize']) {
      expect(notes, `restartRequired must mention ${field}`).toMatch(new RegExp(field));
    }
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

  it('clearing a binding is restart-required, not a hot op', () => {
    const next: WayangConfig = { ...prev, worker: { maxConcurrency: 2 } };
    const plan = planConfigUpdates(prev, next);
    expect(plan.ops.map((op) => op.method)).toEqual([]);
    expect(plan.restartRequired.join(' ')).toMatch(/worker\.model 被清空/);
  });

  it('renaming a model that has no context window is saved as restart-only, not half-applied', () => {
    const base: WayangConfig = {
      providers: { main: { type: 'openai-compatible', baseURL: 'https://a.example/v1', apiKey: 'sk-1' } },
      models: { bare: { provider: 'main', name: 'm-x' } }, // 未声明上下文窗口（比如从 CLI 配置导入的）
      controller: { model: 'bare' },
      worker: { model: 'bare', maxConcurrency: 2 },
    };
    const renamed: WayangConfig = {
      ...base,
      models: { sonnet: base.models!.bare },
      controller: { model: 'sonnet' },
      worker: { ...base.worker, model: 'sonnet' },
    };
    const plan = planConfigUpdates(base, renamed);
    // 改名 = 新增 sonnet + 改绑 + 删除 bare。新增发不过去（add_model 必须带窗口），
    // 指向它的改绑和对旧条目的删除 server 都会拒——全部留给重启，一条都不发。
    expect(plan.ops).toEqual([]);
    const notes = plan.restartRequired.join(' ');
    expect(notes).toMatch(/models\.sonnet/);
    expect(notes).toMatch(/controller\.model → sonnet/);
    expect(notes).toMatch(/worker\.model → sonnet/);
    expect(notes).toMatch(/models\.bare 的移除/);
  });

  it('binding a new model that did not cross the wire is deferred with it', () => {
    const next: WayangConfig = {
      ...prev,
      models: { ...prev.models!, bare: { provider: 'main', name: 'bare-x' } },
      controller: { model: 'bare' },
      worker: { model: 'bare', maxConcurrency: 5 }, // 并发数照常热更
    };
    const plan = planConfigUpdates(prev, next);
    expect(plan.ops).toEqual([{ method: 'update_worker_settings', params: { patch: { maxConcurrency: 5 } } }]);
    const notes = plan.restartRequired.join(' ');
    expect(notes).toMatch(/models\.bare/);
    expect(notes).toMatch(/controller\.model → bare/);
    expect(notes).toMatch(/worker\.model → bare/);
    expectParses(next);
  });

  it('renaming a model a third-party row points at: the add and the rewrites go hot, the removal waits', () => {
    const base: WayangConfig = {
      providers: { main: { type: 'openai-compatible', baseURL: 'https://a.example/v1', apiKey: 'sk-1' } },
      models: { fast: { provider: 'main', name: 'gpt-x', contextWindowTokens: 128000 } },
      controller: { model: 'fast' },
      worker: { model: 'fast', maxConcurrency: 2 },
      workers: { codex: { type: 'claude-code', description: 'd', model: 'fast' } },
    };
    const renamed: WayangConfig = {
      ...base,
      models: { sonnet: { ...base.models!.fast, name: 'gpt-4.1' } },
      controller: { model: 'sonnet' },
      worker: { ...base.worker, model: 'sonnet' },
      workers: { codex: { ...base.workers!.codex, model: 'sonnet' } },
    };
    const plan = planConfigUpdates(base, renamed);
    // 第三方 worker 行只能重启才更新：server 上 workers.codex 还指着 fast，
    // 所以 remove_model(fast) 不能发（会被拒，而配置文件此时已经写了）。
    expect(plan.ops.map((op) => op.method)).toEqual(['add_model', 'update_controller_model', 'update_worker_settings']);
    expect(plan.restartRequired.join(' ')).toMatch(/models\.fast 的移除（server 上 workers\.codex 还引用着它/);
    expect(plan.restartRequired.join(' ')).toMatch(/workers/);
    expectParses(renamed);
  });

  it('a field cleared on an existing entry is reported for the restart, never sent as an empty patch', () => {
    const base: WayangConfig = {
      providers: { main: { type: 'openai-compatible', baseURL: 'https://a.example/v1', apiKey: 'sk-1' } },
      models: { fast: { provider: 'main', name: 'gpt-x', contextWindowTokens: 128000, temperature: 0.3 } },
      controller: { model: 'fast' },
      worker: { model: 'fast', maxConcurrency: 2 },
    };
    const cleared: WayangConfig = { ...base, models: { fast: { provider: 'main', name: 'gpt-x' } } } satisfies WayangConfig;
    const plan = planConfigUpdates(base, cleared);
    expect(plan.ops).toEqual([]);
    expect(plan.restartRequired.join(' ')).toMatch(/models\.fast\.contextWindowTokens 被清空/);
    expect(plan.restartRequired.join(' ')).toMatch(/models\.fast\.temperature 被清空/);
  });

  it('a provider removal the server would refuse is deferred: the server still sees something going through it', () => {
    const base: WayangConfig = {
      providers: {
        main: { type: 'openai-compatible', baseURL: 'https://a.example/v1', apiKey: 'sk-1' },
        other: { type: 'openai-compatible', baseURL: 'https://o.example/v1', apiKey: 'sk-2' },
      },
      models: {
        fast: { provider: 'main', name: 'gpt-x', contextWindowTokens: 128000 },
        slow: { provider: 'other', name: 'gpt-y', contextWindowTokens: 128000 },
      },
      controller: { model: 'slow' },
      worker: { model: 'slow', maxConcurrency: 2 },
      workers: { codex: { type: 'claude-code', description: 'd', model: 'fast' } },
    };
    // 删掉 main 及其模型，第三方 worker 行改指 slow（这一行在 server 上要重启才更新）。
    const next: WayangConfig = {
      ...base,
      providers: { other: base.providers.other },
      models: { slow: base.models!.slow },
      workers: { codex: { ...base.workers!.codex, model: 'slow' } },
    };
    const plan = planConfigUpdates(base, next);
    expect(plan.ops).toEqual([]);
    const notes = plan.restartRequired.join(' ');
    expect(notes).toMatch(/models\.fast 的移除（server 上 workers\.codex 还引用着它/);
    // 经过 main 的有两处：还留在 server 上的 models.fast，和重启才更新的 workers.codex。
    expect(notes).toMatch(/providers\.main 的移除（server 上 models\.fast、workers\.codex 还经过它/);
  });

  it('a legacy spelling never reaches the planner — both sides are canonical configs', () => {
    // The legacy provider-key binding and the deprecated provider model fields
    // are translated at the config entry (protocol normalizeConfig); the
    // planner has no branch for them, so they diff as nothing at all.
    const legacy = {
      ...prev,
      providers: { ...prev.providers, main: { ...prev.providers.main, modelName: 'gpt-x' } },
      controller: { model: 'fast', provider: 'main' },
    } as unknown as WayangConfig;
    expect(planConfigUpdates(prev, legacy)).toEqual({ ops: [], restartRequired: [] });
    expect(planConfigUpdates(legacy, prev)).toEqual({ ops: [], restartRequired: [] });
  });
});
