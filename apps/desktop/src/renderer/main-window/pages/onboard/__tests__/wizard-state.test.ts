import { describe, it, expect } from 'vitest';
import type { WayangConfig } from '@wayang-ai/protocol';
import { checkCoreCompleteness } from '@/shared/onboard';
import {
  emptyDraft,
  modelRefSites,
  modelRemovalProblem,
  parseDirList,
  providerRemovalProblem,
  removeModel,
  removeProvider,
  renameModel,
  renameProvider,
  renameWorkerEntry,
  setControllerModel,
  setWorkerModel,
  setWorkspacePref,
  upsertModel,
  upsertProvider,
} from '@/renderer/shared/lib/config-draft';
import { WIZARD_STEPS, draftProblem, firstProblemStep, stepProblem } from '../wizard-state';

/**
 * Wizard state machine pin: two steps that mirror the settings page's groups —
 * 「模型」(providers + models) gates on usable provider rows and model rows,
 * 「Agent」gates on the bindings (the puppet defaults are optional).
 * `firstProblemStep` is where the confirm page's「返回修改」lands.
 */

const providerDraft: WayangConfig = upsertProvider(emptyDraft(), 'default', {
  type: 'openai-compatible',
  baseURL: 'https://api.example.com/v1',
  apiKey: 'sk-1',
});

const modelDraft: WayangConfig = upsertModel(providerDraft, 'main', {
  provider: 'default',
  name: 'gpt-x',
  contextWindowTokens: 128000,
});
const boundDraft: WayangConfig = setWorkerModel(setControllerModel(modelDraft, 'main'), 'main');

describe('wizard steps', () => {
  it('is two steps — the settings page groups 模型 and Agent, in that order', () => {
    expect(WIZARD_STEPS.map((s) => s.id)).toEqual(['models', 'agent']);
    expect(WIZARD_STEPS.map((s) => s.title)).toEqual(['模型', 'Agent']);
  });

  it('「模型」 blocks on provider rows first, then on model rows', () => {
    expect(stepProblem(emptyDraft(), 'models')).toMatch(/至少添加一个 provider/);
    expect(stepProblem(upsertProvider(emptyDraft(), 'p', { apiKey: 'k' }), 'models')).toMatch(/Base URL/);
    // provider 齐了但还没有模型：仍然停在这一步。
    expect(stepProblem(providerDraft, 'models')).toMatch(/至少添加一个模型/);
    expect(stepProblem(upsertModel(providerDraft, 'm', { provider: 'ghost', name: 'x' }), 'models')).toMatch(/provider「ghost」不存在/);
    expect(stepProblem(modelDraft, 'models')).toBeNull();
  });

  it('「Agent」 blocks on the bindings only — the puppet defaults are optional', () => {
    expect(stepProblem(modelDraft, 'agent')).toMatch(/controller/);
    expect(stepProblem(boundDraft, 'agent')).toBeNull();
  });

  it('firstProblemStep lands on the step that still needs filling, else on the first step', () => {
    expect(firstProblemStep(emptyDraft())).toBe('models');
    expect(firstProblemStep(providerDraft)).toBe('models');
    expect(firstProblemStep(modelDraft)).toBe('agent');
    expect(firstProblemStep(boundDraft)).toBe('models');
  });

  it('draftProblem mirrors the save path: structure + necessary core', () => {
    expect(draftProblem(boundDraft)).toBeNull();
    expect(draftProblem(modelDraft)).toMatch(/controller/);
    // A structurally invalid row the necessary-core check does not look at.
    const broken = { ...boundDraft, workers: { codex: { type: 'claude-code', description: '' } } } as unknown as WayangConfig;
    expect(draftProblem(broken)).toMatch(/workers\.codex\.description/);
  });
});

