/**
 * First-boot onboard core checks (desktop-app-design §2.11, 决策九).
 *
 * Pure protocol-level logic shared by the main process (cold-boot decision,
 * save-config validation) and the renderer's onboarding UI (wizard
 * completeness, final-confirm preview). Mirrors core's resolveModelRef
 * reference forms (named entry → composite → inline) with NO env fallback —
 * the desktop's necessary core must be real config entries. The legacy
 * provider-key binding never reaches here: it is translated at the one
 * config entry (the CLI import, via protocol normalizeConfig).
 */

import type { ModelRef, WayangConfig } from '@wayang-ai/protocol';

/** Cold-start decision for the welcome page (§2.11 首启流程). */
export interface OnboardState {
  /** False → the renderer shows the welcome page instead of the main UI. */
  onboarded: boolean;
  /** Why the envelope is unusable: missing, invalid, or core-incomplete. */
  problem?: string;
  /**
   * The config already on disk when it is structurally valid but core-INCOMPLETE
   * — the welcome page offers「修改现有配置」on it instead of making the user
   * start over (and silently dropping everything they had configured).
   */
  config?: WayangConfig;
}

/**
 * Necessary-core completeness (§2.11 必要核心配置 — decides which onboard
 * steps are mandatory):
 * ① at least one provider (type / baseURL / apiKey all present);
 * ② the controller AND worker model bindings resolve to real entries.
 * Everything else (workers rows, maxConcurrency, logging…) is optional.
 */
export function checkCoreCompleteness(config: WayangConfig): string | null {
  const providerKeys = Object.keys(config.providers ?? {});
  if (providerKeys.length === 0) {
    return '必要核心配置缺失：至少需要一个 provider（type / baseURL / apiKey 齐备）';
  }
  for (const key of providerKeys) {
    const provider = config.providers[key];
    if (typeof provider !== 'object' || provider === null) {
      return `providers.${key} 必须是对象`;
    }
    if (provider.type !== undefined && provider.type !== 'openai-compatible') {
      return `providers.${key}.type 必须为 'openai-compatible'`;
    }
    if (!provider.baseURL) {
      return `providers.${key} 缺少 baseURL`;
    }
    if (!provider.apiKey) {
      return `providers.${key} 缺少 apiKey`;
    }
  }
  const controllerProblem = bindingProblem(config, config.controller?.model, 'controller');
  if (controllerProblem) return controllerProblem;
  const workerProblem = bindingProblem(config, config.worker?.model, 'worker');
  if (workerProblem) return workerProblem;
  return null;
}

/** One binding's resolvability, mirroring core's resolveModelRef (no env). */
function bindingProblem(config: WayangConfig, ref: ModelRef | undefined, label: string): string | null {
  if (ref !== undefined) {
    if (typeof ref === 'string') {
      const named = config.models?.[ref];
      if (named) {
        return config.providers?.[named.provider]
          ? null
          : `${label} 指向的 models.${ref} 使用了不存在的 provider "${named.provider}"`;
      }
      const slash = ref.indexOf('/');
      if (slash > 0) {
        const providerKey = ref.slice(0, slash);
        const modelName = ref.slice(slash + 1);
        if (!modelName) return `${label} 的模型引用 "${ref}" 缺少模型名（应为 "provider/model"）`;
        return config.providers?.[providerKey]
          ? null
          : `${label} 的模型引用 "${ref}" 指向不存在的 provider "${providerKey}"`;
      }
      const available = Object.keys(config.models ?? {});
      return `${label} 的模型引用 "${ref}" 不存在（可用模型：${available.length > 0 ? available.join(', ') : '无'}；或使用 "provider/model"）`;
    }
    if (typeof ref !== 'object' || ref === null || Array.isArray(ref)) {
      return `${label} 的模型引用必须是模型名、"provider/model" 或内联模型对象`;
    }
    if (typeof ref.provider !== 'string' || ref.provider.length === 0) {
      return `${label} 的内联模型缺少 provider`;
    }
    if (!config.providers?.[ref.provider]) {
      return `${label} 的内联模型指向不存在的 provider "${ref.provider}"`;
    }
    if (typeof ref.name !== 'string' || ref.name.length === 0) {
      return `${label} 的内联模型缺少模型名`;
    }
    return null;
  }
  return `${label} 未绑定模型（缺少 controller/worker 的 model 绑定）`;
}

/**
 * Resolve the envelope → cold-start decision. A missing file, a load/validate
 * failure, or a core-incomplete-but-valid config all land on the welcome
 * page (§2.11) — never a silent fallback to the CLI file.
 */
export function resolveOnboardState(
  envelope: { wayangConfig: WayangConfig } | null,
  loadError: string | null,
): OnboardState {
  if (loadError) return { onboarded: false, problem: loadError };
  if (!envelope) return { onboarded: false, problem: '尚未配置：config.json 不存在' };
  const problem = checkCoreCompleteness(envelope.wayangConfig);
  // 结构合法只差必要核心：把配置带给欢迎页，供「修改现有配置」接着改。
  if (problem) return { onboarded: false, problem, config: envelope.wayangConfig };
  return { onboarded: true };
}
