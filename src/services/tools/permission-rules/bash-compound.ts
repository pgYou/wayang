// #86 — wrapper / compound-command decomposition for the bash capability gate.
//
// The per-segment gate judges every segment independently and carries only a
// cwd cursor. These helpers run BEFORE it and unfold the shapes whose real
// command sits behind a prefix:
//
//   - `R=/path; git -C $R status` — a literal assignment prefix is harmless and
//     its value is substituted into the rest of the line;
//   - `timeout 30 git status` / `watch -n 2 git status` — the launcher prefix is
//     stripped so the inner command is judged by the ordinary tiers (destructive,
//     shell `-c`, substitutions, capability);
//   - `find . | xargs grep x` — the xargs prefix is replaced by its inner
//     command; a placeholder / `-I` / `-n` / `-L` inner operand is not knowable
//     statically and asks;
//   - `for f in a b; do cat $f; done` — a literal loop is expanded and every
//     iteration is judged recursively;
//   - `diff <(git ls-tree -r HEAD) …` — process substitutions are judged like
//     command substitutions (inner ask/deny wins).
//
// Every parse failure asks. Nothing here can turn an ask into an allow: the
// helpers either hand the gate a MORE explicit command to judge, or return the
// fail-closed ask themselves.

import {
  CMDSUBST_PLACEHOLDER,
  tokenizeShellLite,
  type ShellSegment,
  type ShellSubstitution,
  type ShellToken,
  type ShellWord,
} from '@/services/tools/shell-lexer';
import { evaluateBashCommand } from './bash-access';
import { headCommand, headOfWords, isDestructiveTierHead } from './bash-head';
import { commandEntry } from './command-tables';
import { MAX_CMDSUBST_DEPTH } from './substitutions';
import type { ToolAccessDecision, WorkerAccessScope } from './types';

