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
 * `permission`, `logging`, `worker.maxTurns`, the advanced group's top-level
 * fields, a model entry's `name`) are reported as restart-required — the
 * envelope is written, the running server picks them up on the next boot.
 *
 * Both sides are canonical configs (protocol normalizeConfig runs at the one
 * config entry): legacy spellings — a provider's deprecated model fields, the
 * provider-key binding — never appear in a diff and have no branch here.
 */

import { modelRefKey, modelRefProvider } from '@wayang-ai/protocol';
import type { ModelConfig, WayangConfig } from '@wayang-ai/protocol';

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

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Field-level diff restricted to a whitelist. A field CLEARED in `next` is not
 * part of the patch: the wire parsers skip `undefined` (a patch can only set),
 * so a cleared field only takes effect on the next boot — it is reported in
 * `restartRequired` instead of silently dropped.
 */
function patchOf<T extends object>(
  prev: T,
  next: T,
  keys: readonly (keyof T & string)[],
  at: string,
  restartRequired: string[],
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of keys) {
    if (sameJson(prev[key], next[key])) continue;
    if (next[key] === undefined) {
      restartRequired.push(`${at}.${key} 被清空（热更通道只能改不能删，需重启生效）`);
      continue;
    }
    patch[key] = next[key];
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
 *
 * The server validates every op against ITS OWN config (prev + the ops sent so
 * far), and the envelope is already written by the time the ops go out — so an
 * op the server would reject must never be sent: it belongs in `restartRequired`.
 * Two things make the server's view differ from `next`:
 * - a new model without `contextWindowTokens` cannot cross (add_model's wire
 *   schema requires it) → the server never gets that entry this round;
 * - third-party `workers` rows are restart-only → on the server they keep
 *   pointing wherever `prev` pointed.
 * A binding to an entry the server does not have, or a removal of something the
 * server still sees referenced, is therefore deferred to the restart.
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

  /* --- providers: adds, updates (removals are decided last, see below) --- */
  const prevProviders = prev.providers ?? {};
  const nextProviders = next.providers ?? {};
  for (const [name, def] of Object.entries(nextProviders)) {
    if (prevProviders[name]) continue;
    addProviderOps.push({ method: 'add_provider', params: { name, def } });
  }
  for (const [name, def] of Object.entries(nextProviders)) {
    const before = prevProviders[name];
    if (!before) continue;
    const patch = patchOf(before, def, PROVIDER_PATCH_KEYS, `providers.${name}`, restartRequired);
    if (Object.keys(patch).length > 0) updateProviderOps.push({ method: 'update_provider', params: { name, patch } });
  }

  /* --- models: adds (wire-required fields only), updates, removals --- */
  const prevModels = prev.models ?? {};
  const nextModels = next.models ?? {};
  /** New entries the running server will NOT get this round. */
  const pendingAdds = new Set<string>();
  for (const [key, def] of Object.entries(nextModels)) {
    if (prevModels[key]) continue;
    // add_model's wire schema REQUIRES contextWindowTokens; an entry without
    // it cannot cross the hot path — restart territory, never invented values.
    if (def.contextWindowTokens === undefined) {
      restartRequired.push(`models.${key}（未声明上下文窗口，新增模型的通道要求必带，需重启生效）`);
      pendingAdds.add(key);
      continue;
    }
    addModelOps.push({ method: 'add_model', params: { name: key, def } });
  }
  for (const [key, def] of Object.entries(nextModels)) {
    const before = prevModels[key];
    if (!before) continue;
    if (!sameJson(before.name, def.name)) {
      restartRequired.push(`models.${key}.name（模型名不在 update_model 白名单，需重启生效）`);
    }
    const patch = patchOf(before, def, MODEL_PATCH_KEYS, `models.${key}`, restartRequired);
    if (Object.keys(patch).length > 0) updateModelOps.push({ method: 'update_model', params: { name: key, patch } });
  }

  /* --- controller binding --- */
  // What the SERVER's bindings will be after the ops sent below (unchanged when
  // the rewrite is deferred) — the removal checks at the end read these.
  let controllerRefOnServer = prev.controller?.model;
  if (!sameJson(prev.controller?.model, next.controller?.model)) {
    const ref = next.controller?.model;
    if (ref === undefined) {
      // update_controller_model requires a model — a cleared binding only
      // takes effect on the next boot.
      restartRequired.push('controller.model 被清空（需重启生效）');
    } else if (pendingAdds.has(modelRefKey(ref) ?? '')) {
      // The server does not have that entry yet — it would reject the binding.
      restartRequired.push(`controller.model → ${modelRefKey(ref)}（该模型需重启才登记，绑定一并重启生效）`);
    } else {
      bindingOps.push({ method: 'update_controller_model', params: { model: ref } });
      controllerRefOnServer = ref;
    }
  }

  /* --- worker binding + settings --- */
  let workerRefOnServer = prev.worker?.model;
  const workerPatch: Record<string, unknown> = {};
  if (!sameJson(prev.worker?.model, next.worker?.model)) {
    const ref = next.worker?.model;
    if (ref === undefined) {
      // The patch whitelist rejects a bare undefined — a cleared binding only
      // takes effect on the next boot.
      restartRequired.push('worker.model 被清空（需重启生效）');
    } else if (pendingAdds.has(modelRefKey(ref) ?? '')) {
      restartRequired.push(`worker.model → ${modelRefKey(ref)}（该模型需重启才登记，绑定一并重启生效）`);
    } else {
      workerPatch.model = ref;
      workerRefOnServer = ref;
    }
  }
  if (!sameJson(prev.worker?.maxConcurrency, next.worker?.maxConcurrency)) workerPatch.maxConcurrency = next.worker?.maxConcurrency;
  if (!sameJson(prev.worker?.toolChoice, next.worker?.toolChoice)) workerPatch.toolChoice = next.worker?.toolChoice;
  if (Object.keys(workerPatch).length > 0) {
    bindingOps.push({ method: 'update_worker_settings', params: { patch: workerPatch } });
  }

  /* --- sections the eight methods do not cover: restart-only --- */
  if (!sameJson(prev.workers, next.workers)) restartRequired.push('workers（第三方 worker 定义）');
  // puppet worker 的 maxTurns 不在 update_worker_settings 的白名单里；高级
  // 分组的几个顶层字段同理。漏报的后果是「保存了却什么都不提示」。
  if (!sameJson(prev.worker?.maxTurns, next.worker?.maxTurns)) restartRequired.push('worker.maxTurns（需重启生效）');
  if (!sameJson(prev.tavilyApiKey, next.tavilyApiKey)) restartRequired.push('tavilyApiKey（需重启生效）');
  if (!sameJson(prev.skillsDirs, next.skillsDirs)) restartRequired.push('skillsDirs（需重启生效）');
  if (!sameJson(prev.idleTimeoutMs, next.idleTimeoutMs)) restartRequired.push('idleTimeoutMs（需重启生效）');
  if (!sameJson(prev.signalWindowSize, next.signalWindowSize)) restartRequired.push('signalWindowSize（需重启生效）');
  if (!sameJson(prev.permission, next.permission)) restartRequired.push('permission（权限配置）');
  if (!sameJson(prev.logging, next.logging)) restartRequired.push('logging（日志配置）');

  /* --- removals: only what the running server will no longer reference --- */
  // The server's bindings after the ops above: the two global ones as sent (or
  // still prev's when deferred), plus the third-party rows — restart-only, so on
  // the server they keep whatever prev had.
  const rowRefs = Object.entries(prev.workers ?? {}).map(([id, worker]) => ({ label: `workers.${id}`, ref: worker?.model }));
  const serverRefs = [
    { label: 'controller', ref: controllerRefOnServer },
    { label: 'worker', ref: workerRefOnServer },
    ...rowRefs,
  ];
  const holdersOf = (key: string): string[] => serverRefs.filter((site) => modelRefKey(site.ref) === key).map((site) => site.label);

  for (const key of Object.keys(prevModels)) {
    if (nextModels[key]) continue;
    const holders = holdersOf(key);
    if (holders.length > 0) {
      restartRequired.push(`models.${key} 的移除（server 上 ${holders.join('、')} 还引用着它，需重启生效）`);
      continue;
    }
    removeModelOps.push({ method: 'remove_model', params: { name: key } });
  }

  // The server's models after the ops above: prev's entries + the adds that
  // cross − the removals that cross, with the provider patches applied.
  const serverModels: Record<string, ModelConfig> = { ...prevModels };
  for (const op of addModelOps) serverModels[op.params.name as string] = op.params.def as ModelConfig;
  for (const op of updateModelOps) {
    const patch = op.params.patch as { provider?: string };
    if (patch.provider !== undefined) serverModels[op.params.name as string] = { ...serverModels[op.params.name as string], provider: patch.provider };
  }
  for (const op of removeModelOps) delete serverModels[op.params.name as string];
  const serverView: WayangConfig = { ...prev, models: serverModels };

  for (const name of Object.keys(prevProviders)) {
    if (nextProviders[name]) continue;
    const modelsOnIt = Object.entries(serverModels).filter(([, model]) => model.provider === name).map(([key]) => `models.${key}`);
    const bindingsThroughIt = serverRefs.filter((site) => modelRefProvider(serverView, site.ref) === name).map((site) => site.label);
    if (modelsOnIt.length > 0 || bindingsThroughIt.length > 0) {
      restartRequired.push(`providers.${name} 的移除（server 上 ${[...modelsOnIt, ...bindingsThroughIt].join('、')} 还经过它，需重启生效）`);
      continue;
    }
    removeProviderOps.push({ method: 'remove_provider', params: { name } });
  }

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
