/**
 * Built-in worker type defaults.
 *
 * Puppet and other built-in workers have implicit descriptions and capabilities
 * not present in the config file. This module provides canonical values.
 */

import type { WorkerConfig, WorkerType } from '@/types/config';

/** Built-in puppet worker metadata. */
export const PUPPET_DEFAULTS = {
  /** Display name. */
  label: 'puppet',
  /** Emoji icon for UI display. */
  emoji: '\u{1F9F8}', //  🧸
  /** Description shown to the Controller LLM. */
  description: 'Built-in worker for general tasks — file search/content search, file create/edit/read, shell commands, and web search.',
  /** Capability tags. */
  capabilities: ['code', 'debug', 'refactor', 'search', 'file-io', 'web-search', 'shell'],
} as const;

/**
 * Provider-default emojis for `*-acp` workers (TUI item of the C2 wiring):
 * shown when the config row declares no `emoji`, so an ACP worker is still
 * distinguishable at a glance instead of collapsing into the generic 🤖.
 * A configured `emoji` always wins. Provisional picks — not prescribed by
 * the design booklets; adjust with the config, not here, once real usage
 * settles on better glyphs.
 */
const ACP_PROVIDER_EMOJIS: Partial<Record<WorkerType, string>> = {
  acp: '\u{1F9E9}', // 🧩 generic config-driven ACP worker
  codebuddy: '\u{1F427}', // 🐧 Tencent CodeBuddy
  opencode: '\u{1F989}', // 🦉 OpenCode (experimental)
};

/**
 * Resolve display metadata for a worker type.
 * Returns puppet defaults for undefined/puppet type, otherwise derives from config.
 */
export function getWorkerMeta(
  workerType: string | undefined,
  workerConfigs?: Record<string, WorkerConfig>,
): { label: string; emoji: string } {
  const type = workerType ?? 'puppet';
  if (type === 'puppet') {
    return { label: PUPPET_DEFAULTS.label, emoji: PUPPET_DEFAULTS.emoji };
  }
  const config = workerConfigs?.[type];
  return {
    label: type,
    // Configured emoji → provider default (ACP rows) → generic fallback.
    emoji: config?.emoji ?? (config ? ACP_PROVIDER_EMOJIS[config.type] : undefined) ?? '\u{1F916}', // 🤖 fallback
  };
}
