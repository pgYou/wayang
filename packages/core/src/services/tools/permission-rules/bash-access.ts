// The bash gate proper: candidate sweep + destructive tier + `-c` / substitution recursion.

import { classifyRedirections, tokenizeShellLite } from '@/services/tools/shell-lexer';
import { decidePath, toToolDecision, withAskPaths } from './access-verdict';
import { evaluateCapabilityGate, redirectWriteScopeAsk } from './bash-capability';
import { segmentAccess, unanalyzedInnerCommand, unverifiedReadOnlyCommand } from './bash-classification';
import { isDangerousCommandLine } from './bash-head';
import { commandAccess, extractPathCandidates, type BashCandidate } from './bash-paths';
import { applyCdChain } from './cd-chain';
import { expandHome, expandHomeVars } from './home-expansion';
import { evaluateShellScripts, unanalyzedScriptFile } from './shell-script';
import { evaluateSubstitutions } from './substitutions';
import type { ToolAccessDecision, WorkerAccessScope } from './types';

/**
 * Sensitive-hit sweep for a command the lexer rejected.
 *
 * It can only TIGHTEN a verdict, never loosen one: it splits on the coarse
 * delimiters the old extractor used, treats every absolute / `~` word as a
 * WRITE and returns only when the policy says the word is on the sensitive
 * list. The mode decides what that means: `sensitiveMode: 'deny'` refuses the
 * command, `ask` (default) escalates it carrying the matched entry. Either way
 * a syntactically broken line (`tee ~/.ssh/authorized_keys "x`) does not
 * degrade to a bare "cannot parse" ask that hides WHY it matters.
 */
