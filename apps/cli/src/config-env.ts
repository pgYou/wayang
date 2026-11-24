/**
 * Shared constants for the CLI host's config handoff (monorepo-design 4.1
 * 改造一) — side-effect-free so both the spawning client (connect.ts) and
 * the spawned server entry can import it.
 */

/**
 * Child-environment channel carrying the config object the client resolved
 * ONCE: `JSON.stringify(WayangConfig)`. The server child deserializes it and
 * boots from the object — no second parse, no file/env read. Env (not argv)
 * because `ps` would expose the provider API keys.
 */
export const CONFIG_OBJECT_ENV = 'WAYANG_CONFIG_OBJECT';
