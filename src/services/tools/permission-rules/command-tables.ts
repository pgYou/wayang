// The single source of command knowledge for the bash gates (#51):
// one table entry per verb carrying its capability, its flag conditions,
// and the danger / wrapper marks the other tiers read.
//
// Before this module the knowledge lived in eight private constants spread
// across three files (two read tables, three write tables, a danger table, a
// wrapper table and the git read-subcommand table), and the verbs that sat on
// two tables at once (which / command / echo / printf / date / pwd were both
// `read` and `inert`) could drift between them. Here each verb has exactly one
// entry; where the old tables disagreed the more conservative reading won:
// the six duplicates above keep the `read` capability, so their operands are
// still path-judged by the capability gate instead of riding an inert allow.
//
// What is deliberately NOT in the table:
//   - the shape rules (wrapper-prefix stripping and its option tables,
//     `git -c` unknown, `env -S` exec, launcher unfolding, `mkfs.` prefix
//     danger) — those live next to their classifiers;
//   - `dynamic` — that verdict comes from word patterns (`$`, backtick) and
//     the `source` / `.` verbs, not from table membership.

/**
 * What one command verb is capable of. `dynamic` is decided by word shape,
 * never by this table. `unknown` is also the value for verbs with no entry:
 * the table is opt-in exactly like the read-only table it replaces.
 */
export type CommandCapability = 'read' | 'inert' | 'write' | 'exec' | 'network' | 'unknown';

/** One verb's row in the command table. */
export interface CommandTableEntry {
  /**
   * The verb's capability. `read` feeds `classifySegment` (the direction
   * classifier), `inert` the bare-segment gate, `write` the write-direction
   * classifier, `exec` / `network` the capability gate's head lookup.
   */
  readonly capability: CommandCapability;
  /**
   * Subcommands that only read (`git status`). Only `git` uses this today:
   * the verb itself is a conditional read, and `isReadOnlyGitCommand` keeps
   * the rule (global-option skipping, list-only flags) that reads this list.
   */
  readonly readFlags?: readonly string[];
  /**
   * Flags that turn the verb into a write (`sed -i`, `find -delete`). The
   * verb AND one of these flags in the same segment make a write
   * (`isWriteSegment` / `isWriteCommandHead`).
   */
  readonly writeFlags?: readonly string[];
  /** The destructive tier asks for this verb whatever its targets are. */
  readonly danger?: boolean;
  /** The wrapper tier strips this prefix to find the command position. */
  readonly wrapper?: boolean;
  /**
   * A write the DIRECTION split did not know before the merge (`rsync`): the
   * head classifier itself must report it, or a launcher interior
   * (`timeout 5 rsync a b`) would lose the write verdict. Direction write
   * verbs (`rm`, `mv`, …) do NOT set this — in a launcher interior they keep
   * the historic `unknown` verdict (the ask), and on the direct path they are
   * settled by `isWriteCommandHead` before the head classifier runs.
   */
  readonly capabilityOnlyWrite?: boolean;
}

/**
 * The table itself. Entries are ordered by capability group so the rows can
 * be diffed against the tables they replaced, one group at a time.
 */
