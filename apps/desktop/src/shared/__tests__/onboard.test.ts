import { describe, it, expect } from 'vitest';
import type { WayangConfig } from '@wayang-ai/protocol';
import { checkCoreCompleteness, resolveOnboardState } from '../onboard';

/**
 * Necessary-core checks (§2.11 决策九): these decide the welcome-page trigger
 * AND which wizard steps are mandatory. Pure protocol-level — no core import
 * (shared layer boundary), semantics mirror core's resolveModelRef 1–2.
 */

const base: WayangConfig = {
  providers: {
    main: { type: 'openai-compatible', baseURL: 'https://api.example.com/v1', apiKey: 'sk-1' },
  },
  models: {
    fast: { provider: 'main', name: 'gpt-x' },
  },
  controller: { model: 'fast' },
  worker: { model: 'fast', maxConcurrency: 2 },
};

describe('checkCoreCompleteness (必要核心配置)', () => {
  it('accepts a minimal complete config', () => {
    expect(checkCoreCompleteness(base)).toBeNull();
  });

  it('rejects: no providers at all', () => {
    const problem = checkCoreCompleteness({ ...base, providers: {} });
    expect(problem).toMatch(/至少需要一个 provider/);
  });

  it('rejects: provider missing baseURL or apiKey', () => {
    const noKey: WayangConfig = { ...base, providers: { main: { ...base.providers.main, apiKey: '' } } };
    expect(checkCoreCompleteness(noKey)).toMatch(/apiKey/);
    const noUrl: WayangConfig = { ...base, providers: { main: { ...base.providers.main, baseURL: '' } } };
    expect(checkCoreCompleteness(noUrl)).toMatch(/baseURL/);
  });

  it('rejects: controller/worker bindings pointing at nothing', () => {
    expect(checkCoreCompleteness({ ...base, controller: { model: 'missing' } })).toMatch(/controller 的模型引用 "missing" 不存在/);
    expect(checkCoreCompleteness({ ...base, controller: {} })).toMatch(/controller 未绑定模型/);
    expect(checkCoreCompleteness({ ...base, worker: { ...base.worker, model: undefined } })).toMatch(/worker 未绑定模型/);
  });

  it('resolves composite and inline bindings like core does', () => {
    // "provider/model" composite.
    expect(checkCoreCompleteness({ ...base, controller: { model: 'main/gpt-x' } })).toBeNull();
    expect(checkCoreCompleteness({ ...base, controller: { model: 'ghost/gpt-x' } })).toMatch(/不存在的 provider "ghost"/);
    // Inline object: provider must exist, name non-empty.
    expect(checkCoreCompleteness({ ...base, controller: { model: { provider: 'main', name: 'gpt-x' } } })).toBeNull();
    expect(checkCoreCompleteness({ ...base, controller: { model: { provider: 'main' } as unknown as WayangConfig['controller']['model'] } })).toMatch(/缺少模型名/);
    // Named entry whose provider key is dangling.
    const dangling: WayangConfig = { ...base, models: { fast: { provider: 'ghost', name: 'x' } } };
    expect(checkCoreCompleteness(dangling)).toMatch(/不存在的 provider "ghost"/);
  });

  it('rejects the legacy provider-key binding: the desktop only knows `model` references', () => {
    // The legacy spelling is translated at the one config entry (the CLI
    // import, protocol normalizeConfig) — it must never count as a binding here.
    const legacy = {
      providers: { main: { baseURL: 'https://api.example.com/v1', apiKey: 'sk-1', modelName: 'gpt-x' } },
      controller: { provider: 'main' },
      worker: { provider: 'main', maxConcurrency: 2 },
    } as unknown as WayangConfig;
    expect(checkCoreCompleteness(legacy)).toMatch(/controller 未绑定模型/);
    expect(checkCoreCompleteness({ ...legacy, controller: { model: 'main/gpt-x' } })).toMatch(/worker 未绑定模型/);
  });
});

describe('resolveOnboardState (cold-boot decision)', () => {
  it('missing envelope / load error / core-incomplete → welcome page', () => {
    expect(resolveOnboardState(null, null)).toEqual({ onboarded: false, problem: '尚未配置：config.json 不存在' });
    expect(resolveOnboardState(null, 'config file is not valid JSON: x')).toMatchObject({
      onboarded: false,
      problem: 'config file is not valid JSON: x',
    });
    const incomplete = { ...base, controller: {} };
    expect(resolveOnboardState({ wayangConfig: incomplete }, null)).toMatchObject({ onboarded: false });
  });

  it('a core-incomplete (but valid) envelope is handed to the welcome page for「修改现有配置」', () => {
    const incomplete = { ...base, controller: {} };
    // 结构合法只差必要核心：配置本身带过去，欢迎页得以它为草稿进向导。
    expect(resolveOnboardState({ wayangConfig: incomplete }, null)).toEqual({
      onboarded: false,
      problem: expect.stringContaining('controller'),
      config: incomplete,
    });
    // The other two welcome-page causes carry NO config (nothing editable).
    expect(resolveOnboardState(null, null).config).toBeUndefined();
    expect(resolveOnboardState(null, 'config file is not valid JSON: x').config).toBeUndefined();
  });

  it('a complete envelope is onboarded', () => {
    expect(resolveOnboardState({ wayangConfig: base }, null)).toEqual({ onboarded: true });
  });
});
