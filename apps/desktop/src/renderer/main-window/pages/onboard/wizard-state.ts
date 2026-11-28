/**
 * Onboarding wizard state machine — pure, unit-tested.
 *
 * 两步，和设置页的分组一一对应：「模型」（provider + 模型，同一个分组卡片里
 * 增删）→「Agent」（模型绑定必做；puppet 默认参数与第三方 worker 可选）。每一步
 * 都直接渲染设置页的分组组件，所以从零填写与修改已有配置（导入的、或磁盘上
 * 不完整的）是同一条流程，只是草稿的起点不同。
 */

import { validateConfig, type WayangConfig } from '@wayang-ai/protocol';
import { checkCoreCompleteness } from '@/shared/onboard';

export type WizardStepId = 'models' | 'agent';

export interface WizardStep {
  id: WizardStepId;
  /** 步骤条上的文字——和设置页的分组同名。 */
  title: string;
}

export const WIZARD_STEPS: readonly WizardStep[] = [
  { id: 'models', title: '模型' },
  { id: 'agent', title: 'Agent' },
];

export function stepIndex(id: WizardStepId): number {
  return WIZARD_STEPS.findIndex((s) => s.id === id);
}

/**
 * Per-step validation: what blocks proceeding. `models` needs ≥1 usable provider
 * row and then ≥1 model whose provider exists; `agent` needs the core
 * completeness (both bindings resolvable) — the puppet defaults and the
 * third-party workers are optional and have no gate: the form itself refuses an
 * invalid row, and imported / existing rows were validated when they were loaded.
 */
export function stepProblem(config: WayangConfig, step: WizardStepId): string | null {
  switch (step) {
    case 'models': {
      const providers = Object.entries(config.providers ?? {});
      if (providers.length === 0) return '至少添加一个 provider';
      for (const [key, provider] of providers) {
        if (!provider?.baseURL) return `provider「${key}」缺少 Base URL`;
        if (!provider?.apiKey) return `provider「${key}」缺少 API Key`;
      }
      const models = Object.entries(config.models ?? {});
      if (models.length === 0) return '至少添加一个模型';
      for (const [key, model] of models) {
        if (!config.providers?.[model.provider]) return `模型「${key}」所属的 provider「${model.provider}」不存在`;
      }
      return null;
    }
    case 'agent':
      return checkCoreCompleteness(config);
  }
}

/** 第一个还没填好的步骤（确认页「返回修改」落回这里）；都填好了则从第一步开始。 */
export function firstProblemStep(config: WayangConfig): WizardStepId {
  return WIZARD_STEPS.find((step) => stepProblem(config, step.id) !== null)?.id ?? 'models';
}

/**
 * 确认页的门槛，与保存路径（main 的 saveConfig）同口径：结构合法 + 必要
 * 核心齐备。返回给用户看的问题，null 表示可以写入。
 */
export function draftProblem(config: WayangConfig): string | null {
  try {
    const invalid = validateConfig(config);
    if (invalid) return invalid;
  } catch (err) {
    return `配置结构不合法（${err instanceof Error ? err.message : String(err)}）`;
  }
  return checkCoreCompleteness(config);
}
