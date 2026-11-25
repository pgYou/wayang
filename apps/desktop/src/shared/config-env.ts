/**
 * Shared constants for the desktop host's config handoff (monorepo-design 4.1
 * 改造一) — the desktop counterpart of the CLI's config-env channel. The main
 * process resolves and validates the config ONCE and hands the JSON
 * serialization to the spawned UtilityProcess, so the utility entry never
 * reads config files on the spawned path. Env (not argv) because `ps` would
 * expose the provider API keys.
 */

/** Utility-process environment channel carrying `JSON.stringify(WayangConfig)`. */
export const CONFIG_OBJECT_ENV = 'WAYANG_CONFIG_OBJECT';
