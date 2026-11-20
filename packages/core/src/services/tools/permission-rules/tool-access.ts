// Top-level tool dispatch: routes a gated call to the bash or file gate, attaches the denial message.

import type { AccessMode } from '@/infra/permission/policy';
import { evaluateBashAccess } from './bash-access';
import { evaluateFileAccess, FILE_TOOL_NAMES } from './file-access';
import type { ToolAccessDecision, WorkerAccessScope } from './types';

/**
 * Denial message for a sensitive-list refusal. Names the tool and, when the
 * worker supplied one, the path IT asked for — never which sensitive entry
 * matched and never the canonical (possibly symlinked) target, so a refusal
 * discloses nothing the worker didn't already know.
 *
 * A sensitive hit is only refused when the user asked for that
 * (`sensitiveMode: 'deny'`); the default is an approval. So the message says
 * BOTH things: the boundary (it is not a retryable path problem, the rule
 * outranks every allow) and WHY there was no prompt. Without the second half a
 * worker cannot tell "denied, ask the controller for a different route" from
 * "this user configured no prompts", and retries in a loop.
 *
 * `access` picks the direction wording; it defaults to the neutral phrasing, so
 * a caller that does not know the direction stays disclosure-safe.
 */
export function denyMessage(
  toolName: string,
  requestedPath?: string,
  access?: AccessMode,
): string {
  const write = access === 'write';
  const why = '(a protected location; refused without asking — sensitiveMode is "deny")';
  if (toolName === 'bash') {
    return write
      ? `[ERROR] bash: refusing to run this command — it would write to a path on the sensitive list ${why}.`
      : `[ERROR] bash: refusing to run this command — it touches a path on the sensitive list ${why}.`;
  }
  const target = requestedPath ? ` "${requestedPath}"` : '';
  return write
    ? `[ERROR] ${toolName}: refusing to write${target} — the path is on the sensitive list ${why}.`
    : `[ERROR] ${toolName}: refusing access to${target} — the path is on the sensitive list ${why}.`;
}

/**
 * Decide any gated tool call. Unknown tool names are allowed: the middleware
 * only calls this for tools it gates, and a non-path tool has nothing to judge.
 */
export function decideToolAccess(
  scope: WorkerAccessScope,
  toolName: string,
  args: Record<string, unknown>,
): ToolAccessDecision {
  let verdict: ToolAccessDecision;
  if (toolName === 'bash') {
    verdict = evaluateBashAccess(scope, typeof args.command === 'string' ? args.command : '');
  } else if ((FILE_TOOL_NAMES as readonly string[]).includes(toolName)) {
    verdict = evaluateFileAccess(scope, toolName, args);
  } else {
    return { decision: 'allow', matchedRule: 'no-path' };
  }

  if (verdict.decision !== 'deny') return verdict;
  return {
    ...verdict,
    message: denyMessage(toolName, typeof args.path === 'string' ? args.path : undefined, verdict.access),
  };
}
