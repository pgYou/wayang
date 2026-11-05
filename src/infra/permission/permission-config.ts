/**
 * `permission` config-section compatibility helpers.
 *
 * 0.8.1 renamed the credential/tool-config directory list from "deny list" to
 * "sensitive list": the matching entries are protected locations, and a READ
 * hit is now an approval (`ask`) rather than a hard refusal. The config key
 * moved with it:
 *
 *   permission.sensitiveDirs  — the current key
 *   permission.deniedDirs     — deprecated alias, STILL READ and merged
 *
 * The alias is kept on purpose. The config lives on disk with no migration
 * tool, so silently ignoring the old key would quietly DROP a protection the
 * user declared themselves — a fail-open failure, far worse than carrying one
 * extra key. Merging is cheap: dedupe the union and be done. Once merged, the
 * origin of an entry has no effect on any decision, so nothing downstream needs
 * to know which key it came from.
 *
 * `permission.sensitiveMode` is the escape hatch: `'ask'` (default) asks the
 * controller before a sensitive hit in EITHER direction (read or write),
 * `'deny'` restores the pre-0.8.1 "refuse without asking" behaviour for both.
 * Neither mode allows a sensitive hit through: the list outranks every allow
 * rule, so the mode only chooses between an approval and a refusal.
 */

import type { ApprovalMemoryMode, PermissionConfig } from '@/types/config';
import type { SensitiveMode } from './policy';

/** Default `permission.sensitiveMode`: sensitive reads request approval. */
export const DEFAULT_SENSITIVE_MODE: SensitiveMode = 'ask';

/** Default `permission.approvalMemory`: approvals live as long as their task. */
export const DEFAULT_APPROVAL_MEMORY: ApprovalMemoryMode = 'task';

/**
 * The configured sensitive directories, deduped, with the deprecated
 * `deniedDirs` alias folded in. Entries keep their declared order (current key
 * first); duplicates are dropped so a dir listed in both keys is not reported
 * twice in approval prompts or audits.
 */
export function mergeSensitiveDirs(permission?: PermissionConfig): string[] {
  const entries = [...(permission?.sensitiveDirs ?? []), ...(permission?.deniedDirs ?? [])];
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    merged.push(entry);
  }
  return merged;
}

/** `permission.sensitiveMode` with the default applied. */
export function resolveSensitiveMode(permission?: PermissionConfig): SensitiveMode {
  return permission?.sensitiveMode ?? DEFAULT_SENSITIVE_MODE;
}

/**
 * `permission.approvalMemory` with the default applied. Kept as a helper (and
 * not read field-by-field at the call sites) so the default lives in one place
 * and every consumer — middleware, engine cleanup — agrees on it.
 */
export function resolveApprovalMemory(permission?: PermissionConfig): ApprovalMemoryMode {
  return permission?.approvalMemory ?? DEFAULT_APPROVAL_MEMORY;
}

/** True once the deprecation warning has been emitted (per process). */
let deprecatedDeniedDirsWarned = false;

/**
 * Warn ONCE per process — and only when the old key is actually populated — so
 * a legacy config prints a single pointer to the new key at startup instead of
 * a line per permission check.
 */
export function warnDeprecatedPermissionKeys(
  permission: PermissionConfig | undefined,
  warn: (message: string) => void,
): void {
  if (deprecatedDeniedDirsWarned) return;
  const legacy = permission?.deniedDirs;
  if (!Array.isArray(legacy) || legacy.length === 0) return;
  deprecatedDeniedDirsWarned = true;
  warn(
    'permission.deniedDirs is deprecated and will be removed in a future release — use permission.sensitiveDirs instead (both keys are read and merged).',
  );
}

/** Test-only: forget that the deprecation warning was already emitted. */
export function resetDeprecatedPermissionKeysWarning(): void {
  deprecatedDeniedDirsWarned = false;
}