/** A leading shell variable assignment (`FOO=1`), not a command word. */
const ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Characters that make an assignment VALUE unsuitable for literal expansion:
 * a parameter / command substitution (`$`, backtick, the lexer's placeholder)
 * or a glob metacharacter — none names a value this gate could substitute
 * without guessing what the shell produces.
 */
const NON_LITERAL_VALUE_CHARS = /[$`*?[\]{}]/;

/** Options whose NEXT word is the option's value. */
const TIMEOUT_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-k', '--kill-after', '-s', '--signal',
]);
const TIMEOUT_FLAGS: ReadonlySet<string> = new Set([
  '--foreground', '-v', '--verbose', '--preserve-status',
]);
const WATCH_VALUE_OPTIONS: ReadonlySet<string> = new Set(['-n', '--interval']);
const WATCH_FLAGS: ReadonlySet<string> = new Set([
  '-d', '--differences', '-g', '--chgexit', '-t', '--no-title', '-b', '--beep',
  '-c', '--color', '-e', '--errexit', '-q',
]);

/** xargs options that consume the NEXT word. */
const XARGS_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-a', '--arg-file', '-d', '--delimiter', '-E', '--eof', '-I', '--replace',
  '-L', '--max-lines', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars',
]);
const XARGS_FLAGS: ReadonlySet<string> = new Set([
  '-0', '--null', '-r', '--no-run-if-empty', '-t', '--verbose', '-p', '--interactive',
  '-x', '--exit', '-o', '--open-tty',
]);
/**
 * xargs options that make the inner command's OPERANDS unknowable (a
 * placeholder, one argument per line, or an argument file): the inner command
 * cannot be judged as written, so the line asks.
 */
const XARGS_DYNAMIC_OPTIONS: ReadonlySet<string> = new Set([
  '-I', '--replace', '-L', '--max-lines', '-n', '--max-args', '-a', '--arg-file',
]);

/**
 * Verbs whose FIRST operand is not a path: `grep` / `rg` take their pattern
 * there and `sed` its script, so `xargs grep x` names no file at all — the
 * files come from stdin. That first word is skipped when looking for a literal
 * path operand.
 */
const XARGS_NON_PATH_FIRST_OPERAND: ReadonlySet<string> = new Set(['grep', 'rg', 'sed']);

/**
 * Options of those read verbs whose NEXT word is the option's VALUE (review
 * round 3, C1): without this the value eats the pattern slot, the pattern
 * slides into the operand position and the no-literal-operand ask never fires
 * (`xargs grep -A 3 pat` allowed while `xargs grep pat` asked).
 *
 * HEURISTIC, kept minimal on purpose — it covers only the gate's read-verb
 * family and their common value-taking options, not full getopt semantics: an
 * option outside this table still lets its value be read as the pattern /
 * operand, and a glued short value (`-A3`, `-epat`) or a long `--opt=value`
 * form is already a single word the plain option skip handles. A missing
 * entry can only mis-shape the operand list, which the ordinary gate still
 * judges per path — fail-closed on the ask side.
 */
const XARGS_READ_VERB_VALUE_OPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    'grep',
    new Set([
      '-A', '-B', '-C', '-m', '-e', '-f',
      '--after-context', '--before-context', '--context', '--max-count', '--regexp', '--file',
      '--include', '--exclude', '--exclude-dir',
    ]),
  ],
  [
    'rg',
    new Set([
      '-A', '-B', '-C', '-m', '-e', '-f',
      '--after-context', '--before-context', '--context', '--max-count', '--regexp', '--file',
      '--glob',
    ]),
  ],
  ['sed', new Set(['-e', '-f', '--expression', '--file'])],
]);

/**
 * Value options that SUPPLY the pattern / script themselves (`grep -e <pat>`):
 * after one of these the positional pattern slot is already taken, so the next
 * non-option word is a file operand, not the pattern.
 */
const XARGS_READ_VERB_PATTERN_OPTIONS: ReadonlySet<string> = new Set(['-e', '--regexp', '--expression']);

/**
 * The literal words of an xargs-expanded inner command that could name a path.
 * Value options and their values are skipped first, then (for the verbs above)
 * the positional pattern / script word; whatever remains is an operand.
 */
function xargsLiteralPathOperands(words: readonly string[]): string[] {
  const head = headOfWords(words);
  const operands: string[] = [];
  let patternSeen = false;
  const verb = head?.command ?? '';
  const valueOptions = XARGS_READ_VERB_VALUE_OPTIONS.get(verb);
  const list = head?.words ?? words;
  for (let i = 1; i < list.length; i += 1) {
    const word = list[i] as string;
    if (word.startsWith('-')) {
      // A known value option consumes the NEXT word too (its value).
      if (valueOptions !== undefined && valueOptions.has(word) && i + 1 < list.length) {
        i += 1;
        if (XARGS_READ_VERB_PATTERN_OPTIONS.has(word)) patternSeen = true;
      }
      continue;
    }
    if (!patternSeen && XARGS_NON_PATH_FIRST_OPERAND.has(verb)) {
      patternSeen = true;
      continue;
    }
    operands.push(word);
  }
  return operands;
}

/** One word token plus its index in the segment's token list. */
interface IndexedWord {
  word: ShellWord;
  tokenIndex: number;
}

/** The word tokens of a segment, in source order (redirections dropped). */
function indexedWords(segment: ShellSegment): IndexedWord[] {
  const words: IndexedWord[] = [];
  for (let i = 0; i < segment.tokens.length; i += 1) {
    const token = segment.tokens[i];
    if (token !== undefined && token.kind === 'word') words.push({ word: token.word, tokenIndex: i });
  }
  return words;
}

function ask(matchedRule: ToolAccessDecision['matchedRule'], reason: string): ToolAccessDecision {
  return { decision: 'ask', matchedRule, reason };
}

/** `NAME=value` → `{ name, value }`; anything else → undefined. */
function assignmentOf(word: string): { name: string; value: string } | undefined {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(word);
  return match === null ? undefined : { name: match[1] as string, value: match[2] as string };
}

/** Expand the KNOWN variables in a word; an unknown `$X` stays as written. */
function substituteText(text: string, variables: ReadonlyMap<string, string>): string {
  if (variables.size === 0) return text;
  return text.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (match: string, braced: string | undefined, plain: string | undefined) => {
      const name = braced ?? plain;
      const value = name === undefined ? undefined : variables.get(name);
      return value === undefined ? match : value;
    },
  );
}

function substituteWord(word: ShellWord, variables: ReadonlyMap<string, string>): ShellWord {
  const text = substituteText(word.text, variables);
  return text === word.text ? word : { ...word, text };
}

function substituteSegment(segment: ShellSegment, variables: ReadonlyMap<string, string>): ShellSegment {
  // The command word keeps its identity as written: `X=rm; $X -rf ./src` stays
  // a dynamic command word (the existing dynamic-shell verdict), while
  // `R=/path; git -C $R status` gets its ARGUMENT expanded. Expanding the
  // command word would relabel a dynamic construct as a known verb.
  const head = headCommand(segment);
  let commandSkipped = false;
  const tokens = segment.tokens.map((token): ShellToken => {
    if (token.kind === 'word') {
      if (!commandSkipped && head !== undefined && token.word.text === head.command) {
        commandSkipped = true;
        return token;
      }
      return { kind: 'word', word: substituteWord(token.word, variables) };
    }
    if (token.redirect.target === undefined) return token;
    return {
      kind: 'redirect',
      redirect: { ...token.redirect, target: substituteWord(token.redirect.target, variables) },
    };
  });
  return { ...segment, tokens };
}

/** What a wrapper helper hands back to the caller. */
export interface CompoundResult {
  /** The segments the ordinary gate still has to judge. */
  segments: readonly ShellSegment[];
  /** Present when the helper already decided the command. */
  decision?: ToolAccessDecision;
}

/**
 * A literal assignment prefix (`R=/path; …`, `R=/path cmd`, `X=$(cmd); …`).
 *
 * The assignment itself runs nothing, so it is dropped from the analysis; a
 * LITERAL value is remembered and substituted into the remaining words, so
 * `git -C $R status` is judged as `git -C /path status`. A value carrying a
 * command substitution is judged recursively (inner ask/deny wins); any other
 * dynamic value is simply not recorded (the `$X` it leaves behind is judged by
 * the ordinary tiers). `export` / array assignments are not supported and ask
 * explicitly — fail closed.
 */
export function applyAssignmentPrefix(
  scope: WorkerAccessScope,
  segments: readonly ShellSegment[],
  depth: number,
): CompoundResult {
  // `export NAME=value` and friends are a different shape from a bare
  // assignment: the verb itself is the command, and this gate cannot tell what
  // else it does with the variable. Report the unsupported form explicitly.
  for (const segment of segments) {
    const head = headCommand(segment);
    if (head === undefined || !['export', 'declare', 'typeset', 'local', 'readonly', 'unset'].includes(head.command)) {
      continue;
    }
    return {
      segments,
      decision: ask(
        'unknown-capability',
        `\`${head.command}\` variable assignment is not supported by the bash capability gate — ` +
          'controller approval is required (fail-closed)',
      ),
    };
  }

  const variables = new Map<string, string>();
  let index = 0;
  let changed = false;

  while (index < segments.length) {
    const segment = segments[index];
    if (segment === undefined) break;
    if (segment.tokens.some((token) => token.kind !== 'word')) break;
    const words = indexedWords(segment);
    if (words.length === 0) break;

    let split = 0;
    while (split < words.length && ASSIGNMENT_PATTERN.test(words[split]?.word.text ?? '')) split += 1;
    if (split === 0) break;
    // A pipeline operator makes the assignment a pipeline STAGE, not a prefix;
    // leave the whole shape to the ordinary gate instead of dropping a stage.
    if (
      split === words.length &&
      segment.operator !== undefined &&
      segment.operator !== ';' &&
      segment.operator !== '&&' &&
      segment.operator !== '&'
    ) {
      break;
    }
    changed = true;

    for (const entry of words.slice(0, split)) {
      const parsed = assignmentOf(entry.word.text);
      if (parsed === undefined) continue;
      if (parsed.value.startsWith('(')) {
        return {
          segments,
          decision: ask(
            'unknown-capability',
            'array assignment is not supported by the bash capability gate — controller approval is required (fail-closed)',
          ),
        };
      }
      // `X=$(cmd)` — judge the substituted command with the same rules.
      for (const substitution of entry.word.substitutions) {
        const verdict = evaluateBashCommand(scope, substitution.inner, depth + 1);
        if (verdict.decision === 'deny') return { segments, decision: verdict };
        if (verdict.decision === 'ask') {
          return {
            segments,
            decision: {
              ...verdict,
              reason:
                `assignment \`${parsed.name}=${substitution.raw}\` needs approval: ` +
                `${verdict.reason ?? verdict.matchedRule}`,
            },
          };
        }
      }
      if (NON_LITERAL_VALUE_CHARS.test(parsed.value)) continue; // dynamic: leave `$X` as written
      variables.set(parsed.name, substituteText(parsed.value, variables));
    }

    if (split === words.length) {
      // The whole segment was assignments: it runs nothing, drop it. `;`, `&&`
      // and `&` keep it a prefix; a `|` / `||` would make it part of a
      // pipeline and is left to the ordinary gate.
      const operator = segment.operator;
      index += 1;
      if (operator !== undefined && operator !== ';' && operator !== '&&' && operator !== '&') break;
      continue;
    }

    // Leading assignments inside a command segment (`R=/path git status`):
    // drop the assignment tokens and keep the command.
    const rest: ShellSegment = {
      ...segment,
      tokens: segment.tokens.slice(split),
    };
    return {
      segments: [rest, ...segments.slice(index + 1)].map((item) => substituteSegment(item, variables)),
    };
  }

  if (!changed) return { segments };
  return { segments: segments.slice(index).map((item) => substituteSegment(item, variables)) };
}

