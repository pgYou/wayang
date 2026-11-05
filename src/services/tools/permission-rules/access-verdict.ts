// Bridge between the tool-specific gates and the shared access policy (decidePath + verdict mapping + home-read narrowing).

import {
  decideAccess,
  type AccessMode,
  type DecideAccessResult,
} from '@/infra/permission/policy';
import { mergeSensitiveDirs, resolveSensitiveMode } from '@/infra/permission/permission-config';
import type { BashCandidate } from './bash-paths';
import type { ToolAccessDecision, WorkerAccessScope } from './types';

/** Run one path past the shared policy with this run's boundary as context. */
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

/**
 * Narrow the policy's "reads inside home" allow for a BASH candidate.
 * The policy lets a read happen anywhere under home (the controller's own read
 * scope, rule 6), but a WORKER's silence-worthy scope is its workspace, its task
 * allowedDirs and the explicitly configured roots. A bash candidate that the
 * classification now names a `read` gets exactly the same treatment a file tool
 * gets: the allow is turned back into an approval. Classifying a command as a
 * read therefore changes only the DIRECTION reported (audit trail, approval
 * request) — never the set of paths a worker may open without asking.
 *
 * The test is the policy's `withinReadScope` flag, not the `matchedRule` string,
 * so renaming the rule cannot widen access.
 */
export function narrowHomeRead(verdict: DecideAccessResult, candidate: BashCandidate): ToolAccessDecision {
  if (verdict.decision === 'allow' && verdict.withinReadScope) {
    return {
      decision: 'ask',
      matchedRule: 'read-within-home',
      resolvedPath: verdict.resolvedPath,
      access: candidate.access,
      ...(verdict.resolvedPath !== undefined && { askPaths: [verdict.resolvedPath] }),
    };
  }
  return withAskPaths(toToolDecision(verdict, candidate.access));
}
