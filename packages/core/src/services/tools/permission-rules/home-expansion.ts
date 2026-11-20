// `~` / `$HOME` expansion against the PROCESS home — the IO semantic shared by the file tools and the bash gate.

import { homedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Result of expanding a leading `~` / `$HOME` token in a path.
 *
 * `~` and `~/...` expand against the PROCESS home (see `expandHome`).
 * `~<name>` (tilde followed by anything other than `/` or end-of-word) names
 * ANOTHER user's home. We deliberately do NOT resolve it — that would mean
 * reading /etc/passwd or guessing the layout — so it is reported as
 * unresolvable and the caller forces an approval. Treating it as a relative
 * path would be wrong: a shell reads `cat ~root/.ssh/x` as `/root/.ssh/x`,
 * not as workspace-relative.
 */
export interface HomeExpansion {
  /** Path after `~` / `~/` / `$HOME` expansion; unchanged for `~<name>`. */
  path: string;
  /** True for `~<name>` — another user's home, which cannot be resolved safely. */
  unresolvable: boolean;
}

/**
 * The process's home directory — the anchor a SHELL expands `~` and `$HOME`
 * to (`os.homedir()`: `$HOME` when set, the account entry otherwise).
 *
 * TWO different "home" concepts must not be conflated:
 *
 *   - THIS one is an IO semantic: `read_file('~/x')` and `cat ~/x` must open
 *     the same file, and the shell's anchor is the process environment —
 *     never a Wayang flag or the session layout.
 *   - The policy boundary (`WorkerAccessScope.userHome`):
 *     WHO may read what. In production it is the same directory, but it is a
 *     separate decision input — a scope may anchor anywhere (tests inject
 *     temp dirs), and expansion must not follow it.
 */
export function processHomeDir(): string {
  return homedir();
}

/**
 * Expand a leading `~` / `$HOME` token against the PROCESS home.
 *
 * Exported for the file tools (`read_file` onwards): the tool must open the
 * SAME path the permission gate judged, and both must match what a shell
 * would open for `~/x` / `$HOME/x`. That anchor is the process home — never
 * the policy boundary (`scope.userHome`), which may differ (a Wayang run with
 * a custom root anchors its policy elsewhere while the worker's shell still
 * expands `~` to the real `$HOME`).
 *
 * `$HOME` / `${HOME}` are accepted as leading tokens for the file tools and
 * declared workspaces, where no shell sits in between to expand them. A bare
 * `$HOMEDIR`-style prefix is NOT expanded (only the exact spellings).
 * `~<name>` stays unresolvable — see `HomeExpansion`.
 */
export function expandHome(p: string): HomeExpansion {
  const home = processHomeDir();
  if (p === '~' || p === '$HOME' || p === '${HOME}') {
    return home === ''
      ? { path: p, unresolvable: true }
      : { path: home, unresolvable: false };
  }
  if (p.startsWith('~/')) {
    return home === ''
      ? { path: p, unresolvable: true }
      : { path: resolve(home, p.slice(2)), unresolvable: false };
  }
  for (const prefix of ['$HOME/', '${HOME}/']) {
    if (p.startsWith(prefix)) {
      return home === ''
        ? { path: p, unresolvable: true }
        : { path: resolve(home, p.slice(prefix.length)), unresolvable: false };
    }
  }
  if (p.startsWith('~')) return { path: p, unresolvable: true };
  return { path: p, unresolvable: false };
}

/**
 * Replace `$HOME` / `${HOME}` with the PROCESS home BEFORE path candidate
 * extraction, so `cat $HOME/.ssh/id_rsa` is judged against the same concrete
 * path a shell would open (and the sensitive list can see it) — the same
 * anchor `expandHome` uses. Only these two spellings are rewritten:
 * positional/special parameters (`$1`, `$@`, …) and every other variable are
 * left untouched, so common `awk '{print $1}'` commands never trip the gates.
 */
export function expandHomeVars(command: string): string {
  const home = processHomeDir();
  if (home === '') return command;
  // `${HOME}` first, then a bare `$HOME` not followed by an identifier char
  // (so `$HOMEDIR` is not partially rewritten).
  return command.replace(/\$\{HOME\}/g, home).replace(/\$HOME(?![A-Za-z0-9_])/g, home);
}
