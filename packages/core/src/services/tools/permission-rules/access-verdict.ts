// Bridge between the tool-specific gates and the shared access policy (decidePath + verdict mapping).

import {
  decideAccess,
  type AccessMode,
  type DecideAccessResult,
} from '@/infra/permission/policy';
import { mergeSensitiveDirs, resolveSensitiveMode } from '@/infra/permission/permission-config';
import type { ToolAccessDecision, WorkerAccessScope } from './types';

/**
 * Run one path past the shared policy with this run's boundary as context.
 *
 * `allowReadWithinHome: false` — a worker's silence-worthy scope is its
 * workspace, its task allowedDirs and the explicitly configured roots, NOT
 * the whole home the policy itself grants reads over (that is the
 * controller's own read scope). A home read therefore reaches the caller as
 * the policy's `read-within-home` ASK directly, never as an allow that a
 * caller would have to downgrade after the fact.
 */
export function decidePath(
  scope: WorkerAccessScope,
  path: string,
  access: AccessMode,
): DecideAccessResult {
  const permission = scope.permission;
  return decideAccess({
    path,
    access,
    cwd: scope.workspace,
    userHome: scope.userHome,
    taskWorkspace: scope.workspace,
    taskAllowedDirs: scope.taskAllowedDirs,
    configAllowedDirs: permission?.allowedDirs,
    autoAllowRoots: permission?.autoAllowRoots,
    // `sensitiveDirs` is the current key; `deniedDirs` is its deprecated alias
    // and is merged (deduped) here so a legacy config keeps protecting exactly
    // the directories it declares.
    extraSensitiveDirs: mergeSensitiveDirs(permission),
    sensitiveMode: resolveSensitiveMode(permission),
    allowReadWithinHome: false,
  });
}

/**
 * Map a policy verdict onto a tool verdict, carrying the explainability fields
 * (matched entry / source / canonical path / judged access) along so approval
 * requests and the audit trail can name the hit.
 */
export function toToolDecision(verdict: DecideAccessResult, access: AccessMode): ToolAccessDecision {
  return {
    decision: verdict.decision,
    matchedRule: verdict.matchedRule,
    resolvedPath: verdict.resolvedPath,
    access,
    ...(verdict.matchedEntry !== undefined && {
      matchedEntry: verdict.matchedEntry,
      matchedSource: verdict.matchedSource,
      sensitive: true,
    }),
  };
}

/**
 * Declare the canonical target as this verdict's only asking path.
 *
 * Applied where the verdict was reached by judging ONE concrete path — a file
 * tool, or one candidate inside a bash command. The task approval memory
 * (issue #46) keys grants on `direction:path`, so an `ask` must say WHICH paths
 * it is about; `resolvedPath` alone is not enough for a bash command whose
 * several candidates all ask (see `ToolAccessDecision.askPaths`).
 */
export function withAskPaths(decision: ToolAccessDecision): ToolAccessDecision {
  if (decision.decision !== 'ask' || decision.resolvedPath === undefined) return decision;
  return { ...decision, askPaths: [decision.resolvedPath] };
}
