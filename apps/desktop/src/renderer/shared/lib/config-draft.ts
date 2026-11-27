/**
 * Pure draft-editing helpers for the onboarding wizard and the settings page
 *. The UI never mutates a `WayangConfig` in place — every
 * edit produces a new object through these functions, so React state stays
 * predictable and the helpers are unit-testable without a DOM.
 */

import type { LoggingConfig, ModelRef, PermissionConfig, ToolChoice, WayangConfig, WorkerConfig } from '@wayang-ai/protocol';

/** The wizard's starting point: an empty-but-shaped draft. */
export function emptyDraft(): WayangConfig {
  return { providers: {}, models: {}, controller: {}, worker: { maxConcurrency: 3 } };
}

export function upsertProvider(config: WayangConfig, key: string, def: WayangConfig['providers'][string]): WayangConfig {
  return { ...config, providers: { ...config.providers, [key]: def } };
}

export function removeProvider(config: WayangConfig, key: string): WayangConfig {
  const providers = { ...config.providers };
  delete providers[key];
  return { ...config, providers };
}

export function upsertModel(config: WayangConfig, key: string, def: NonNullable<WayangConfig['models']>[string]): WayangConfig {
  return { ...config, models: { ...(config.models ?? {}), [key]: def } };
}

export function removeModel(config: WayangConfig, key: string): WayangConfig {
  const models = { ...(config.models ?? {}) };
  delete models[key];
  return { ...config, models };
}

export function setControllerModel(config: WayangConfig, model: ModelRef | undefined): WayangConfig {
  return { ...config, controller: { ...config.controller, model } };
}

export function setWorkerModel(config: WayangConfig, model: ModelRef | undefined): WayangConfig {
  return { ...config, worker: { ...config.worker, model } };
}

export function setMaxConcurrency(config: WayangConfig, maxConcurrency: number): WayangConfig {
  return { ...config, worker: { ...config.worker, maxConcurrency } };
}

export function setWorkerToolChoice(config: WayangConfig, toolChoice: ToolChoice | undefined): WayangConfig {
  return { ...config, worker: { ...config.worker, toolChoice } };
}

export function setWorkerMaxTurns(config: WayangConfig, maxTurns: number | undefined): WayangConfig {
  return { ...config, worker: { ...config.worker, maxTurns } };
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
