/**
 * Config hot-update planner (desktop-app-design §2.4 / 4.3 工作项②).
 *
 * Pure diff prev → next over protocol's `WayangConfig`, mapped onto the EIGHT
 * fine-grained update methods (updateProvider / updateModel / addProvider /
 * addModel / removeProvider / removeModel / updateControllerModel /
 * updateWorkerSettings). This module is the mapping the design doc wants in
 * the contract's orbit: every op carries exactly the wire params core's
 * `parseConfigUpdateRequest` accepts, so the main side can pre-validate with
 * the protocol parser before touching the running server.
 *
 * Fields outside the eight methods' whitelists (third-party `workers` rows,
 * `permission`, `logging`, a provider's deprecated request-param fields, a
 * model entry's `name`, the legacy `controller.provider` / `worker.provider`
 * binding) are reported as restart-required — the envelope is written, the
 * running server picks them up on the next boot.
 */

import type { WayangConfig } from '@wayang-ai/protocol';

/**
 * One hot-update op. `method`/`params` mirror the RPC wire shape core's
 * `parseConfigUpdateRequest` parses (e.g. update_provider → `{ name, patch }`).
 */
export interface ConfigUpdateOp {
  method:
    | 'update_provider'
    | 'update_model'
    | 'add_provider'
    | 'add_model'
    | 'remove_provider'
    | 'remove_model'
    | 'update_controller_model'
    | 'update_worker_settings';
  /** Wire params — exactly what the RPC layer takes. */
  params: Record<string, unknown>;
}

/** The diff plan: hot ops (applied in order) + restart-required notes. */
export interface ConfigUpdatePlan {
  ops: ConfigUpdateOp[];
  /** Human-readable notes for fields that only take effect after a restart. */
  restartRequired: string[];
}

/** Field whitelist of `update_provider` (protocol's ProviderPatch). */
const PROVIDER_PATCH_KEYS = ['baseURL', 'apiKey', 'type'] as const;
/** Field whitelist of `update_model` (protocol's ModelPatch). */
const MODEL_PATCH_KEYS = ['provider', 'contextWindowTokens', 'temperature', 'maxOutputTokens'] as const;
/** Provider keys whose changes update_provider cannot express (deprecated). */
const PROVIDER_RESTART_KEYS = ['contextWindowTokens', 'temperature', 'maxOutputTokens', 'modelName', 'endpoint'] as const;

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function patchOf<T extends object>(prev: T, next: T, keys: readonly (keyof T & string)[]): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of keys) {
    if (!sameJson(prev[key], next[key])) patch[key] = next[key];
  }
  return patch;
}

/**
 * Diff two configs into the op plan. `prev` is what the RUNNING server holds
 * (the last envelope), `next` the freshly validated candidate.
 *
 * Op order: adds (providers → models) → updates (providers → models) →
 * binding rewrites → removals (models BEFORE providers, so a plan that
 * deletes a provider plus its models unbinds/repoints references before the
 * server's reference check runs on each removal).
 */
