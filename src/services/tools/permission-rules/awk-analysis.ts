// #86 — static read-only analysis of awk program text.
//
// `awk` is an interpreter verb on the command table, so without this check every
// awk invocation asks as `exec-capability`. But the common shape — a small
// program that prints fields from a file — only reads. The program text is a
// mini-language; this module does NOT parse it, it rejects the shapes that can
// execute a command, read a file through `getline`, or write a file through a
// `print` / `printf` redirection. Anything it cannot locate (`-f prog.awk`) or
// that carries one of those shapes is not verified as a read: the segment stays
// `unknown` and the capability gate asks.

/**
 * awk options that consume the NEXT word as their value.
 *
 * The load / include family is deliberately NOT here: `-i` / `--include` /
 * `--load` are execution-capability entry points (`-i inplace` rewrites files
 * in place, and a load / include pulls in arbitrary awk code or a shared
 * library). They fall through to the unknown-option branch below and the
 * segment asks.
 */
const AWK_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-F', '-v', '-e', '-o',
  '--field-separator', '--assign', '--source',
]);

/**
 * The program texts of an `awk` invocation, or `undefined` when the program
 * cannot be located (`-f prog.awk`, an unknown option, no program at all).
 * `words` starts at `awk`.
 */
export function awkScriptsOf(words: readonly string[]): string[] | undefined {
  const scripts: string[] = [];
  for (let i = 1; i < words.length; i += 1) {
    const word = words[i] as string;
    // A program FILE cannot be read by this gate: unverifiable.
    if (word === '-f' || word === '--file' || word.startsWith('--file=')) return undefined;
    if (word === '-e' || word === '--source') {
      const program = words[i + 1];
      if (program === undefined) return undefined;
      scripts.push(program);
      i += 1;
      continue;
    }
    if (word.startsWith('--source=')) {
      scripts.push(word.slice('--source='.length));
      continue;
    }
    if (word.startsWith('--field-separator=') || word.startsWith('--assign=')) continue;
    if (AWK_VALUE_OPTIONS.has(word)) {
      i += 1; // the option's value is not the program
      continue;
    }
    // Glued short values: `-F:`, `-vx=1`.
    if (/^-[Fv].+/.test(word)) continue;
    if (word.startsWith('-')) return undefined; // unknown option: unverifiable
    scripts.push(word);
    // The first operand is the program; later operands are input files.
    break;
  }
  return scripts.length > 0 ? scripts : undefined;
}

/**
 * Does the awk program text contain a redirection (`>`) or a pipe (`|`)
 * OUTSIDE a string literal — something `isReadOnlyAwkScript` must not pass
 * as a read?
 *
 * The scan walks the text once, tracking quotes and backslash escapes. It
 * works on PROGRAM text, not on the raw command: the shell lexer already
 * stripped the shell quoting that carried the program (a quoted word), so a
 * `>` inside it is awk SYNTAX, never a shell redirection — a real shell
 * redirect on the line (`awk '{print}' f > out`) is a redirect token the
 * redirect tiers of the bash gate judge instead. The unquoted text is cut
 * into statement chunks at `;`, newline and brace boundaries, and each chunk
 * is judged on awk's own grammar:
 *
 *   - `|` anywhere unquoted is the coarse pipe risk (`print | cmd`,
 *     `cmd | getline`). awk also spells logical-or `||`, so a comparison-only
 *     program containing it still asks — coarse on purpose (fail closed: a
 *     false positive only asks).
 *   - `>` is the GREATER-THAN operator in a general expression (`$3 > 100`,
 *     `NR>1`); it is a print REDIRECTION only in a statement that also
 *     contains `print` / `printf` (`print "y" > f` writes a file). A chunk
 *     with `>` and no print keyword is a comparison — fine.
 *
 * An unterminated string literal also asks: the program text cannot be read
 * confidently. A false positive only asks; missing a real
 * `print … > file` / `print … | cmd` would run arbitrary code.
 */
function hasAwkRedirectOrPipe(script: string): boolean {
  let quote: '"' | "'" | null = null;
  // Unquoted text of the current statement chunk. Quoted spans collapse to
  // spaces so a keyword or operator cannot bleed across a literal boundary.
  let chunk = '';

  const judge = (statement: string): boolean =>
    statement.includes('|') ||
    (statement.includes('>') && /\b(?:print|printf)\b/.test(statement));

  for (let i = 0; i < script.length; i += 1) {
    const char = script[i];
    if (char === undefined) break;
    if (quote !== null) {
      // A backslash escapes the next character inside a string literal.
      if (char === '\\') {
        i += 1;
        continue;
      }
      if (char === quote) quote = null;
      else chunk += ' ';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    // A backslash outside a string escapes the next character too.
    if (char === '\\') {
      i += 1;
      continue;
    }
    // Statement / block boundaries cut the chunk: a print redirection and a
    // comparison in the same braces stay together, a pattern and its action
    // do not (`$3 > 100 {print $1}` is a comparison pattern plus a reader).
    if (char === ';' || char === '\n' || char === '{' || char === '}') {
      if (judge(chunk)) return true;
      chunk = '';
      continue;
    }
    chunk += char;
  }
  // Unterminated string: the program text cannot be read confidently — ask.
  if (quote !== null) return true;
  return judge(chunk);
}

/**
 * Can this awk program be verified as read-only? Rejects command execution
 * (`system(`), a command pipe into `getline`, a file read through `getline <`,
 * a `print` / `printf` redirection into a file, and `@load` / `@include`.
 * A false negative only asks; a false positive would run arbitrary code.
 */
export function isReadOnlyAwkScript(script: string): boolean {
  // Program-level redirection / pipe first: the literal-target regexes below
  // only see a quoted target, so `print "y" > f` (target held in a variable)
  // and `print "x" | c` used to pass. A print-level redirection or pipe
  // outside a string literal makes the whole command ask — while a `>` with
  // no print in its statement is a comparison, not a write (see
  // `hasAwkRedirectOrPipe`).
  if (hasAwkRedirectOrPipe(script)) return false;
  if (/\bsystem\s*\(/.test(script)) return false;
  // `cmd | getline` runs a command; `getline < "file"` reads a file.
  if (/\|\s*getline\b/.test(script)) return false;
  if (/\bgetline\b[^;\n]*</.test(script)) return false;
  // `print … > "file"` / `printf … >> "file"` write a file.
  if (/\b(?:print|printf)\b[^;\n]*>>?\s*["']/.test(script)) return false;
  // `print … | "cmd"` pipes into a command.
  if (/\b(?:print|printf)\b[^;\n]*\|\s*["']/.test(script)) return false;
  if (/@\s*(?:load|include)\b/.test(script)) return false;
  return true;
}