function fallbackSensitiveHit(
  scope: WorkerAccessScope,
  expandedCommand: string,
): ToolAccessDecision | undefined {
  for (const raw of expandedCommand.split(/[\s=]+/)) {
    const word = raw.replace(/^['"]+/, '').replace(/['"]+$/, '');
    if (!word.startsWith('/') && !word.startsWith('~')) continue;
    const expanded = expandHome(word);
    if (expanded.unresolvable) continue;
    const verdict = decidePath(scope, expanded.path, 'write');
    if (verdict.sensitive) return toToolDecision(verdict, 'write');
  }
  return undefined;
}

/**
 * Decide a bash command.
 *
 * The command string is the unit of execution, so every extractable path
 * candidate is judged separately: a candidate that asks makes the WHOLE line
 * ask (a benign `cat` in the same line cannot launder a sensitive `rm` into a
 * silent run), and under `sensitiveMode: 'deny'` one denied candidate refuses
 * it. A candidate carries the access its OWN segment justifies: `write` for a
 * write verb / redirection segment, `read` when the segment's head command is on
 * the command table's `read` capability, `unknown` for everything the gate has not been taught
 * (the strict mode: "inside home" alone never justifies a write either).
 *
 * The read classification does NOT widen what runs silently: the policy still
 * judges each path, and a policy allow that rests solely on "reads inside home"
 * arrives as the policy's `read-within-home` ask (`allowReadWithinHome: false`) — the same narrowing
 * `evaluateFileAccess` applies to file tools. Only the DIRECTION changes, from
 * `unknown` (which could not even reach that rule) to a named `read`.
 *
 * Ordering: a hard refusal (only reachable under `sensitiveMode: 'deny'`, from
 * the candidate sweep or the `cd` slice) → destructive-command tier → a shell
 * `-c` script judged by these same rules (see `evaluateShellScripts`) → dynamic
 * constructs (a command substitution that is not read-only, an output
 * redirection into a real file, a command the lexer cannot parse) → the
 * read-only-unverified escalation (a table command that failed its deferred
 * condition) → the `cd` slice's verdict for a chain that lands somewhere it may
 * not go (see `applyCdChain`, its `askPaths` dropped when segments follow the
 * asking `cd`) → the #51 fail-closed tier for a shape that runs an unanalyzed
 * inner command (see `unanalyzedInnerCommand` / `unanalyzedScriptFile`) →
 * remaining `ask` candidates (a sensitive ask first, then the ordinary ones) →
 * the capability gate (unknown verbs, exec / network / dynamic constructs) →
 * allow.
 * A hard refusal therefore outranks the destructive-command heuristic, and a
 * sensitive `ask` carries its hit into the approval request.
 *
 * Fallback when the command yields NO path candidate (`ls -la`, `npm test`,
 * `sed -n 1,10p src/cli.ts`): there is nothing for the policy to judge, so the
 * historic rule applies — a dangerous command still asks, anything else runs.
 * The exceptions are the two fail-closed escalations above: a table command
 * that failed its deferred condition asks because its "this only reads"
 * promise could not be verified, and a #51 shape asks because an inner command
 * it runs was never analyzed (`xargs`, `find -exec`, `eval`, `cd && ...`, a
 * script file, a compound keyword) — neither may rest on a silent allow.
 * Relative spellings are never candidates, so the sensitive list cannot see
 * them; they are confined by the task workspace (the shell's cwd), as before.
 * The ONE exception is a resolved `cd` chain: where the shell ends up is judged
 * (see `applyCdChain`), which is exactly what confines those relative spellings.
 *
 * Discard redirections (`> /dev/null`, `2>&1`) and read-only command
 * substitutions are exempt from the dynamic tier — see `evaluateSubstitutions`
 * and `classifyRedirections`.
 */
export function evaluateBashAccess(scope: WorkerAccessScope, command: string): ToolAccessDecision {
  return evaluateBashCommand(scope, command, 0);
}

/**
 * The recursive body of `evaluateBashAccess`. `depth` counts how many command
 * substitutions deep this command sits: the outer command is 0, so
 * `$(cat $(echo x))` reaches 2 and a sixth nested `$(` asks instead of being
 * followed any further.
 */
export function evaluateBashCommand(
  scope: WorkerAccessScope,
  command: string,
  depth: number,
): ToolAccessDecision {
  // `$HOME` / `${HOME}` are expanded BEFORE lexing so the concrete path the
  // shell would open is what gets judged (and the sensitive list can see it).
  const expandedCommand = expandHomeVars(command);

  const tokenized = tokenizeShellLite(expandedCommand);
  if (!tokenized.ok) {
    // A command the lexer cannot finish is never a silent allow, and a
    // sensitive hit outranks parseability: it is carried as an ask (with the
    // entry named) or refused, according to `sensitiveMode`.
    const hit = fallbackSensitiveHit(scope, expandedCommand);
    if (hit) return hit;
    return {
      decision: 'ask',
      matchedRule: 'dynamic-shell',
      reason: `could not parse the shell command (${tokenized.error})`,
    };
  }

  // The `cd` slice: a leading run of literal `cd <dir>` segments chained ONLY by
  // `&&` is walked with a local cwd CURSOR (see `applyCdChain`), and each target
  // is judged as a read against the scope it lands in. Consumed segments drop
  // out of the analysis below, so the rest of the line is judged exactly as
  // before — against the directory the shell will actually be in. The verdict
  // for a target that lands elsewhere is an ASK carrying its own reason (or, in
  // `sensitiveMode: 'deny'`, the policy's refusal). Nothing here can loosen a
  // judgement: shapes the slice does not recognize (`cd -`, `cd $X`, `(cd …`,
  // `cd a; cd b`, pushd/popd) are left untouched for the #51 fallback.
  const cdChain = applyCdChain(scope, tokenized.segments);
  if (cdChain.decision?.decision === 'deny') return cdChain.decision;
  const cdAsk = cdChain.decision?.decision === 'ask' ? cdChain.decision : undefined;

  const segments = cdChain.segments;
  const redirections = classifyRedirections(segments);

  const candidates: BashCandidate[] = [];
  let hasUnresolvableHome = false;
  for (const candidate of extractPathCandidates(segments)) {
    const expanded = expandHome(candidate.path);
    if (expanded.unresolvable) {
      hasUnresolvableHome = true;
      continue;
    }
    candidates.push({ ...candidate, path: expanded.path });
  }

  let firstAsk: ToolAccessDecision | undefined;
  let firstAllow: ToolAccessDecision | undefined;
  // A sensitive hit asks with a REASON the controller can act on (a named
  // credential location), while an ordinary out-of-scope ask says only "some
  // path is outside the scope". So a sensitive ask is kept apart and wins over
  // an earlier, vaguer one: `cp notes.md ~/.aws/credentials` must report
  // `.aws`, not the first candidate's `outside-all`. It never turns an ask into
  // an allow, so the boundary is unchanged.
  let sensitiveAsk: ToolAccessDecision | undefined;
  // Every candidate path this call asks about. One approval covers ONE path
  // (the task approval memory keys grants per `direction:path`), so the verdict
  // has to name all of them: `cat /etc/a /etc/b` asks for two grants, and a
  // reuse decision is only valid when BOTH are already held.
  const askPaths: string[] = [];
  for (const candidate of candidates) {
    const verdict = decidePath(scope, candidate.path, candidate.access);
    if (verdict.decision === 'deny') return toToolDecision(verdict, candidate.access);
    // A home read arrives as the policy's `read-within-home` ask already
    // (`allowReadWithinHome: false` on decidePath), so the map below needs no
    // post-hoc narrowing — an ask is kept as the ask it is, an allow as is.
    const narrowed = withAskPaths(toToolDecision(verdict, candidate.access));
    if (narrowed.decision === 'ask') {
      const ask: ToolAccessDecision = {
        ...narrowed,
        ...(candidate.reason !== undefined && { reason: candidate.reason }),
      };
      const askingPath = narrowed.resolvedPath ?? candidate.path;
      if (!askPaths.includes(askingPath)) askPaths.push(askingPath);
      if (ask.sensitive === true) sensitiveAsk ??= ask;
      else firstAsk ??= ask;
    } else firstAllow ??= narrowed;
  }

  // The command as a whole is audited under the STRICTEST access its candidates
  // justify (see `commandAccess`); the verdict above still judged each
  // candidate on its OWN access, so a `cat` next to a `tee` is not a write.
  // With no candidate at all (`ls -la`, `git status`) the direction comes from
  // the segments themselves: a wholly read-only line reports `read`.
  const lineAccess =
    candidates.length > 0
      ? commandAccess(candidates)
      : segments.length > 0 && segments.every((segment) => segmentAccess(segment) === 'read')
        ? 'read'
        : 'unknown';
  // The asking paths are attached only to the path-candidate asks. The
  // escalations below (`dangerous-bash`, `dynamic-shell`, `home-other-user`)
  // are NOT "one path, once" decisions and therefore carry none — the approval
  // memory must not reuse a grant for them.
  if (sensitiveAsk) {
    sensitiveAsk = { ...sensitiveAsk, access: lineAccess, ...(askPaths.length > 0 && { askPaths }) };
  }
  if (firstAsk) firstAsk = { ...firstAsk, access: lineAccess, ...(askPaths.length > 0 && { askPaths }) };
  if (firstAllow) firstAllow = { ...firstAllow, access: lineAccess };

  // A hard refusal (above; only under `sensitiveMode: 'deny'`) outranks
  // everything. Then the destructive tier, read at the command position of
  // every segment (see `isDangerousSegment`) — the same position the path rules
  // use, so a wrapper prefix cannot launder the verb.
  if (isDangerousCommandLine(segments)) {
    // Still an approval: the destructive-command rule does not decide what the
    // command does to its targets, so `matchedRule` stays `dangerous-bash`. The
    // candidate sweep may ALREADY have found a sensitive hit (`sudo cat
    // ~/.ssh/id_rsa` names `.ssh`) — dropping it would hide from the controller
    // that the command is dangerous AND touches a credential directory, so the
    // hit fields are carried over.
    //
    // Semantic choice for the conflicting flag: `sensitive` here means "this
    // call touches a sensitive-list entry", while the ORIGIN of the verdict
    // stays in `matchedRule` (`dangerous-bash`). Consumers (approval
    // description, signal payload, TUI) key the hit block off `sensitive`, and
    // a dangerous command that hits `.ssh` must show that block too.
    const hit = sensitiveAsk ?? (firstAsk?.matchedEntry !== undefined ? firstAsk : undefined);
    return {
      decision: 'ask',
      matchedRule: 'dangerous-bash',
      access: lineAccess,
      ...(hit !== undefined && {
        matchedEntry: hit.matchedEntry,
        matchedSource: hit.matchedSource,
        resolvedPath: hit.resolvedPath,
        sensitive: true,
      }),
    };
  }

  // A shell `-c` script is the real command: `bash -c 'cat ~/.ssh/id_rsa'` is
  // judged as the `cat` it runs, not as the `bash` it spells. The inner verdict
  // is merged as the stricter one (`deny` > `ask` > `allow`).
  const shellScript = evaluateShellScripts(scope, segments, depth);
  if (shellScript) return shellScript;

  // Command substitution: the inner command is judged by the same rules
  // (recursively), so `$(cat /etc/passwd)` asks for the path and
  // `$(command -v waya)` does not ask at all.
  const substitution = evaluateSubstitutions(scope, segments, depth);
  if (substitution) return substitution;

  // A redirection whose target cannot be resolved statically asks.
  if (redirections.unresolved !== undefined) {
    return {
      decision: 'ask',
      matchedRule: 'dynamic-shell',
      reason: `output redirection target cannot be determined statically (${redirections.unresolved})`,
    };
  }

  // A redirection into a real file (#51 layer 2): the write is allowed exactly
  // when every RELATIVE target resolves inside the workspace — a target that
  // escapes it asks with the write-scope rule. Absolute / `~` targets were
  // already judged as path candidates above, so only the relative spellings —
  // the ones the candidate sweep never sees — are judged here.
  if (redirections.writeTargets.length > 0 && !firstAsk && !sensitiveAsk) {
    const scopeAsk = redirectWriteScopeAsk(
      scope,
      redirections.writeTargets,
      cdChain.cwd ?? scope.workspace,
    );
    if (scopeAsk) return { ...scopeAsk, access: lineAccess };
  }

  // Another user's home cannot be resolved — ask, never a silent allow. The
  // reason is surfaced in the approval request so the controller knows WHY.
  if (hasUnresolvableHome) {
    return {
      decision: 'ask',
      matchedRule: 'home-other-user',
      reason: "`~user` names another user's home directory, which cannot be resolved safely",
    };
  }

  if (sensitiveAsk) return sensitiveAsk;

  // A read-only-table command whose deferred condition failed (`sed -f`, a
  // script that executes or writes): the line LOOKS like a reader, and that is
  // exactly what could not be proven. It asks even with no path candidate
  // at all (relative operands only) and even when every candidate sits inside the
  // workspace — an allow must never rest on a verification that failed. The
  // tiers above keep their priority (a sensitive hit still names its entry, a
  // destructive command still reports `dangerous-bash`), a write segment was
  // already settled as a write inside `classifySegment`, and the ask carries
  // no `askPaths`: it is about the command, not one path, so the task
  // approval memory (issue #46) can never cover it with an old grant.
  const unverifiedCommand = unverifiedReadOnlyCommand(segments);
  if (unverifiedCommand !== undefined) {
    return {
      decision: 'ask',
      matchedRule: 'read-only-unverified',
      reason:
        `\`${unverifiedCommand}\` is on the read-only command table, but its script or arguments ` +
        'cannot be verified as read-only — controller approval is required',
      // Never audited as a read: read-only-ness is exactly what failed to
      // verify. A candidate-proven write keeps its direction.
      access: lineAccess === 'write' ? 'write' : 'unknown',
    };
  }

  // #51 layer 1 — a shape that runs an inner command this gate never analyzes
  // (xargs, find -exec / -execdir / -ok, eval, a `cd` shape, a script file, a
  // compound keyword). Computed here because BOTH returns below need it.
  const innerShape = unanalyzedInnerCommand(segments) ?? unanalyzedScriptFile(segments);

  // The `cd` slice's own verdict, after every path- and command-level tier
  // above: the chain reached a directory that is sensitive, readable-but-not-
  // silent, or outside the scope, so the whole line asks with a reason naming
  // the cd target and the path it resolves to. It outranks the #51 fallback on
  // purpose — the shape IS a `cd <dir> && …` chain, and "outside the allowed
  // scope" is the actionable answer, not "this runs an inner command". But the
  // slice judged only the TARGET, never the commands after it, so when
  // segments follow the asking `cd` the ask drops its `askPaths`: the
  // approval memory (issue #46) must not reuse an old read grant to run the
  // unjudged rest of the line.
  if (cdAsk) {
    if (innerShape === undefined) return cdAsk;
    const cdAskWithoutPaths = { ...cdAsk };
    delete cdAskWithoutPaths.askPaths;
    return cdAskWithoutPaths;
  }

  // The layer-1 ask itself. It outranks the remaining path-candidate asks: a
  // 0.9.7 regression let `firstAsk` return first carrying `askPaths`, so ONE
  // pre-granted read of the outer command's path silently covered the
  // unanalyzed inner command (`find <dir> | xargs rm -f` ran without asking).
  // The ask carries no `askPaths` — it is about the command, not one path, so
  // the approval memory can never cover it with an old grant.
  if (innerShape !== undefined) {
    return {
      decision: 'ask',
      matchedRule: 'unknown-capability',
      reason: `${innerShape} runs an inner command this gate does not analyze — controller approval is required (fail-closed, issue #51)`,
      access: lineAccess,
    };
  }

  if (firstAsk) return firstAsk;

  // #51 layer 2 — the capability gate. The historic "no path candidate →
  // allow" fallback is gone: a line runs silently only when every segment sits
  // in a capability table AND its targets stay in scope (reads inside the
  // allowed directories, writes inside the workspace). Exec / network /
  // dynamic constructs and unknown verbs ask, naming the capability class (the
  // unanalyzed-inner-command shapes were checked above).
  const capabilityAsk = evaluateCapabilityGate(scope, segments, cdChain.cwd ?? scope.workspace);
  if (capabilityAsk) return { ...capabilityAsk, access: lineAccess };

  if (firstAllow) return firstAllow;
  // No candidate to judge: the line is a verified read or a write whose
  // targets all landed inside the workspace — allow, still reporting the
  // direction its segments justify for the audit trail.
  return { decision: 'allow', matchedRule: 'no-path', access: lineAccess };
}