/** Is this a bare duration (`30`, `5s`, `1.5m`) rather than the inner command? */
function isDuration(word: string): boolean {
  return /^\d+(?:\.\d+)?[smhd]?$/.test(word);
}

/**
 * Index of the inner command in `words` (which starts at the launcher), or -1
 * when the launcher's own arguments cannot be read confidently.
 */
function launcherInnerStart(command: string, words: readonly string[]): number {
  let i = 1;
  while (i < words.length) {
    const word = words[i] as string;
    if (word.startsWith('--') && word.includes('=')) {
      const name = word.slice(0, word.indexOf('='));
      const allowed = command === 'timeout'
        ? TIMEOUT_VALUE_OPTIONS.has(name)
        : WATCH_VALUE_OPTIONS.has(name);
      if (!allowed) return -1;
      i += 1;
      continue;
    }
    if (command === 'timeout') {
      if (TIMEOUT_VALUE_OPTIONS.has(word)) {
        i += 2;
        continue;
      }
      if (TIMEOUT_FLAGS.has(word)) {
        i += 1;
        continue;
      }
    } else {
      if (WATCH_VALUE_OPTIONS.has(word)) {
        i += 2;
        continue;
      }
      if (WATCH_FLAGS.has(word) || /^-n\d+$/.test(word)) {
        i += 1;
        continue;
      }
    }
    if (word.startsWith('-')) return -1; // unknown option: leave the shape to the gate
    if (isDuration(word)) {
      i += 1;
      continue;
    }
    return i;
  }
  return -1;
}

