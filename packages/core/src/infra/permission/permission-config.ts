/**
 * `permission` config-section helpers.
 *
 * 0.8.1 renamed the credential/tool-config directory list from "deny list" to
 * "sensitive list": the matching entries are protected locations, and a READ
 * hit is now an approval (`ask`) rather than a hard refusal. The config key
 * moved with it (`permission.deniedDirs` → `permission.sensitiveDirs`).
 *
 * The old key is NOT read here. Hosts fold it into `sensitiveDirs` once at
 * their config entry (protocol `normalizeConfig`) — a silently dropped
 * user-declared protection would be a fail-open failure, which is exactly
 * what that translation prevents — and core's intake refuses a config that
 * still carries it. Once merged, the origin of an entry has no effect on any
 * decision, so nothing downstream needs to know where an entry came from.
 *
 * `permission.sensitiveMode` is the escape hatch: `'ask'` (default) asks the
 * controller before a sensitive hit in EITHER direction (read or write),
 * `'deny'` restores the pre-0.8.1 "refuse without asking" behaviour for both.
 * Neither mode allows a sensitive hit through: the list outranks every allow
 * rule, so the mode only chooses between an approval and a refusal.
 */

import type { ApprovalMemoryMode, PermissionConfig } from '@wayang-ai/protocol/types/config';
import type { SensitiveMode } from './policy';

/** Default `permission.sensitiveMode`: sensitive reads request approval. */
export const DEFAULT_SENSITIVE_MODE: SensitiveMode = 'ask';

/** Default `permission.approvalMemory`: approvals live as long as their task. */
export const DEFAULT_APPROVAL_MEMORY: ApprovalMemoryMode = 'task';

/**
 * The configured sensitive directories, deduped. Entries keep their declared
 * order; empty entries and duplicates are dropped so a dir is not reported
 * twice in approval prompts or audits.
 */
export function resolveSensitiveDirs(permission?: PermissionConfig): string[] {
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const entry of permission?.sensitiveDirs ?? []) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    resolved.push(entry);
  }
  return resolved;
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
