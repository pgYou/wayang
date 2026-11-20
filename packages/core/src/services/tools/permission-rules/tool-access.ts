// Top-level tool dispatch: routes a gated call to the bash or file gate, attaches the denial message.

import { resolve } from 'node:path';
import type { AccessMode } from '@/infra/permission/policy';
import { evaluateBashAccess } from './bash-access';
import { decidePath, toToolDecision } from './access-verdict';
import { evaluateFileAccess, FILE_TOOL_NAMES } from './file-access';
import { expandHome } from './home-expansion';
import { sensitiveWordsIn } from './sensitive-scan';
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
 * The argv a run_process call wants to spawn, verbatim — quoted as a JSON
 * array so argument boundaries cannot be misread in the approval request.
 */
function runProcessArgv(args: Record<string, unknown>): string {
  if (
    Array.isArray(args.command) &&
    args.command.length > 0 &&
    args.command.every((part) => typeof part === 'string')
  ) {
    return JSON.stringify(args.command);
  }
  return '(missing or invalid command argv)';
}

/**
 * Decide a run_process call.
 *
 * The baseline is unchanged: run_process executes arbitrary code, so it asks
 * EVERY time — no cwd, argv or workspace location can make it silent, there
 * are no askPaths on purpose (an approval is a one-call decision, never a
 * standing grant the task approval memory could reuse), and the reason carries
 * the argv verbatim so the controller approves exactly what it read.
 *
 * Two hard refusals sit in front of that baseline (a deny outranks the ask):
 *
 *   1. Sensitive list — argv raw text and the resolved cwd run through the
 *      SAME scan the bash gate uses (`sensitiveWordsIn` / `decidePath`, no
 *      second list). A hit refuses under `sensitiveMode: 'deny'` exactly like
 *      `cat ~/.ssh/id_rsa` would in bash, instead of being downgraded to the
 *      baseline ask; under the default `ask` mode the hit keeps the ask but
 *      carries `matchedEntry` into the approval (the audit trail must not
 *      lose it).
 *   2. cwd scope — the process runs somewhere, and that somewhere must be the
 *      task workspace or one of the allowed directories (task / config
 *      allowedDirs, auto-allow roots — whatever the policy allows as a WRITE
 *      scope). A cwd outside them is refused outright, not asked about: the
 *      gate cannot judge what the process does from there.
 *
 * What this gate cannot do is static: the program's own runtime side effects
 * (writes or network beyond argv words) are invisible to it — which is
 * exactly why the baseline stays a per-call approval. See the tool
 * description in run-process.ts.
 */
function evaluateRunProcessAccess(
  scope: WorkerAccessScope,
  args: Record<string, unknown>,
): ToolAccessDecision {
  const argv =
    Array.isArray(args.command) && args.command.every((part) => typeof part === 'string')
      ? (args.command as string[])
      : undefined;

  // Sensitive argv words first. Every element is scanned as raw text (the
  // same word walk bash uses), so an element that itself spells a command —
  // `bash -c "cat ~/.ssh/id_rsa"` — is caught too.
  if (argv !== undefined) {
    for (const element of argv) {
      const hit = sensitiveWordsIn(scope, element);
      if (hit === undefined) continue;
      if (hit.decision === 'deny') {
        // The scan judges every absolute / `~` word with the STRICTEST
        // direction (write) on purpose — that direction is a scan artifact,
        // not the operation's real one (`cat` READS the credential). The
        // refusal therefore claims no direction (denyMessage's neutral
        // phrasing): the verdict's `access` field keeps the strict audit
        // value, the text stays consistent with it by not asserting the
        // opposite direction (review round 3, C4).
        return { ...hit, message: denyMessage('run_process', element) };
      }
      // ask mode: the baseline ask enriched with the hit (matchedEntry).
      return hit;
    }
  }

  const rawCwd = args.cwd;
  if (typeof rawCwd === 'string' && rawCwd !== '') {
    const expanded = expandHome(rawCwd);
    // `~user` cannot be resolved, so it cannot be proven in scope — refuse.
    if (expanded.unresolvable) {
      return {
        decision: 'deny',
        matchedRule: 'home-other-user',
        message:
          `[ERROR] run_process: cwd "${rawCwd}" names another user's home directory, ` +
          'which cannot be resolved — refusing (the process would run outside the sanctioned scope)',
      };
    }
    const resolved = resolve(scope.workspace, expanded.path);
    const verdict = decidePath(scope, resolved, 'write');
    if (verdict.sensitive) {
      const hit = toToolDecision(verdict, 'write');
      if (hit.decision === 'deny') {
        return { ...hit, message: denyMessage('run_process', rawCwd, 'write') };
      }
      return hit;
    }
    // An allow here means the policy puts the cwd inside the workspace /
    // allowedDirs / configured roots (a write-scope allow — reads inside home
    // never qualify for this access). Anything else is out of scope.
    if (verdict.decision !== 'allow') {
      return {
        decision: 'deny',
        matchedRule: 'write-scope',
        resolvedPath: verdict.resolvedPath,
        message:
          `[ERROR] run_process: cwd "${rawCwd}" resolves to ${verdict.resolvedPath}, outside the ` +
          'task workspace and its allowed directories — refusing (the process would run outside the sanctioned scope)',
      };
    }
  }

  return {
    decision: 'ask',
    matchedRule: 'exec-capability',
    reason: `run_process spawns a process directly (no shell) — controller approval is required: ${runProcessArgv(args)}`,
  };
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
  } else if (toolName === 'run_process') {
    // Returns directly: the baseline ask carries its own reason, and every
    // deny already carries its (disclosure-safe) message.
    return evaluateRunProcessAccess(scope, args);
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
