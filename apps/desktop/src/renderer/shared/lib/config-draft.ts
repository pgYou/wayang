/**
 * Pure draft-editing helpers for the onboarding wizard and the settings page
 *. The UI never mutates a `WayangConfig` in place — every
 * edit produces a new object through these functions, so React state stays
 * predictable and the helpers are unit-testable without a DOM.
 */

import type { ModelRef, WayangConfig } from '@wayang-ai/protocol';

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

export function setWorkspacePref(desktop: Record<string, unknown>, path: string | null): Record<string, unknown> {
  const next = { ...desktop };
  if (path === null) delete next.defaultWorkerWorkspace;
  else next.defaultWorkerWorkspace = path;
  return next;
}

export function setAllowedDirs(config: WayangConfig, dirs: string[]): WayangConfig {
  const permission = { ...(config.permission ?? {}) };
  if (dirs.length === 0) delete permission.allowedDirs;
  else permission.allowedDirs = dirs;
  return { ...config, permission: Object.keys(permission).length > 0 ? permission : undefined };
}

/** Parse a textarea (one dir per line) into the allowedDirs list. */
export function parseDirList(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
