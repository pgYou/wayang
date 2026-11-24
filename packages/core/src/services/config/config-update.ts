// Config hot-update service (monorepo-design 4.1 运行时热更) — the eight
// grain-sized update methods the RPC layer dispatches into.
//
// Semantics (design 4.1 定稿):
// 1. 声明值与生效值分离 — every method mutates the DECLARED config only;
//    effect happens lazily at consumption points (controller each turn,
//    worker next spawn). In-flight turns/spawns keep their old snapshot.
// 2. 依赖是引用不是拷贝 — updates never cascade, never rewrite downstream
//    entries; the return value is the impact list derived from the
//    reference graph.
// 3. 引用完整性 — add strictly rejects duplicates; removals reject when
//    referenced (with the reference list) — no cascade, no force; every
//    added/changed entry goes through the SAME protocol validator
//    (`validateConfig`) before anything is committed.
//
// The service mutates the live config object IN PLACE (identity-preserving
// field writes) so every consumer reading `ctx.config.*` at its own
// boundary sees the new declared value without any re-wiring.

import { RpcError, RPC_ERROR } from '@wayang-ai/protocol/rpc/protocol';
import {
  validateConfig,
  bindingSites,
  modelRefProvider,
  modelRefKey,
  type BindingSite,
  type ConfigUpdateAffected,
  type ConfigUpdateBlocker,
  type ConfigUpdateRejection,
  type ConfigUpdateRequest,
  type ConfigUpdateResult,
  type ModelDefinition,
  type ModelPatch,
  type ProviderDefinition,
  type ProviderPatch,
  type WayangConfig,
  type WorkerSettingsPatch,
} from '@wayang-ai/protocol';

/** Refuse an update with a structured rejection payload on the wire error. */
function reject(reason: ConfigUpdateRejection['reason'], detail: string, blockers: ConfigUpdateBlocker[] = []): never {
  throw new RpcError(RPC_ERROR.INVALID_PARAMS, detail, { reason, detail, blockers } satisfies ConfigUpdateRejection);
}

/** Readable spelling of a model reference for impact lists ('inline' for objects). */
function refSpelling(ref: unknown): string {
  if (typeof ref === 'string') return ref;
  if (typeof ref === 'object' && ref !== null) return 'inline';
  return '';
}

/** Map a binding site to its impact entry (when it must switch to the new value). */
function affectedOf(site: BindingSite): ConfigUpdateAffected {
  return {
    kind: site.kind,
    ...(site.kind === 'workerRow' && site.workerId !== undefined && { workerId: site.workerId }),
    via: refSpelling(site.ref ?? site.legacyProvider),
    effective: site.kind === 'controller' ? 'next-turn' : 'next-spawn',
  };
}

/** Bindings whose resolution runs through provider `name` (post-change graph). */
function bindingsOnProvider(config: WayangConfig, name: string): ConfigUpdateAffected[] {
  return bindingSites(config)
    .filter((site) => modelRefProvider(config, site.ref, site.legacyProvider) === name)
    .map(affectedOf);
}

/** Bindings whose string reference names the `models` key `key`. */
function bindingsOnModelKey(config: WayangConfig, key: string): ConfigUpdateAffected[] {
  return bindingSites(config)
    .filter((site) => modelRefKey(site.ref) === key)
    .map(affectedOf);
}

/**
 * References that block `removeProvider` (design 4.1 引用完整性): model
 * entries on the provider, plus bindings that reference the provider
 * DIRECTLY (legacy provider key, `"name/model"` composite, inline entry).
 * A binding that goes through a `models.<key>` entry is not itself listed —
 * the entry it names is.
 */
export function removeProviderBlockers(config: WayangConfig, name: string): ConfigUpdateBlocker[] {
  const blockers: ConfigUpdateBlocker[] = [];
  for (const [key, model] of Object.entries(config.models ?? {})) {
    if (typeof model === 'object' && model !== null && model.provider === name) {
      blockers.push({ site: `models.${key}`, kind: 'models' });
    }
  }
  for (const site of bindingSites(config)) {
    if (site.ref === undefined) {
      if (site.legacyProvider === name) blockers.push({ site: site.site, kind: 'binding' });
    } else if (typeof site.ref === 'string') {
      if (config.models?.[site.ref]) continue; // key ref — the entry itself is the blocker
      if (modelRefProvider(config, site.ref) === name) blockers.push({ site: site.site, kind: 'binding' });
    } else if (site.ref.provider === name) {
      blockers.push({ site: site.site, kind: 'binding' });
    }
  }
  return blockers;
}