export const COMMAND_TABLE: ReadonlyMap<string, CommandTableEntry> = new Map<string, CommandTableEntry>([
  // --- read: what a candidate in a read-only segment is judged by ---
  ['cat', { capability: 'read' }],
  ['ls', { capability: 'read' }],
  ['head', { capability: 'read' }],
  ['tail', { capability: 'read' }],
  ['wc', { capability: 'read' }],
  ['grep', { capability: 'read' }],
  ['rg', { capability: 'read' }],
  ['stat', { capability: 'read' }],
  ['file', { capability: 'read' }],
  ['readlink', { capability: 'read' }],
  ['tree', { capability: 'read' }],
  ['du', { capability: 'read' }],
  ['df', { capability: 'read' }],
  ['cut', { capability: 'read' }],
  ['sort', { capability: 'read' }],
  ['uniq', { capability: 'read' }],
  ['tr', { capability: 'read' }],
  ['diff', { capability: 'read' }],
  // The read/inert duplicates resolved to the conservative `read` (see the
  // module doc): bare shapes still allow silently — their operands resolve
  // against the in-workspace cursor — but a relative operand now goes through
  // the policy instead of riding the inert allow.
  ['which', { capability: 'read' }],
  ['command', { capability: 'read', wrapper: true }],
  ['echo', { capability: 'read' }],
  ['printf', { capability: 'read' }],
  ['date', { capability: 'read' }],
  ['pwd', { capability: 'read' }],
  // Conditional reads: the write flags are part of the write-direction split
  // (`sed -i`, `find -delete`), the script/subcommand conditions live with
  // `classifySegment` / `isReadOnlyGitCommand`.
  ['sed', { capability: 'read', writeFlags: ['-i', '--in-place'] }],
  [
    'find',
    {
      capability: 'read',
      writeFlags: [
        '-delete', '-fprint', '-fprint0', '-fls', '-fprintf', '-exec', '-execdir', '-ok', '-okdir',
      ],
    },
  ],
  [
    'git',
    {
      capability: 'read',
      readFlags: ['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame', 'grep', 'describe', 'shortlog'],
    },
  ],

  // --- inert: side-effect-free verbs in a bare segment ---
  ['sleep', { capability: 'inert' }],
  ['true', { capability: 'inert' }],
  ['false', { capability: 'inert' }],
  [':', { capability: 'inert' }],
  ['whoami', { capability: 'inert' }],
  ['id', { capability: 'inert' }],
  ['test', { capability: 'inert' }],
  ['[', { capability: 'inert' }],
  ['exit', { capability: 'inert' }],

  // --- write: verbs that write to the paths they name ---
  ['rm', { capability: 'write' }],
  ['rmdir', { capability: 'write' }],
  ['mv', { capability: 'write' }],
  ['cp', { capability: 'write' }],
  ['ln', { capability: 'write' }],
  ['tee', { capability: 'write' }],
  ['dd', { capability: 'write' }],
  ['truncate', { capability: 'write' }],
  ['install', { capability: 'write' }],
  ['mkdir', { capability: 'write' }],
  ['touch', { capability: 'write' }],
  ['chmod', { capability: 'write', danger: true }],
  ['chown', { capability: 'write', danger: true }],
  ['chgrp', { capability: 'write' }],
  ['shred', { capability: 'write' }],
  ['unlink', { capability: 'write' }],
  ['chattr', { capability: 'write' }],
  ['mkfs', { capability: 'write', danger: true }],
  ['mkswap', { capability: 'write' }],
  ['mount', { capability: 'write' }],
  ['umount', { capability: 'write' }],
  ['rsync', { capability: 'write', capabilityOnlyWrite: true }],

  // --- exec: shells and interpreters at the command position ---
  ['bash', { capability: 'exec' }],
  ['sh', { capability: 'exec' }],
  ['dash', { capability: 'exec' }],
  ['zsh', { capability: 'exec' }],
  ['ksh', { capability: 'exec' }],
  ['busybox', { capability: 'exec' }],
  ['python', { capability: 'exec' }],
  ['python3', { capability: 'exec' }],
  ['node', { capability: 'exec' }],
  // `perl` / `ruby` interpret a script (exec) but write with `-i`; the write
  // flag wins because the write-direction split runs first.
  ['perl', { capability: 'exec', writeFlags: ['-i'] }],
  ['ruby', { capability: 'exec', writeFlags: ['-i'] }],
  ['awk', { capability: 'exec' }],
  ['php', { capability: 'exec' }],
  ['lua', { capability: 'exec' }],

  // --- network: commands whose primary effect is reaching the network ---
  ['curl', { capability: 'network' }],
  ['wget', { capability: 'network' }],
  ['nc', { capability: 'network' }],
  ['scp', { capability: 'network' }],

  // --- danger: the destructive tier, whatever else the verb can do ---
  ['sudo', { capability: 'unknown', wrapper: true, danger: true }],
  ['shutdown', { capability: 'unknown', danger: true }],
  ['reboot', { capability: 'unknown', danger: true }],

  // --- wrapper: prefixes stripped to find the command position ---
  // (`command` is marked at its read entry above; `sudo` at its danger entry.)
  ['env', { capability: 'unknown', wrapper: true }],
  ['nohup', { capability: 'unknown', wrapper: true }],
  ['time', { capability: 'unknown', wrapper: true }],
  ['nice', { capability: 'unknown', wrapper: true }],
  ['ionice', { capability: 'unknown', wrapper: true }],
  ['exec', { capability: 'unknown', wrapper: true }],
  ['builtin', { capability: 'unknown', wrapper: true }],
]);

/** One verb's row, or `undefined` for verbs the table has not been taught. */
export function commandEntry(verb: string): CommandTableEntry | undefined {
  return COMMAND_TABLE.get(verb);
}

/** Is this verb on the read-only table (the direction classifier's input)? */
export function isReadCommand(verb: string): boolean {
  return COMMAND_TABLE.get(verb)?.capability === 'read';
}

/** Is this verb side-effect-free (the bare-segment inert gate's input)? */
export function isInertCommand(verb: string): boolean {
  return COMMAND_TABLE.get(verb)?.capability === 'inert';
}

/** Does this verb write to the paths it names, without a flag condition? */
export function isWriteCommand(verb: string): boolean {
  return COMMAND_TABLE.get(verb)?.capability === 'write';
}

/**
 * The write flags of `verb` (`sed` → `['-i', '--in-place']`), or `undefined`
 * when it has none. A verb AND one of its flags in the same segment is a
 * write — see `isFlagWord` in bash-classification for the matching spellings.
 */
export function writeFlagsOf(verb: string): readonly string[] | undefined {
  return COMMAND_TABLE.get(verb)?.writeFlags;
}

/** Does the destructive tier ask for this verb as soon as it is the head? */
export function isDangerousCommand(verb: string): boolean {
  return COMMAND_TABLE.get(verb)?.danger === true;
}

/** Is this verb a wrapper prefix the command-position search strips? */
export function isWrapperCommand(verb: string): boolean {
  return COMMAND_TABLE.get(verb)?.wrapper === true;
}

/**
 * `git`'s read subcommands as a set, derived once from the table's `readFlags`
 * — the only index over table data that a caller needs in set shape.
 */
export const GIT_READ_SUBCOMMANDS: ReadonlySet<string> = new Set<string>(
  COMMAND_TABLE.get('git')?.readFlags ?? [],
);
