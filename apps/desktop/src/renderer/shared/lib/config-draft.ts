/**
 * Pure draft-editing helpers for the onboarding wizard and the settings page
 *. The UI never mutates a `WayangConfig` in place — every
 * edit produces a new object through these functions, so React state stays
 * predictable and the helpers are unit-testable without a DOM.
 */

import { bindingSites, modelRefKey, modelRefProvider } from '@wayang-ai/protocol';
import type { LoggingConfig, ModelRef, PermissionConfig, WayangConfig, WorkerConfig } from '@wayang-ai/protocol';

/** The wizard's starting point: an empty-but-shaped draft. */
export function emptyDraft(): WayangConfig {
  return { providers: {}, models: {}, controller: {}, worker: { maxConcurrency: 3 } };
}

export function upsertProvider(config: WayangConfig, key: string, def: WayangConfig['providers'][string]): WayangConfig {
  return { ...config, providers: { ...config.providers, [key]: def } };
}

/**
 * 删除 provider：连同它名下的 models 条目一起删（绑定随之清空）。设置页对
 * 「名下还有模型」的 provider 不走到这里（见 providerRemovalProblem）。
 */
export function removeProvider(config: WayangConfig, key: string): WayangConfig {
  const providers = { ...config.providers };
  delete providers[key];
  const owned = Object.entries(config.models ?? {})
    .filter(([, model]) => model.provider === key)
    .map(([modelKey]) => modelKey);
  return owned.reduce((next, modelKey) => removeModel(next, modelKey), { ...config, providers });
}

export function upsertModel(config: WayangConfig, key: string, def: NonNullable<WayangConfig['models']>[string]): WayangConfig {
  return { ...config, models: { ...(config.models ?? {}), [key]: def } };
}

/** 删除 models 条目，并把指向它的绑定一并清空——配置里不留悬空引用。 */
export function removeModel(config: WayangConfig, key: string): WayangConfig {
  const models = { ...(config.models ?? {}) };
  delete models[key];
  return { ...rewriteModelRefs(config, key, undefined), models };
}

/**
 * 重命名 provider：`providers` 的键改名（位置不变），并同步改写引用它的
 * 地方——名下 models 条目的 `provider`、经它解析的模型引用（`provider/model`
 * 组合串与内联对象）。改名不该让任何绑定断掉。
 */
export function renameProvider(config: WayangConfig, from: string, to: string): WayangConfig {
  if (from === to || !config.providers[from]) return config;
  const providers: WayangConfig['providers'] = {};
  for (const [key, def] of Object.entries(config.providers)) providers[key === from ? to : key] = def;
  const models = Object.fromEntries(
    Object.entries(config.models ?? {}).map(([key, model]) => [key, model.provider === from ? { ...model, provider: to } : model]),
  );
  // 只改写「字面上经过旧 provider」的引用：组合串 `from/…` 与内联对象的 provider。
  // 指向 models 条目的字符串引用不用动——条目自己的 provider 已经改了。
  const rewrite = <T extends { model?: ModelRef }>(holder: T): T => {
    const ref = holder.model;
    if (typeof ref === 'string') {
      const prefix = `${from}/`;
      return ref.startsWith(prefix) ? { ...holder, model: `${to}/${ref.slice(prefix.length)}` } : holder;
    }
    if (typeof ref === 'object' && ref !== null && ref.provider === from) return { ...holder, model: { ...ref, provider: to } };
    return holder;
  };
  return {
    ...config,
    providers,
    models,
    controller: rewrite(config.controller),
    worker: rewrite(config.worker),
    workers: config.workers && Object.fromEntries(Object.entries(config.workers).map(([id, worker]) => [id, rewrite(worker)])),
  };
}

/** 重命名 models 条目，并把指向它的绑定改写成新条目名——否则绑定会断。 */
export function renameModel(config: WayangConfig, from: string, to: string): WayangConfig {
  if (from === to) return config;
  const def = config.models?.[from];
  if (!def) return config;
  const models = { ...(config.models ?? {}) };
  delete models[from];
  models[to] = def;
  return { ...rewriteModelRefs(config, from, to), models };
}

export function setControllerModel(config: WayangConfig, model: ModelRef | undefined): WayangConfig {
  return { ...config, controller: { ...config.controller, model } };
}

export function setWorkerModel(config: WayangConfig, model: ModelRef | undefined): WayangConfig {
  return { ...config, worker: { ...config.worker, model } };
}

/** 绑定位置的展示名：两个全局绑定是 controller / worker，其余是 workers.<id>。 */
function siteLabel(site: { kind: 'controller' | 'worker' | 'workerRow'; workerId?: string }): string {
  return site.kind === 'workerRow' ? `workers.${site.workerId}` : site.kind;
}

/** 遍历所有可能引用 models 条目的位置，把其中指向 `from` 的引用改写成 `to`。 */
function rewriteModelRefs(config: WayangConfig, from: string, to: string | undefined): WayangConfig {
  const rewrite = <T extends { model?: ModelRef }>(holder: T): T => (modelRefKey(holder.model) === from ? { ...holder, model: to } : holder);
  return {
    ...config,
    controller: rewrite(config.controller),
    worker: rewrite(config.worker),
    workers: config.workers && Object.fromEntries(Object.entries(config.workers).map(([id, worker]) => [id, rewrite(worker)])),
  };
}

/** 引用某个 models 条目的绑定位置（controller / worker / workers.<id>）。 */
export function modelRefSites(config: WayangConfig, key: string): string[] {
  return bindingSites(config)
    .filter((site) => modelRefKey(site.ref) === key)
    .map(siteLabel);
}