describe('config draft helpers', () => {
  it('parseDirList splits, trims and drops empty lines', () => {
    expect(parseDirList('/a\n  /b \n\n/tmp\n')).toEqual(['/a', '/b', '/tmp']);
  });

  it('setWorkspacePref writes and clears the envelope pref slot', () => {
    const withPath = setWorkspacePref({}, '/ws');
    expect(withPath.defaultWorkerWorkspace).toBe('/ws');
    expect(setWorkspacePref(withPath, null).defaultWorkerWorkspace).toBeUndefined();
  });

  it('renameModel keeps every binding pointing at the renamed entry', () => {
    const withRow: WayangConfig = { ...boundDraft, workers: { codex: { type: 'claude-code', description: 'd', model: 'main' } } };
    const renamed = renameModel(withRow, 'main', 'sonnet');
    expect(renamed.models).toEqual({ sonnet: modelDraft.models?.main });
    expect(renamed.controller).toEqual({ model: 'sonnet' });
    expect(renamed.worker.model).toBe('sonnet');
    expect(renamed.workers?.codex.model).toBe('sonnet');
    // Renaming to the same name (or a missing one) changes nothing.
    expect(renameModel(withRow, 'main', 'main')).toBe(withRow);
    expect(renameModel(withRow, 'ghost', 'x')).toBe(withRow);
  });

  it('renameProvider moves the key in place and rewrites its models + the references that go through it', () => {
    const withRow: WayangConfig = {
      ...boundDraft,
      providers: { default: providerDraft.providers.default, other: { type: 'openai-compatible', baseURL: 'https://o.example/v1', apiKey: 'k' } },
      controller: { model: 'default/gpt-x' }, // 组合引用：字面上经过旧 provider
      worker: { ...boundDraft.worker, model: { provider: 'default', name: 'inline-x' } }, // 内联对象
      workers: {
        codex: { type: 'claude-code', description: 'd', model: 'default' }, // 指向 models 条目的字符串引用：不用动
        other: { type: 'claude-code', description: 'd', model: 'other/gpt-x' }, // 别的 provider：不碰
      },
    };
    const renamed = renameProvider(withRow, 'default', 'hub');
    expect(Object.keys(renamed.providers)).toEqual(['hub', 'other']);
    expect(renamed.providers.hub).toBe(withRow.providers.default);
    expect(renamed.models?.main.provider).toBe('hub');
    expect(renamed.controller.model).toBe('hub/gpt-x');
    expect(renamed.worker.model).toEqual({ provider: 'hub', name: 'inline-x' });
    expect(renamed.workers?.codex.model).toBe('default');
    expect(renamed.workers?.other.model).toBe('other/gpt-x');
    // 改成同样的名字（或不存在的 provider）什么都不变。
    expect(renameProvider(withRow, 'default', 'default')).toBe(withRow);
    expect(renameProvider(withRow, 'ghost', 'x')).toBe(withRow);
    expect(checkCoreCompleteness(renamed)).toBeNull();
  });

  it('removeModel clears the bindings that named it — no dangling reference', () => {
    const removed = removeModel(boundDraft, 'main');
    expect(removed.models).toEqual({});
    expect(removed.controller.model).toBeUndefined();
    expect(removed.worker.model).toBeUndefined();
  });

  it('removeProvider takes its models (and their bindings) with it', () => {
    const other = upsertProvider(boundDraft, 'other', { type: 'openai-compatible', baseURL: 'https://o.example/v1', apiKey: 'k' });
    const removed = removeProvider(other, 'default');
    expect(Object.keys(removed.providers)).toEqual(['other']);
    expect(removed.models).toEqual({});
    expect(removed.controller.model).toBeUndefined();
    expect(removed.worker.model).toBeUndefined();
  });

  it('renameWorkerEntry moves the key in place — nothing else in the config references a worker ID', () => {
    const withWorkers: WayangConfig = {
      ...boundDraft,
      workers: {
        a: { type: 'claude-code', description: 'a' },
        b: { type: 'acp', description: 'b', command: 'x' },
        c: { type: 'codebuddy', description: 'c' },
      },
    };
    const renamed = renameWorkerEntry(withWorkers, 'b', 'bee');
    expect(Object.keys(renamed.workers ?? {})).toEqual(['a', 'bee', 'c']);
    expect(renamed.workers?.bee).toBe(withWorkers.workers!.b);
    expect(renamed.workers?.b).toBeUndefined();
    // Same name (or a missing worker) changes nothing.
    expect(renameWorkerEntry(withWorkers, 'b', 'b')).toBe(withWorkers);
    expect(renameWorkerEntry(withWorkers, 'ghost', 'x')).toBe(withWorkers);
  });

  it('modelRefSites / the removal guards name who uses an entry', () => {
    expect(modelRefSites(boundDraft, 'main')).toEqual(['controller', 'worker']);
    expect(modelRemovalProblem(boundDraft, 'main')).toBe('该模型正被 controller、worker 使用，先改绑再删除');
    const withSpare = upsertModel(boundDraft, 'spare', { provider: 'default', name: 'y' });
    expect(modelRemovalProblem(withSpare, 'spare')).toBeNull();

    expect(providerRemovalProblem(withSpare, 'default')).toMatch(/还有模型（main、spare）/);
    // A provider with no models of its own, but a composite binding through it.
    const composite: WayangConfig = { ...providerDraft, controller: { model: 'default/gpt-x' } };
    expect(providerRemovalProblem(composite, 'default')).toBe('controller 的模型引用经过该 provider，先改绑再删除');
    const free = upsertProvider(boundDraft, 'free', { type: 'openai-compatible', baseURL: 'https://f.example/v1', apiKey: 'k' });
    expect(providerRemovalProblem(free, 'free')).toBeNull();
  });

  it('the helpers agree with the necessary-core check after a rename / removal', () => {
    const withRow: WayangConfig = { ...boundDraft, workers: { codex: { type: 'claude-code', description: 'd', model: 'main' } } };
    expect(checkCoreCompleteness(renameModel(withRow, 'main', 'sonnet'))).toBeNull();
    // Deleting the bound model unbinds both sides → the binding step reports it.
    expect(checkCoreCompleteness(removeModel(boundDraft, 'main'))).toMatch(/controller 未绑定模型/);
  });
});