/**
 * References that block `removeModel`: bindings whose string reference names
 * the `models` key `key` (composites and inline entries do not name it).
 */
export function removeModelBlockers(config: WayangConfig, key: string): ConfigUpdateBlocker[] {
  return bindingSites(config)
    .filter((site) => modelRefKey(site.ref) === key)
    .map((site) => ({ site: site.site, kind: 'binding' }) satisfies ConfigUpdateBlocker);
}

/** Fields a provider patch may set — the design 4.1 whitelist. */
const PROVIDER_PATCH_KEYS = ['baseURL', 'apiKey', 'type'] as const;
const MODEL_PATCH_KEYS = ['provider', 'contextWindowTokens', 'temperature', 'maxOutputTokens'] as const;
const WORKER_SETTINGS_KEYS = ['model', 'maxConcurrency', 'toolChoice'] as const;

/** Copy only whitelisted keys from a patch into a target record. */
function applyWhitelist<K extends string>(target: Record<string, unknown>, patch: Record<string, unknown>, keys: readonly K[]): void {
  for (const key of keys) {
    if (patch[key] !== undefined) target[key] = patch[key];
  }
}

export class ConfigUpdateService {
  /** The live declared config — mutated in place, identity preserved. */
  constructor(private readonly config: WayangConfig) {}

  /**
   * Validate the candidate on a deep clone, then commit by writing the same
   * change into the live config. Returns the post-change impact list;
   * rejects (structured RpcError) on any failure — the live config object
   * is never left half-written.
   */
  private apply(
    what: string,
    mutate: (candidate: WayangConfig) => void,
    commit: () => void,
    impact: () => ConfigUpdateAffected[],
  ): ConfigUpdateResult {
    const candidate = structuredClone(this.config);
    mutate(candidate);
    const err = validateConfig(candidate);
    if (err) {
      reject('invalid', `${what}: ${err}`);
    }
    commit();
    return { affected: impact() };
  }

  /** updateProvider(name, patch) — `{baseURL?, apiKey?, type?}`. */
  updateProvider(name: string, patch: ProviderPatch): ConfigUpdateResult {
    const target = this.config.providers[name];
    if (target === undefined) {
      reject('not-found', `updateProvider: providers.${name} does not exist`);
    }
    return this.apply(
      `updateProvider(providers.${name})`,
      (candidate) => applyWhitelist(candidate.providers[name] as unknown as Record<string, unknown>, patch as Record<string, unknown>, PROVIDER_PATCH_KEYS),
      () => applyWhitelist(target as unknown as Record<string, unknown>, patch as Record<string, unknown>, PROVIDER_PATCH_KEYS),
      () => bindingsOnProvider(this.config, name),
    );
  }

  /** updateModel(name, patch) — `{provider?, contextWindowTokens?, temperature?, maxOutputTokens?}`. */
  updateModel(name: string, patch: ModelPatch): ConfigUpdateResult {
    const target = this.config.models?.[name];
    if (target === undefined) {
      reject('not-found', `updateModel: models.${name} does not exist`);
    }
    return this.apply(
      `updateModel(models.${name})`,
      (candidate) => applyWhitelist(candidate.models![name] as unknown as Record<string, unknown>, patch as Record<string, unknown>, MODEL_PATCH_KEYS),
      () => applyWhitelist(target as unknown as Record<string, unknown>, patch as Record<string, unknown>, MODEL_PATCH_KEYS),
      () => bindingsOnModelKey(this.config, name),
    );
  }

  /** addProvider(name, def) — strict duplicate rejection; nothing references it yet. */
  addProvider(name: string, def: ProviderDefinition): ConfigUpdateResult {
    if (this.config.providers[name] !== undefined) {
      reject('duplicate', `addProvider: providers.${name} already exists (strict no-overwrite)`);
    }
    return this.apply(
      `addProvider(providers.${name})`,
      (candidate) => {
        candidate.providers[name] = { ...def };
      },
      () => {
        this.config.providers[name] = { ...def };
      },
      () => [], // a brand-new entry has no references in the graph
    );
  }

