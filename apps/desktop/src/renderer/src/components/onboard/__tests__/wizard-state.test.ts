import { describe, it, expect } from 'vitest';
import type { WayangConfig } from '@wayang-ai/protocol';
import { checkCoreCompleteness } from '../../../../../shared/onboard';
import { emptyDraft, parseDirList, setControllerModel, setWorkerModel, setWorkspacePref, upsertModel, upsertProvider } from '../../../lib/config-draft';
import { WIZARD_STEPS, canSkip, stepProblem, wizardComplete } from '../wizard-state';

/**
 * Wizard state machine pin (§2.11/§4.3 工作项⑤): necessary steps first and
 * mandatory, optional steps skippable only once the core is complete, and
 * the fallback builder completing both mandatory steps at once.
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

describe('wizard steps (§2.11 必要核心步骤靠前必做)', () => {
  it('orders the two mandatory steps first, then the optional one', () => {
    expect(WIZARD_STEPS.map((s) => s.id)).toEqual(['provider', 'binding', 'concurrency']);
    expect(WIZARD_STEPS.slice(0, 2).every((s) => s.required)).toBe(true);
    expect(WIZARD_STEPS[2].required).toBe(false);
  });

  it('provider step blocks on a missing/empty provider; binding step blocks on unresolved bindings', () => {
    expect(stepProblem(emptyDraft(), 'provider')).toMatch(/至少配置一个 provider/);
    expect(stepProblem(providerDraft, 'provider')).toBeNull();
    expect(stepProblem(providerDraft, 'binding')).toMatch(/controller/);
    expect(stepProblem(boundDraft, 'binding')).toBeNull();
  });

  it('optional steps are skippable only once the core is complete; mandatory ones never', () => {
    expect(canSkip(providerDraft, 'provider')).toBe(false);
    expect(canSkip(providerDraft, 'binding')).toBe(false);
    expect(canSkip(providerDraft, 'concurrency')).toBe(false);
    expect(canSkip(boundDraft, 'concurrency')).toBe(true);
  });

  it('the wizard finishes exactly when the core completeness passes', () => {
    expect(wizardComplete(boundDraft)).toBe(true);
    expect(wizardComplete(providerDraft)).toBe(false);
    expect(checkCoreCompleteness(boundDraft)).toBeNull();
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
});
