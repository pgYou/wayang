// The sensitive-path scan over raw command TEXT — the one scan the bash gate
// and the run_process gate share (single source: no second word list, no
// second sensitive list; the policy owns the list, `decidePath` the verdict).
//
// The bash gate needs it for a line its lexer could not finish (the structured
// candidate sweep never ran, but a sensitive hit must still outrank the bare
// "cannot parse" ask). run_process needs it because its argv is structured, not
// shell: every element is raw text a program will interpret — including
// elements that themselves spell a command (`bash -c "cat ~/.ssh/id_rsa"`) —
// so the same coarse word walk is the only shared semantic available.

import { decidePath, toToolDecision } from './access-verdict';
import { expandHome } from './home-expansion';
import type { ToolAccessDecision, WorkerAccessScope } from './types';

/**
 * Sensitive-hit scan over the words of a raw command text.
 *
 * Coarse ON PURPOSE, and it can only TIGHTEN a verdict, never loosen one: the
 * text is split on the delimiters the old bash extractor used (whitespace,
 * `=` for `--prefix=/path` shapes), stray quote characters are stripped, and
 * every word that starts with `/` or `~` is judged as a WRITE against the
 * sensitive list — the strictest direction, so a credential path cannot slip
 * through as "maybe just a read". Only a SENSITIVE verdict is returned; every
 * other word (benign absolute paths included) is silent.
 *
 * What comes back follows `sensitiveMode`: a refusal under `deny`, an ask
 * carrying `matchedEntry` under the default `ask` — exactly the decision the
 * bash fallback path produces, which is the point: same source, same
 * semantics.
 */
export function sensitiveWordsIn(
  scope: WorkerAccessScope,
  text: string,
): ToolAccessDecision | undefined {
  for (const raw of text.split(/[\s=]+/)) {
    const word = raw.replace(/^['"]+/, '').replace(/['"]+$/, '');
    if (!word.startsWith('/') && !word.startsWith('~')) continue;
    const expanded = expandHome(word);
    if (expanded.unresolvable) continue;
    const verdict = decidePath(scope, expanded.path, 'write');
    if (verdict.sensitive) return toToolDecision(verdict, 'write');
  }
  return undefined;
}
