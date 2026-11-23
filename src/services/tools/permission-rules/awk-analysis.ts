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
 * Can this awk program be verified as read-only? Rejects command execution
 * (`system(`), a command pipe into `getline`, a file read through `getline <`,
 * a `print` / `printf` redirection into a file, and `@load` / `@include`.
 * A false negative only asks; a false positive would run arbitrary code.
 */
export function isReadOnlyAwkScript(script: string): boolean {
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