/**
 * 设置页删除 models 条目前的检查：每次保存都要留下一份完整可用的配置，
 * 正在被绑定的条目不能删。返回给用户看的提示，null 表示可以删。
 */
export function modelRemovalProblem(config: WayangConfig, key: string): string | null {
  const sites = modelRefSites(config, key);
  return sites.length > 0 ? `该模型正被 ${sites.join('、')} 使用，先改绑再删除` : null;
}

/** 设置页删除 provider 前的检查（同 modelRemovalProblem）：名下还有模型、或还有绑定经它解析时不能删。 */
export function providerRemovalProblem(config: WayangConfig, key: string): string | null {
  const owned = Object.entries(config.models ?? {})
    .filter(([, model]) => model.provider === key)
    .map(([modelKey]) => modelKey);
  if (owned.length > 0) return `该 provider 下还有模型（${owned.join('、')}），先删除这些模型或把它们改到别的 provider`;
  const through = bindingSites(config)
    .filter((site) => modelRefProvider(config, site.ref) === key)
    .map(siteLabel);
  return through.length > 0 ? `${through.join('、')} 的模型引用经过该 provider，先改绑再删除` : null;
}

/* ------------------------------ 第三方 worker ------------------------------ */

export function upsertWorkerEntry(config: WayangConfig, id: string, def: WorkerConfig): WayangConfig {
  return { ...config, workers: { ...(config.workers ?? {}), [id]: def } };
}

export function removeWorkerEntry(config: WayangConfig, id: string): WayangConfig {
  const workers = { ...(config.workers ?? {}) };
  delete workers[id];
  return { ...config, workers };
}

/**
 * 重命名第三方 worker（`workers` 的键改名，位置不变）。配置里没有别处引用
 * worker ID，所以只需要换键。
 */
export function renameWorkerEntry(config: WayangConfig, from: string, to: string): WayangConfig {
  if (from === to || !config.workers?.[from]) return config;
  const workers: NonNullable<WayangConfig['workers']> = {};
  for (const [id, def] of Object.entries(config.workers ?? {})) workers[id === from ? to : id] = def;
  return { ...config, workers };
}

export function setWorkerEntryEnabled(config: WayangConfig, id: string, enable: boolean): WayangConfig {
  const existing = config.workers?.[id];
  if (!existing) return config;
  return upsertWorkerEntry(config, id, { ...existing, enable });
}

/* ------------------------------ 权限 ------------------------------ */

type PermissionListKey = 'allowedDirs' | 'autoAllowRoots' | 'sensitiveDirs' | 'extraWorkspaceRoots';

/** 权限配置里字符串数组类字段的统一 setter（允许传入的目录文本已按行拆分）。 */
export function setPermissionList(config: WayangConfig, key: PermissionListKey, dirs: string[]): WayangConfig {
  const permission = { ...(config.permission ?? {}) };
  if (dirs.length === 0) delete permission[key];
  else permission[key] = dirs;
  return { ...config, permission: Object.keys(permission).length > 0 ? permission : undefined };
}

export function setSensitiveMode(config: WayangConfig, mode: PermissionConfig['sensitiveMode']): WayangConfig {
  const permission = { ...(config.permission ?? {}) };
  if (mode === undefined) delete permission.sensitiveMode;
  else permission.sensitiveMode = mode;
  return { ...config, permission: Object.keys(permission).length > 0 ? permission : undefined };
}

export function setApprovalMemory(config: WayangConfig, mode: PermissionConfig['approvalMemory']): WayangConfig {
  const permission = { ...(config.permission ?? {}) };
  if (mode === undefined) delete permission.approvalMemory;
  else permission.approvalMemory = mode;
  return { ...config, permission: Object.keys(permission).length > 0 ? permission : undefined };
}

/* ------------------------------ 高级 ------------------------------ */

export function setTavilyApiKey(config: WayangConfig, tavilyApiKey: string): WayangConfig {
  const next = { ...config };
  if (tavilyApiKey.trim().length === 0) delete next.tavilyApiKey;
  else next.tavilyApiKey = tavilyApiKey.trim();
  return next;
}

export function setSkillsDirs(config: WayangConfig, skillsDirs: string[]): WayangConfig {
  const next = { ...config };
  if (skillsDirs.length === 0) delete next.skillsDirs;
  else next.skillsDirs = skillsDirs;
  return next;
}

export function setIdleTimeoutMs(config: WayangConfig, idleTimeoutMs: number | undefined): WayangConfig {
  const next = { ...config };
  if (idleTimeoutMs === undefined) delete next.idleTimeoutMs;
  else next.idleTimeoutMs = idleTimeoutMs;
  return next;
}

export function setSignalWindowSize(config: WayangConfig, signalWindowSize: number | undefined): WayangConfig {
  const next = { ...config };
  if (signalWindowSize === undefined) delete next.signalWindowSize;
  else next.signalWindowSize = signalWindowSize;
  return next;
}

export function setLogging(config: WayangConfig, logging: LoggingConfig): WayangConfig {
  return { ...config, logging: Object.keys(logging).length > 0 ? logging : undefined };
}

export function setWorkspacePref(desktop: Record<string, unknown>, path: string | null): Record<string, unknown> {
  const next = { ...desktop };
  if (path === null) delete next.defaultWorkerWorkspace;
  else next.defaultWorkerWorkspace = path;
  return next;
}

/** Parse a textarea (one dir per line) into the allowedDirs list. */
export function parseDirList(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
