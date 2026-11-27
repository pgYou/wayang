/**
 * Onboarding wizard state machine — pure, unit-tested.
 *
 * Steps: the two NECESSARY core steps come first and are mandatory (provider,
 * model bindings); the rest (concurrency) is skippable once the core is
 * complete. From-scratch users get the built-in「创建默认 provider + model」
 * fallback which completes both mandatory steps at once.
 */

import type { WayangConfig } from '@wayang-ai/protocol';
import { buildFallbackConfig, checkCoreCompleteness } from '@/shared/onboard';

export type WizardStepId = 'provider' | 'binding' | 'concurrency';

export interface WizardStep {
  id: WizardStepId;
  title: string;
  /** 必做 steps cannot be skipped; the wizard ends on the confirm page. */
  required: boolean;
}

export const WIZARD_STEPS: readonly WizardStep[] = [
  { id: 'provider', title: 'Provider（必做）', required: true },
  { id: 'binding', title: '模型绑定（必做）', required: true },
  { id: 'concurrency', title: '并发设置（可跳过）', required: false },
];

export function stepIndex(id: WizardStepId): number {
  return WIZARD_STEPS.findIndex((s) => s.id === id);
}

/**
 * Per-step validation: what blocks proceeding. `provider` needs ≥1 usable
 * provider row; `binding` needs the core completeness (both bindings
 * resolvable); `concurrency` only needs a positive integer when filled.
 */
export function stepProblem(config: WayangConfig, step: WizardStepId): string | null {
  if (step === 'provider') {
    const keys = Object.keys(config.providers ?? {});
    if (keys.length === 0) return '至少配置一个 provider（type / baseURL / apiKey）';
    for (const key of keys) {
      const p = config.providers[key];
      if (!p?.baseURL) return `providers.${key} 缺少 baseURL`;
      if (!p?.apiKey) return `providers.${key} 缺少 apiKey`;
    }
    return null;
  }
  if (step === 'binding') return checkCoreCompleteness(config);
  const mc = config.worker?.maxConcurrency;
  if (mc !== undefined && !(Number.isInteger(mc) && mc > 0)) return 'maxConcurrency 必须是正整数';
  return null;
}

/** May the user SKIP this step right now? */
export function canSkip(config: WayangConfig, step: WizardStepId): boolean {
  const meta = WIZARD_STEPS[stepIndex(step)];
  if (meta.required) return false;
  // Optional steps are skippable only once the necessary core is complete.
  return checkCoreCompleteness(config) === null;
}

/** The wizard's finish gate: the core is complete → the confirm page. */
export function wizardComplete(config: WayangConfig): boolean {
  return checkCoreCompleteness(config) === null;
}

export { buildFallbackConfig };