/**
 * Strip `timeout <duration> …` / `watch -n <interval> …` so the inner command
 * is judged by the ordinary tiers (destructive, shell `-c`, substitutions,
 * capability). `nice` / `nohup` / `env` / `time` / `ionice` / `command` /
 * `exec` / `builtin` are already wrapper-marked in the command table and
 * skipped by `headCommand`; `script` / `su` / `setsid` / `ssh` deliberately
 * stay ask (privilege / network), so they are not unfolded here.
 *
 * An option this parser does not know leaves the segment untouched: the
 * ordinary gate then asks on the launcher itself — fail closed.
 */
export function unfoldLaunchers(segments: readonly ShellSegment[]): readonly ShellSegment[] {
  let changed = false;
  const result = segments.map((segment) => {
    const words = indexedWords(segment);
    let commandIndex = 0;
    while (
      commandIndex < words.length &&
      ASSIGNMENT_PATTERN.test(words[commandIndex]?.word.text ?? '')
    ) {
      commandIndex += 1;
    }
    const command = words[commandIndex]?.word.text;
    if (command !== 'timeout' && command !== 'watch') return segment;

    const inner = launcherInnerStart(command, words.slice(commandIndex).map((entry) => entry.word.text));
    if (inner < 0) return segment;
    const tokenIndex = words[commandIndex + inner]?.tokenIndex;
    if (tokenIndex === undefined) return segment;
    // A redirection before the inner command would be lost by the slice.
    if (segment.tokens.slice(0, tokenIndex).some((token) => token.kind === 'redirect')) return segment;

    changed = true;
    return {
      tokens: segment.tokens.slice(tokenIndex),
      ...(segment.operator !== undefined && { operator: segment.operator }),
    } as ShellSegment;
  });
  return changed ? result : segments;
}

