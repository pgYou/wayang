/**
 * Onboarding wizard state machine — pure, unit-tested.
 *
 * 按步骤引导：Provider → 模型 → 模型绑定 三步是必要核心配置（必做），Worker
 * 一步可选。每一步都列出草稿里已有的条目（可编辑 / 删除）并用原子设置组件
 * 新增，所以从零填写与修改已有配置（导入的、或磁盘上不完整的）是同一条
 * 流程，只是草稿的起点不同。
 */

import { validateConfig, type WayangConfig } from '@wayang-ai/protocol';
import { checkCoreCompleteness } from '@/shared/onboard';

export type WizardStepId = 'provider' | 'model' | 'binding' | 'worker';

export interface WizardStep {
  id: WizardStepId;
  title: string;
  /** 这一步在做什么、为什么需要——显示在步骤内容上方。 */
  description: string;
  /** 必做 steps cannot be skipped; the wizard ends on the confirm page. */
  required: boolean;
}

export const WIZARD_STEPS: readonly WizardStep[] = [
  {
    id: 'provider',
    title: 'Provider',
    description: '填一个 OpenAI 兼容服务的 Base URL 和 API Key——wayang 通过它连到模型服务。',
    required: true,
  },
  {
    id: 'model',
    title: '模型',
    description: '登记这个 provider 上可用的模型。第一个添加的模型会同时成为 controller 和 worker 的默认模型，下一步可以再调整。',
    required: true,
  },
  {
    id: 'binding',
    title: '模型绑定',
    description: 'controller 负责理解意图、拆解任务、调度 worker；worker 负责执行。为它们各选一个模型。',
    required: true,
  },
  {
    id: 'worker',
    title: 'Worker',
    description: '可选：puppet worker 的默认参数，以及第三方 worker（如 Claude Code）。之后都能在设置页修改。',
    required: false,
  },
];

export function stepIndex(id: WizardStepId): number {
  return WIZARD_STEPS.findIndex((s) => s.id === id);
}

/**
 * Per-step validation: what blocks proceeding. `provider` needs ≥1 usable
 * provider row; `model` needs ≥1 model whose provider exists; `binding` needs
 * the core completeness (both bindings resolvable). `worker` is optional and
 * has no gate: the form itself refuses an invalid row, and imported / existing
 * rows were validated when they were loaded.
 */
export function stepProblem(config: WayangConfig, step: WizardStepId): string | null {
  switch (step) {
    case 'provider': {
      const keys = Object.keys(config.providers ?? {});
      if (keys.length === 0) return '至少添加一个 provider';
      for (const key of keys) {
        const provider = config.providers[key];
        if (!provider?.baseURL) return `provider「${key}」缺少 Base URL`;
        if (!provider?.apiKey) return `provider「${key}」缺少 API Key`;
      }
      return null;
    }
    case 'model': {
      const models = Object.entries(config.models ?? {});
      if (models.length === 0) return '至少添加一个模型';
      for (const [key, model] of models) {
        if (!config.providers?.[model.provider]) return `模型「${key}」所属的 provider「${model.provider}」不存在`;
      }
      return null;
    }
    case 'binding':
      return checkCoreCompleteness(config);
    case 'worker':
      return null;
  }
}

/** 第一个还没填好的步骤（确认页「返回修改」落回这里）；都填好了则从第一步开始。 */
export function firstProblemStep(config: WayangConfig): WizardStepId {
  return WIZARD_STEPS.find((step) => step.required && stepProblem(config, step.id) !== null)?.id ?? 'provider';
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