  /** addModel(name, def) — strict duplicate rejection; nothing references it yet. */
  addModel(name: string, def: ModelDefinition): ConfigUpdateResult {
    if (this.config.models?.[name] !== undefined) {
      reject('duplicate', `addModel: models.${name} already exists (strict no-overwrite)`);
    }
    return this.apply(
      `addModel(models.${name})`,
      (candidate) => {
        candidate.models ??= {};
        candidate.models[name] = { ...def };
      },
      () => {
        this.config.models ??= {};
        this.config.models[name] = { ...def };
      },
      () => [],
    );
  }

  /** removeProvider(name) — rejected with the reference list while anything still points at it. */
  removeProvider(name: string): ConfigUpdateResult {
    if (this.config.providers[name] === undefined) {
      reject('not-found', `removeProvider: providers.${name} does not exist`);
    }
    const blockers = removeProviderBlockers(this.config, name);
    if (blockers.length > 0) {
      reject(
        'referenced',
        `removeProvider: providers.${name} is referenced (${blockers.map((b) => b.site).join(', ')}) — removal is refused, no cascade, no force`,
        blockers,
      );
    }
    return this.apply(
      `removeProvider(providers.${name})`,
      (candidate) => {
        delete candidate.providers[name];
      },
      () => {
        delete this.config.providers[name];
      },
      () => [], // nothing referenced it — that is exactly why removal succeeded
    );
  }

  /** removeModel(name) — rejected with the binding list while any binding still names it. */
  removeModel(name: string): ConfigUpdateResult {
    if (this.config.models?.[name] === undefined) {
      reject('not-found', `removeModel: models.${name} does not exist`);
    }
    const blockers = removeModelBlockers(this.config, name);
    if (blockers.length > 0) {
      reject(
        'referenced',
        `removeModel: models.${name} is referenced (${blockers.map((b) => b.site).join(', ')}) — removal is refused, no cascade, no force`,
        blockers,
      );
    }
    return this.apply(
      `removeModel(models.${name})`,
      (candidate) => {
        delete candidate.models![name];
      },
      () => {
        delete this.config.models![name];
      },
      () => [],
    );
  }

  /** updateControllerModel(model) — rebinds the controller binding; effective next turn. */
  updateControllerModel(model: WayangConfig['controller']['model']): ConfigUpdateResult {
    return this.apply(
      'updateControllerModel',
      (candidate) => {
        candidate.controller.model = model;
      },
      () => {
        this.config.controller.model = model;
      },
      // The controller binding itself — it switches at the NEXT turn boundary.
      () => [{ kind: 'controller', via: refSpelling(model), effective: 'next-turn' }],
    );
  }

  /** updateWorkerSettings(patch) — `{model?, maxConcurrency?, toolChoice?}`; effective next spawn. */
  updateWorkerSettings(patch: WorkerSettingsPatch): ConfigUpdateResult {
    return this.apply(
      'updateWorkerSettings',
      (candidate) => applyWhitelist(candidate.worker as unknown as Record<string, unknown>, patch as Record<string, unknown>, WORKER_SETTINGS_KEYS),
      () => applyWhitelist(this.config.worker as unknown as Record<string, unknown>, patch as Record<string, unknown>, WORKER_SETTINGS_KEYS),
      // The default puppet worker binding — it switches at the NEXT spawn.
      () => [{
        kind: 'worker',
        via: refSpelling(this.config.worker.model ?? this.config.worker.provider),
        effective: 'next-spawn',
      }],
    );
  }
}

/**
 * Dispatch one parsed request to the right service method. Also the seam the
 * server's RPC registration uses — and the direct entry point for tests.
 */
export function applyConfigUpdate(service: ConfigUpdateService, request: ConfigUpdateRequest): ConfigUpdateResult {
  switch (request.method) {
    case 'update_provider': return service.updateProvider(request.name, request.patch);
    case 'update_model': return service.updateModel(request.name, request.patch);
    case 'add_provider': return service.addProvider(request.name, request.def);
    case 'add_model': return service.addModel(request.name, request.def);
    case 'remove_provider': return service.removeProvider(request.name);
    case 'remove_model': return service.removeModel(request.name);
    case 'update_controller_model': return service.updateControllerModel(request.model);
    case 'update_worker_settings': return service.updateWorkerSettings(request.patch);
  }
}