/**
 * Replace an `xargs <cmd>` segment with its inner command, so the ordinary
 * gate judges that command (and the producer segments around it keep their own
 * verdicts). A placeholder / `-I` / `-n` / `-L` / `-a` shape cannot be judged
 * as written and asks explicitly; so does an option this parser does not know.
 */
export function unfoldXargs(segments: readonly ShellSegment[]): CompoundResult {
  let changed = false;
  const result: ShellSegment[] = [];

  for (const segment of segments) {
    const words = indexedWords(segment);
    let commandIndex = 0;
    while (
      commandIndex < words.length &&
      ASSIGNMENT_PATTERN.test(words[commandIndex]?.word.text ?? '')
    ) {
      commandIndex += 1;
    }
    // Only an xargs at the actual command position is unfolded. A wrapper
    // (`sudo xargs …`) stays: dropping it would launder the wrapper's verdict.
    if (words[commandIndex]?.word.text !== 'xargs') {
      result.push(segment);
      continue;
    }

    const xargsIndex = commandIndex;
    let i = xargsIndex + 1;
    let innerIndex = -1;
    while (i < words.length) {
      const word = words[i]?.word.text ?? '';
      if (XARGS_DYNAMIC_OPTIONS.has(word)) {
        return {
          segments,
          decision: ask(
            'unknown-capability',
            `xargs option "${word}" makes the inner command's operands unknowable — ` +
              'controller approval is required (fail-closed, issue #51)',
          ),
        };
      }
      if (word.startsWith('--') && word.includes('=')) {
        const name = word.slice(0, word.indexOf('='));
        if (XARGS_DYNAMIC_OPTIONS.has(name)) {
          return {
            segments,
            decision: ask(
              'unknown-capability',
              `xargs option "${name}" makes the inner command's operands unknowable — ` +
                'controller approval is required (fail-closed, issue #51)',
            ),
          };
        }
        if (!XARGS_FLAGS.has(name) && !XARGS_VALUE_OPTIONS.has(name)) {
          return {
            segments,
            decision: ask(
              'unknown-capability',
              `xargs option "${word}" is not supported by the bash capability gate — ` +
                'controller approval is required (fail-closed)',
            ),
          };
        }
        i += 1;
        continue;
      }
      if (XARGS_VALUE_OPTIONS.has(word)) {
        i += 2;
        continue;
      }
      if (XARGS_FLAGS.has(word)) {
        i += 1;
        continue;
      }
      if (word.startsWith('-')) {
        // A glued short value (`-n1`, `-I{}`): same rule as the split form.
        const name = word.slice(0, 2);
        if (XARGS_DYNAMIC_OPTIONS.has(name)) {
          return {
            segments,
            decision: ask(
              'unknown-capability',
              `xargs option "${name}" makes the inner command's operands unknowable — ` +
                'controller approval is required (fail-closed, issue #51)',
            ),
          };
        }
        if (XARGS_VALUE_OPTIONS.has(name)) {
          i += 1;
          continue;
        }
        return {
          segments,
          decision: ask(
            'unknown-capability',
            `xargs option "${word}" is not supported by the bash capability gate — ` +
              'controller approval is required (fail-closed)',
          ),
        };
      }
      innerIndex = i;
      break;
    }

    if (innerIndex < 0) {
      return {
        segments,
        decision: ask(
          'unknown-capability',
          'xargs was given without an inner command to judge — controller approval is required (fail-closed)',
        ),
      };
    }
    const innerWords = words.slice(innerIndex).map((entry) => entry.word.text);
    if (innerWords.some((word) => /\{[^}]*\}/.test(word))) {
      return {
        segments,
        decision: ask(
          'unknown-capability',
          'xargs placeholder "{}" makes the inner command\'s operands unknowable — ' +
            'controller approval is required (fail-closed, issue #51)',
        ),
      };
    }
    const tokenIndex = words[innerIndex]?.tokenIndex;
    if (tokenIndex === undefined) {
      result.push(segment);
      continue;
    }
    if (segment.tokens.slice(0, tokenIndex).some((token) => token.kind === 'redirect')) {
      result.push(segment);
      continue;
    }

    // #86 — the expanded inner verb is judged on its own. A destructive-tier
    // verb asks whatever its arity: its operands come from stdin, so the
    // `rm`-needs-an-operand condition would never fire even though the command
    // deletes whatever stdin names. A read / write verb with no literal operand
    // asks too — everything it touches arrives from stdin, so the gate cannot
    // make the outside-all call. (A literal operand keeps the ordinary gate.)
    //
    // DELIBERATE (0.9.9 walkthrough note): that makes `find . | xargs wc -l`
    // ask — `wc` is a read verb with no literal path operand of its own. This
    // is not an oversight to "fix": the files `wc` opens are whatever the
    // producer emits, so no static in-scope proof exists for them, and the
    // only shapes that may run silently are the ones whose targets the gate
    // could actually judge. An approval covers the call; the ask is the
    // boundary.
    const innerHead = headOfWords(innerWords);
    if (isDestructiveTierHead(innerWords)) {
      return {
        segments,
        decision: ask(
          'dangerous-bash',
          `xargs runs \`${innerHead?.command ?? innerWords[0] ?? '…'}\` with operands from stdin — ` +
            'controller approval is required (destructive command, fail-closed)',
        ),
      };
    }
    const innerEntry = commandEntry(innerHead?.command ?? '');
    if (
      innerEntry !== undefined &&
      (innerEntry.capability === 'write' || innerEntry.capability === 'read') &&
      xargsLiteralPathOperands(innerWords).length === 0
    ) {
      return {
        segments,
        decision: ask(
          'unknown-capability',
          `xargs runs \`${innerHead?.command ?? innerWords[0] ?? '…'}\` with no literal operand — ` +
            'its operands come from stdin, so the gate cannot judge what it touches — ' +
            'controller approval is required (fail-closed, issue #51)',
        ),
      };
    }

    changed = true;
    result.push({
      tokens: segment.tokens.slice(tokenIndex),
      ...(segment.operator !== undefined && { operator: segment.operator }),
    } as ShellSegment);
  }

  return { segments: changed ? result : segments };
}

