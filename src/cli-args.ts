/**
 * CLI argument definitions + parsing/validation for the wayang entry point.
 *
 * Short flags: -v = --version, -h = --help, -r = --resume (plus the
 * pre-existing -w/-c/-n). `--verbose` is long-only by design: meow's
 * underlying parser (yargs-parser) splits any multi-character single-dash
 * token into single-character flags, so no multi-letter short can be
 * expressed for it (e.g. `-vb` would parse as `-v -b` and print the version).
 *
 * meow runs with `autoHelp`/`autoVersion` disabled and `allowUnknownFlags`
 * left at its default (`true`, i.e. meow itself never exits), so this module
 * fully owns exit-worthy decisions and stays unit-testable:
 *
 *   - unknown flags (unexpected parsed keys)  → error, echoed verbatim
 *   - flags meow silently swallows            → error, echoed verbatim
 *       · case variants of known flags (`--Version` — camelCase folding
 *         collides with the flag's own key, so it never surfaces)
 *       · `--no-<flag>` negations (yargs-parser maps them onto the known
 *         flag, a silent no-op for our false-default booleans)
 *   · booleans given a value (`--resume=x`)   → error
 *   · string flags missing a value (`--config` at end / before another flag)
 *                                              → error
 *   · duplicate flags (meow throws)           → error
 *
 * Priority: usage errors beat `--version`, which beats `--help` (matching
 * meow's internal ordering). Valid parses return `{ status: 'ok' }` with the
 * positional `input` (first entry: `server` subcommand or resume session id).
 */

import meow from 'meow';

export const CLI_HELP_TEXT = `
  Usage
    $ wayang                       Resume latest session for this workspace (or new)
    $ wayang --fresh               Start a brand-new session (ignore prior context)
    $ wayang --resume              Interactive session select
    $ wayang --resume <id>         Resume specific session
    $ wayang --resume --all        Show all workspaces
    $ wayang server                Run the headless logic process (RPC over stdio)

  Options
    --home-dir <path>       Root directory for sessions and config (default: $HOME)
    --workspace-dir, -w     Working directory for tools (default: pwd)
                            Alias: --workspace.
                            New session: recorded as its initial workspace.
                            --resume: never rewrites the session's recorded
                            workspaces; it only filters the picker (and picks
                            the default when resuming without an id).
    --config, -c            Config file path
    --fresh, -n             Start a new session (do not inherit prior context)
    --resume, -r            Pick a session to resume (interactive, or <id>)
    --all                   List sessions across all workspaces (with --resume)
    --verbose               Enable debug logging
    --help, -h              Show help
    --version, -v           Show version
    --session <mode>        (server) "new" or "resume:<id>"
    --inject-previous-tasks (server) surface unfinished tasks on resume
    --log-level <level>     (server) log level
`;

const CLI_FLAGS = {
  homeDir: { type: 'string' },
  // `aliases` is asserted mutable because meow types it as `string[]`; the
  // surrounding `as const` would otherwise make the array readonly.
  workspaceDir: { type: 'string', shortFlag: 'w', aliases: ['workspace'] as string[] },
  config: { type: 'string', shortFlag: 'c' },
  fresh: { type: 'boolean', shortFlag: 'n', default: false },
  resume: { type: 'boolean', shortFlag: 'r', default: false },
  all: { type: 'boolean', default: false },
  verbose: { type: 'boolean', default: false },
  help: { type: 'boolean', shortFlag: 'h' },
  version: { type: 'boolean', shortFlag: 'v' },
  session: { type: 'string' },
  injectPreviousTasks: { type: 'boolean', default: false },
  logLevel: { type: 'string' },
} as const;

export interface CliFlags {
  /** Root dir for sessions/config; undefined → caller falls back to $HOME. */
  homeDir?: string;
  /** Working directory for tools; undefined → caller falls back to cwd. */
  workspaceDir?: string;
  config?: string;
  fresh: boolean;
  resume: boolean;
  all: boolean;
  verbose: boolean;
  help: boolean;
  version: boolean;
  session?: string;
  injectPreviousTasks: boolean;
  logLevel?: string;
}

export type CliParseResult =
  | { status: 'ok'; input: string[]; flags: CliFlags }
  | { status: 'version'; version: string }
  | { status: 'help'; help: string }
  | { status: 'error'; problems: string[]; help: string };

