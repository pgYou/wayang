/**
 * Envelope parsing for the desktop-native config store (desktop-app-design
 * §2.11, 决策九). Pure protocol-level logic shared by:
 * - the main process's `ConfigStore` (src/main/config-store.ts) — the
 *   authoritative reader/writer of `<userData>/config.json`;
 * - the utility entry's standalone `--config` fallback, which accepts either
 *   an envelope or a plain `WayangConfig` file for manual runs.
 *
 * The envelope keeps the core config byte-compatible with protocol's
 * `WayangConfig` (`validateConfig` reused verbatim) and reserves a `desktop`
 * section for future host preferences (theme, window settings).
 */

import { findLegacyConfigKeys, validateConfig, type WayangConfig } from '@wayang-ai/protocol';

/** Envelope schema version this build reads and writes. */
export const CONFIG_SCHEMA_VERSION = 1;

/** The desktop config envelope: `{ schemaVersion, wayangConfig, desktop }`. */
export interface ConfigEnvelope {
  schemaVersion: number;
  wayangConfig: WayangConfig;
  /** Desktop-only preferences (future: theme, window state). Empty for now. */
  desktop: Record<string, unknown>;
}

/** Build a fresh envelope around a validated config. */
export function makeEnvelope(wayangConfig: WayangConfig, desktop: Record<string, unknown> = {}): ConfigEnvelope {
  return { schemaVersion: CONFIG_SCHEMA_VERSION, wayangConfig, desktop };
}

/**
 * validateConfig assumes the config's top-level shape; a structurally broken
 * payload (missing `controller`, etc.) makes it throw instead of returning a
 * problem string. Wrap it so any malformed input is a clean rejection with a
 * precise message, never a TypeError escaping the loader.
 */
export function validateOrReject(config: WayangConfig, label: string): void {
  let problem: string | null;
  try {
    problem = validateConfig(config);
  } catch (err) {
    throw new Error(`invalid ${label}: malformed config (${(err as Error).message})`);
  }
  if (problem) throw new Error(`invalid ${label}: ${problem}`);
}

/**
 * 桌面配置的严格门槛（envelope 读取与 renderer save 共用）：桌面应用内部
 * 只认、只存规范格式（顶层 `models` + `model` 引用）。旧版 CLI 写法只在
 * 「导入 CLI 配置」入口经 protocol 的 normalizeConfig 翻译一次；撞上任何
 * 废弃键说明是旧版本残留或外来文件——报错让人重新 onboard / 导入，不做
 * 静默兼容。
 */
export function assertCanonicalConfig(config: WayangConfig, label: string): void {
  const legacyKeys = findLegacyConfigKeys(config);
  if (legacyKeys.length === 0) return;
  throw new Error(
    `invalid ${label}: 含旧版配置键 ${legacyKeys.join('、')}——桌面配置只存规范格式，请重新 onboard（可重新导入 CLI 配置）`,
  );
}

/** Structural sniff: does a parsed JSON object look like our envelope? */
export function isEnvelopeLike(value: unknown): value is { schemaVersion: unknown; wayangConfig: unknown; desktop: unknown } {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) &&
    'schemaVersion' in value && 'wayangConfig' in value
  );
}

/**
 * Parse + validate one envelope: schema version must be exactly the one this
 * build speaks, and the embedded `wayangConfig` must pass `validateConfig`
 * and be canonical (no legacy key — see assertCanonicalConfig).
 * Throws with a precise message on any rejection.
 */
export function parseConfigEnvelope(raw: string): ConfigEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`config file is not valid JSON: ${(err as Error).message}`);
  }
  if (!isEnvelopeLike(parsed)) {
    throw new Error('config file is not a desktop envelope (expected { schemaVersion, wayangConfig, desktop })');
  }
  if (parsed.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new Error(
      `unsupported config envelope schemaVersion ${String(parsed.schemaVersion)} (expected ${CONFIG_SCHEMA_VERSION})`,
    );
  }
  const desktop =
    typeof parsed.desktop === 'object' && parsed.desktop !== null && !Array.isArray(parsed.desktop)
      ? (parsed.desktop as Record<string, unknown>)
      : {};
  const config = parsed.wayangConfig as WayangConfig;
  validateOrReject(config, 'wayangConfig in envelope');
  assertCanonicalConfig(config, 'wayangConfig in envelope');
  return { schemaVersion: CONFIG_SCHEMA_VERSION, wayangConfig: config, desktop };
}