/** A `for <var> in <literal words>; do <body>; done` loop. */
const FOR_LOOP_PATTERN =
  /^\s*for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([\s\S]*?)[\s;]+do\b([\s\S]*?)[\s;]+done\s*$/;

/**
 * Expand a LITERAL `for` loop and judge every iteration with the same rules.
 * The loop variable is substituted into the body; each resulting command is
 * judged recursively and the verdicts merge (deny > ask > allow).
 *
 * Anything non-literal — a glob, `$x`, a command substitution, an empty word
 * list, a nested `done`, a body this parser cannot read — asks explicitly.
 */
export function evaluateForLoop(
  scope: WorkerAccessScope,
  command: string,
  depth: number,
): ToolAccessDecision | undefined {
  if (!/^\s*for\s/.test(command)) return undefined;
  const match = FOR_LOOP_PATTERN.exec(command);
  if (match === null) {
    return {
      decision: 'ask',
      matchedRule: 'unknown-capability',
      reason:
        'the for loop could not be parsed into a literal `for <var> in <words>; do <body>; done` shape — ' +
        'controller approval is required (fail-closed)',
    };
  }
  const variable = match[1] as string;
  const wordsText = (match[2] as string).trim();
  const body = (match[3] as string).trim();
  if (body.length === 0 || /\bdone\b/.test(body)) {
    return {
      decision: 'ask',
      matchedRule: 'unknown-capability',
      reason:
        'the for loop body is empty or nested, which this gate cannot judge statically — ' +
        'controller approval is required (fail-closed)',
    };
  }

  // The word list must be literal: `$(…)`, `$x`, globs and quotes that hide a
  // command are all dynamic, so the iterations cannot be known.
  let words: string[];
  try {
    const tokenized = tokenizeForWords(wordsText);
    words = tokenized;
  } catch {
    return {
      decision: 'ask',
      matchedRule: 'unknown-capability',
      reason:
        'the for loop word list could not be parsed as literal words — controller approval is required (fail-closed)',
    };
  }
  if (words.length === 0) {
    return {
      decision: 'ask',
      matchedRule: 'unknown-capability',
      reason: 'the for loop has no literal words to iterate — controller approval is required (fail-closed)',
    };
  }

  let access: 'read' | 'write' | 'unknown' = 'unknown';
  for (const value of words) {
    const iteration = substituteLoopVariable(body, variable, value);
    const verdict = evaluateBashCommand(scope, iteration, depth + 1);
    if (verdict.decision === 'deny') return verdict;
    if (verdict.decision === 'ask') {
      return {
        ...verdict,
        reason: `for loop iteration \`${iteration}\` needs approval: ${verdict.reason ?? verdict.matchedRule}`,
      };
    }
    if (verdict.access === 'write') access = 'write';
    else if (verdict.access === 'read' && access !== 'write') access = 'read';
  }
  return { decision: 'allow', matchedRule: 'no-path', access };
}