// --- Derived flag metadata (drives the validation passes) ---

const FLAG_ENTRIES = Object.entries(CLI_FLAGS) as Array<
  [string, { type: 'string' | 'boolean'; shortFlag?: string; aliases?: readonly string[] }]
>;

/** Canonical camelCase keys, e.g. `homeDir`. */
const CANONICAL_KEYS = new Set(FLAG_ENTRIES.map(([key]) => key));

/** All registered short flags, e.g. `w`, `c`, `v`. */
const SHORT_KEYS = new Set(FLAG_ENTRIES.flatMap(([, flag]) => (flag.shortFlag ? [flag.shortFlag] : [])));

/** Long names as typed on the command line, e.g. `home-dir`. */
const LONG_NAMES = new Set(FLAG_ENTRIES.map(([key]) => decamelizeKey(key)));

/** Extra long spellings registered through meow `aliases`, e.g. `workspace`. */
const ALIAS_LONG_NAMES = new Set(
  FLAG_ENTRIES.flatMap(([, flag]) => (flag.aliases ?? []).map(decamelizeKey)),
);

/**
 * Parsed keys an alias produces in `unnormalizedFlags` — yargs-parser fills in
 * both the raw spelling and its camelCase form regardless of which flag the
 * user actually typed (e.g. `-w /x` still yields a `workspace` key).
 */
const ALIAS_KEYS = new Set(
  FLAG_ENTRIES.flatMap(([, flag]) => (flag.aliases ?? []).flatMap(name => [name, camelizeKey(name)])),
);

/** Every accepted long spelling: canonical names plus aliases. */
const KNOWN_LONG_NAMES = new Set([...LONG_NAMES, ...ALIAS_LONG_NAMES]);

const BOOLEAN_LONG_NAMES = new Set(
  FLAG_ENTRIES.filter(([, flag]) => flag.type === 'boolean').map(([key]) => decamelizeKey(key)),
);

const STRING_FLAG_KEYS = FLAG_ENTRIES.filter(([, flag]) => flag.type === 'string').map(([key]) => key);

const SHORT_TO_LONG = new Map<string, string>();
for (const [key, flag] of FLAG_ENTRIES) {
  if (flag.shortFlag) SHORT_TO_LONG.set(flag.shortFlag, decamelizeKey(key));
}

/** Case/separator-insensitive form, for matching typo variants of long names. */
function fold(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, '');
}

const FOLDED_LONG_NAMES = new Set([...KNOWN_LONG_NAMES].map(fold));

function decamelizeKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/** Inverse of `decamelizeKey`, for alias keys that contain dashes. */
function camelizeKey(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

/**
 * Recover the user's original spelling for an unexpected parsed flag key
 * (parsed keys are camelCased, e.g. `--foo-bar` arrives as `fooBar`).
 */
function renderUnknownKey(argv: readonly string[], key: string): string {
  const keyFolded = fold(key);
  for (const token of argv) {
    if (token === '--') break;
    if (!token.startsWith('-') || token === '-') continue;
    const name = token.slice(token.startsWith('--') ? 2 : 1).split('=')[0];
    if (!name) continue;
    if (key.length === 1) {
      // Single-char keys can appear standalone (`-x`) or inside a group (`-vx`).
      if (!token.startsWith('--') && name.includes(key)) return `-${key}`;
    } else if (token.startsWith('--')) {
      if (fold(name) === keyFolded) return `--${name}`;
      // yargs-parser maps `--no-foo` onto key `foo` — echo the negated form.
      if (fold(name) === `no${keyFolded}`) return `--${name}`;
    }
  }
  return key.length === 1 ? `-${key}` : `--${decamelizeKey(key)}`;
}

/**
 * Raw-argv pass for the two flag families meow/yargs-parser swallows without
 * leaving a trace in the parsed result:
 *   1. case variants of known long flags (`--Version`, `--Home-dir`) — the
 *      camelCase folding collides with the flag's own key and the default
 *      value wins, so the token never surfaces;
 *   2. `--no-<flag>` negations of known flags (silent no-op for booleans
 *      that default to false).
 * Also rejects boolean flags given an inline value (`--resume=x`, `-r=x`,
 * `-nr=5`): yargs-parser coerces any non-`true` value to `false`, silently
 * disabling the flag.
 */
function scanArgvForSwallowedFlags(argv: readonly string[], problems: Set<string>): void {
  for (const token of argv) {
    if (token === '--') break; // everything after `--` is positional
    if (!token.startsWith('-') || token === '-') continue;

    const eqIndex = token.indexOf('=');

    if (token.startsWith('--')) {
      const long = (eqIndex === -1 ? token : token.slice(0, eqIndex)).slice(2);
      if (!long) continue;
      if (KNOWN_LONG_NAMES.has(long)) {
        if (eqIndex !== -1 && BOOLEAN_LONG_NAMES.has(long)) {
          problems.add(`Option --${long} does not accept a value`);
        }
        continue;
      }
      if (FOLDED_LONG_NAMES.has(fold(long)) || (long.startsWith('no-') && KNOWN_LONG_NAMES.has(long.slice(3)))) {
        problems.add(`Unknown option: --${long}`);
      }
      continue;
    }

    // Single-dash group with an inline value: yargs-parser assigns the value
    // to the LAST letter before `=` (e.g. `-nr=5` → `r=5`).
    if (eqIndex !== -1) {
      const last = token.slice(1, eqIndex).at(-1);
      const long = last ? SHORT_TO_LONG.get(last) : undefined;
      if (long && BOOLEAN_LONG_NAMES.has(long)) {
        problems.add(`Option --${long} does not accept a value`);
      }
    }
  }
}

/**
 * Parse and validate CLI arguments. Pure: never reads process.argv and never
 * exits — the caller (cli.ts) turns the result into output + exit codes.
 */
export function parseCliArgs(argv: readonly string[]): CliParseResult {
  let cli: ReturnType<typeof buildMeow>;
  try {
    cli = buildMeow(argv);
  } catch (err) {
    // meow throws on duplicate flags, e.g. "The flag --config can only be set once."
    return {
      status: 'error',
      problems: [err instanceof Error ? err.message : String(err)],
      help: renderHelp(),
    };
  }

  const problems = new Set<string>();

  // 1. Unexpected parsed keys = unknown flags (includes unknown shorts and
  //    unknown longs; yargs-parser splits short groups into single keys).
  const unnormalized = cli.unnormalizedFlags as Record<string, unknown>;
  for (const key of Object.keys(unnormalized)) {
    if (!CANONICAL_KEYS.has(key) && !SHORT_KEYS.has(key) && !ALIAS_KEYS.has(key)) {
      problems.add(`Unknown option: ${renderUnknownKey(argv, key)}`);
    }
  }

  // 2. Flags swallowed by the parser (case variants, negations) and boolean
  //    flags given an inline value.
  scanArgvForSwallowedFlags(argv, problems);

  // 3. String flags missing their value. meow yields '' for these because the
  //    homeDir/workspaceDir defaults live in cli.ts, not in the flag defs.
  const flags = cli.flags as Record<string, unknown>;
  for (const key of STRING_FLAG_KEYS) {
    if (flags[key] === '') {
      problems.add(`Option --${decamelizeKey(key)} requires a value`);
    }
  }

  if (problems.size > 0) {
    return { status: 'error', problems: [...problems], help: cli.help };
  }

  if (flags.version === true) {
    return { status: 'version', version: cli.pkg.version ?? 'unknown' };
  }

  if (flags.help === true) {
    return { status: 'help', help: cli.help };
  }

  return {
    status: 'ok',
    input: cli.input,
    flags: {
      homeDir: readString(flags.homeDir),
      workspaceDir: readString(flags.workspaceDir),
      config: readString(flags.config),
      fresh: flags.fresh === true,
      resume: flags.resume === true,
      all: flags.all === true,
      verbose: flags.verbose === true,
      help: false,
      version: false,
      session: readString(flags.session),
      injectPreviousTasks: flags.injectPreviousTasks === true,
      logLevel: readString(flags.logLevel),
    },
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function buildMeow(argv: readonly string[]) {
  return meow(CLI_HELP_TEXT, {
    importMeta: import.meta,
    argv,
    autoHelp: false,
    autoVersion: false,
    flags: CLI_FLAGS,
  });
}

/** meow needs a full parse to render help; used on the duplicate-throw path. */
function renderHelp(): string {
  // Parse an empty argv: the original argv would throw again on duplicates,
  // and the rendered help text does not depend on the arguments anyway.
  return buildMeow([]).help;
}
