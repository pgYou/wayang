/**
 * Built-in worker type defaults.
 *
 * Puppet and other built-in workers have implicit descriptions and capabilities
 * not present in the config file. This module provides canonical values.
 */

import type { WorkerConfig } from '@/types/config';

/** Built-in puppet worker metadata. */
export const PUPPET_DEFAULTS = {
  /** Display name. */
  label: 'puppet',
  /** Emoji icon for UI display. */
  emoji: '\u{1F9F8}', //  🧸
  /** Description shown to the Controller LLM. */
  description: 'Built-in worker for general tasks using shell commands and file I/O.',
  /** Capability tags. */
  capabilities: ['shell/bash', 'file-io', 'general'],
} as const;

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
    emoji: config?.emoji ?? '\u{1F916}', // 🤖 fallback
  };
}