/** Split a for-loop word list into literal words, rejecting anything dynamic. */
function tokenizeForWords(text: string): string[] {
  // Reuse the shell word scanner through the public lexer entry point so
  // quoting is removed exactly as the shell would.
  const tokenized = tokenizeShellLiteOrThrow(text);
  const words: string[] = [];
  for (const segment of tokenized) {
    if (segment.operator !== undefined) throw new Error('operator in word list');
    for (const token of segment.tokens) {
      if (token.kind !== 'word') throw new Error('redirect in word list');
      if (token.word.substitutions.length > 0) throw new Error('substitution in word list');
      const value = token.word.text;
      if (value.includes(CMDSUBST_PLACEHOLDER) || NON_LITERAL_VALUE_CHARS.test(value)) {
        throw new Error('dynamic word');
      }
      if (value.length > 0) words.push(value);
    }
  }
  return words;
}

function tokenizeShellLiteOrThrow(text: string): ShellSegment[] {
  // Lazy import shape: the lexer is a leaf module, so a static import is fine.
  const tokenized = tokenizeShellLite(text);
  if (!tokenized.ok) throw new Error(tokenized.error);
  return tokenized.segments;
}

/** Replace `$var` / `${var}` in a loop body with one literal value. */
function substituteLoopVariable(body: string, variable: string, value: string): string {
  const pattern = new RegExp(`\\$(?:\\{${variable}\\}|${variable})`, 'g');
  return body.replace(pattern, value);
}

/** Every process substitution in a lexed command line. */
function collectProcessSubstitutions(segments: readonly ShellSegment[]): ShellSubstitution[] {
  const found: ShellSubstitution[] = [];
  for (const segment of segments) {
    for (const token of segment.tokens) {
      const word = token.kind === 'word' ? token.word : token.redirect.target;
      if (word?.processSubstitutions !== undefined) found.push(...word.processSubstitutions);
    }
  }
  return found;
}

/**
 * Judge every `<(cmd)` / `>(cmd)` process substitution like a command
 * substitution: an inner deny refuses the line, an inner ask asks. Called
 * AFTER the capability gate so `bash <(true)` still reports its exec class
 * (the outer verb is what the controller acts on); a line whose outer verb is
 * a read reaches this tier with the inner command as the only thing left to
 * judge.
 */
export function evaluateProcessSubstitutions(
  scope: WorkerAccessScope,
  segments: readonly ShellSegment[],
  depth: number,
): ToolAccessDecision | undefined {
  const substitutions = collectProcessSubstitutions(segments);
  if (substitutions.length === 0) return undefined;
  if (depth + 1 > MAX_CMDSUBST_DEPTH) {
    return {
      decision: 'ask',
      matchedRule: 'dynamic-shell',
      reason: `process substitution nested deeper than ${MAX_CMDSUBST_DEPTH} levels`,
    };
  }
  for (const substitution of substitutions) {
    const inner = substitution.inner.trim();
    if (inner.length === 0) {
      return { decision: 'ask', matchedRule: 'dynamic-shell', reason: `empty process substitution ${substitution.raw}` };
    }
    const verdict = evaluateBashCommand(scope, inner, depth + 1);
    if (verdict.decision === 'deny') return verdict;
    if (verdict.decision === 'ask') {
      const detail = verdict.reason ?? (verdict.resolvedPath ? `target ${verdict.resolvedPath}` : verdict.matchedRule);
      return {
        decision: 'ask',
        matchedRule: 'dynamic-shell',
        reason: `process substitution ${substitution.raw} needs approval: ${detail}`,
        ...(verdict.resolvedPath !== undefined && { resolvedPath: verdict.resolvedPath }),
        ...(verdict.matchedEntry !== undefined && {
          matchedEntry: verdict.matchedEntry,
          matchedSource: verdict.matchedSource,
          sensitive: true,
        }),
      };
    }
  }
  return undefined;
}