export function planConfigUpdates(prev: WayangConfig, next: WayangConfig): ConfigUpdatePlan {
  const addProviderOps: ConfigUpdateOp[] = [];
  const addModelOps: ConfigUpdateOp[] = [];
  const updateProviderOps: ConfigUpdateOp[] = [];
  const updateModelOps: ConfigUpdateOp[] = [];
  const bindingOps: ConfigUpdateOp[] = [];
  const removeModelOps: ConfigUpdateOp[] = [];
  const removeProviderOps: ConfigUpdateOp[] = [];
  const restartRequired: string[] = [];

  /* --- providers: adds, updates, removals --- */
  const prevProviders = prev.providers ?? {};
  const nextProviders = next.providers ?? {};
  for (const [name, def] of Object.entries(nextProviders)) {
    if (prevProviders[name]) continue;
    addProviderOps.push({ method: 'add_provider', params: { name, def } });
  }
  for (const name of Object.keys(prevProviders)) {
    if (nextProviders[name]) continue;
    removeProviderOps.push({ method: 'remove_provider', params: { name } });
  }
  for (const [name, def] of Object.entries(nextProviders)) {
    const before = prevProviders[name];
    if (!before) continue;
    const patch = patchOf(before, def, PROVIDER_PATCH_KEYS);
    if (Object.keys(patch).length > 0) updateProviderOps.push({ method: 'update_provider', params: { name, patch } });
    for (const key of PROVIDER_RESTART_KEYS) {
      if (!sameJson((before as unknown as Record<string, unknown>)[key], (def as unknown as Record<string, unknown>)[key])) {
        restartRequired.push(`providers.${name}.${key}（废弃字段，需重启生效）`);
      }
    }
  }

  /* --- models: adds (wire-required fields only), updates, removals --- */
  const prevModels = prev.models ?? {};
  const nextModels = next.models ?? {};
  for (const [key, def] of Object.entries(nextModels)) {
    if (prevModels[key]) continue;
    // add_model's wire schema REQUIRES contextWindowTokens; an entry without
    // it cannot cross the hot path — restart territory, never invented values.
    if (def.contextWindowTokens === undefined) {
      restartRequired.push(`models.${key}（缺 contextWindowTokens，add_model 通道必填，需重启生效）`);
      continue;
    }
    addModelOps.push({ method: 'add_model', params: { name: key, def } });
  }
  for (const key of Object.keys(prevModels)) {
    if (nextModels[key]) continue;
    removeModelOps.push({ method: 'remove_model', params: { name: key } });
  }
  for (const [key, def] of Object.entries(nextModels)) {
    const before = prevModels[key];
    if (!before) continue;
    if (!sameJson(before.name, def.name)) {
      restartRequired.push(`models.${key}.name（模型名不在 update_model 白名单，需重启生效）`);
    }
    const patch = patchOf(before, def, MODEL_PATCH_KEYS);
    if (Object.keys(patch).length > 0) updateModelOps.push({ method: 'update_model', params: { name: key, patch } });
  }

  /* --- controller binding --- */
  if (!sameJson(prev.controller?.model, next.controller?.model)) {
    const ref = next.controller?.model;
    if (ref === undefined) {
      restartRequired.push('controller.model 被清空（回退 legacy provider 绑定需重启生效）');
    } else {
      bindingOps.push({ method: 'update_controller_model', params: { model: ref } });
    }
  }
  if (!sameJson(prev.controller?.provider, next.controller?.provider)) {
    restartRequired.push('controller.provider（legacy 绑定，需重启生效）');
  }

  /* --- worker binding + settings --- */
  const workerPatch: Record<string, unknown> = {};
  if (!sameJson(prev.worker?.model, next.worker?.model)) {
    if (next.worker?.model === undefined) {
      // The patch whitelist rejects a bare undefined; a cleared binding is a
      // legacy-provider fallback — restart territory.
      restartRequired.push('worker.model 被清空（回退 legacy provider 绑定需重启生效）');
    } else {
      workerPatch.model = next.worker?.model;
    }
  }
  if (!sameJson(prev.worker?.maxConcurrency, next.worker?.maxConcurrency)) workerPatch.maxConcurrency = next.worker?.maxConcurrency;
  if (!sameJson(prev.worker?.toolChoice, next.worker?.toolChoice)) workerPatch.toolChoice = next.worker?.toolChoice;
  if (Object.keys(workerPatch).length > 0) {
    bindingOps.push({ method: 'update_worker_settings', params: { patch: workerPatch } });
  }
  if (!sameJson(prev.worker?.provider, next.worker?.provider)) {
    restartRequired.push('worker.provider（legacy 绑定，需重启生效）');
  }

  /* --- sections the eight methods do not cover: restart-only --- */
  if (!sameJson(prev.workers, next.workers)) restartRequired.push('workers（第三方 worker 定义）');
  if (!sameJson(prev.permission, next.permission)) restartRequired.push('permission（权限配置）');
  if (!sameJson(prev.logging, next.logging)) restartRequired.push('logging（日志配置）');

  const ops = [
    ...addProviderOps,
    ...addModelOps,
    ...updateProviderOps,
    ...updateModelOps,
    ...bindingOps,
    ...removeModelOps,
    ...removeProviderOps,
  ];
  return { ops, restartRequired };
}

/** The RPC wire method name for an op (core's METHOD map values). */
export function wireMethodFor(method: ConfigUpdateOp['method']): string {
  return method;
}
