/**
 * cli-args — CLI flag parsing + validation.
 *
 * Covers:
 *   - short flags: -v = --version, -h = --help, -r = --resume (long forms kept)
 *   - --verbose is long-only; -v must NOT route to the verbose branch
 *   - unknown flags (long, short, grouped) are rejected, echoed verbatim
 *   - flags the parser would silently swallow (case variants, --no-<flag>)
 *     are rejected too
 *   - boolean flags given a value, and string flags missing one, are rejected
 *   - `--` passthrough positionals stay untouched
 *
 * Exit-code mapping itself (version/help → 0, errors → non-zero) is asserted
 * against the real binary in e2e/scenarios/cli-flags.test.ts.
 */

import { describe, it, expect } from 'vitest';
import pkg from '../../package.json';
import { parseCliArgs } from '@/cli-args';

describe('parseCliArgs — version flag', () => {
  it('-v routes to the version branch (not verbose)', () => {
    const result = parseCliArgs(['-v']);
    expect(result.status).toBe('version');
    expect(result).not.toHaveProperty('flags');
  });

  it('--version routes to the version branch', () => {
    const result = parseCliArgs(['--version']);
    expect(result.status).toBe('version');
  });

  it('reports the package version', () => {
    const result = parseCliArgs(['-v']);
    expect(result.status === 'version' ? result.version : '').toBe(pkg.version);
  });

  it('-v wins over --verbose when combined', () => {
    const result = parseCliArgs(['-v', '--verbose']);
    expect(result.status).toBe('version');
  });

  it('grouped -vh / -hv route to version (meow checks version first)', () => {
    expect(parseCliArgs(['-vh']).status).toBe('version');
    expect(parseCliArgs(['-hv']).status).toBe('version');
  });

  it('version beats starting the server subcommand', () => {
    expect(parseCliArgs(['server', '-v']).status).toBe('version');
  });
});

describe('parseCliArgs — help flag', () => {
  it('-h routes to the help branch', () => {
    const result = parseCliArgs(['-h']);
    expect(result.status).toBe('help');
    expect(result.status === 'help' ? result.help : '').toContain('Usage');
  });

  it('--help routes to the help branch', () => {
    expect(parseCliArgs(['--help']).status).toBe('help');
  });

  it('help output lists both short and long forms', () => {
    const result = parseCliArgs(['--help']);
    const help = result.status === 'help' ? result.help : '';
    expect(help).toContain('--version, -v');
    expect(help).toContain('--help, -h');
    expect(help).toContain('--resume, -r');
    expect(help).toContain('--verbose');
  });
});

describe('parseCliArgs — resume flag', () => {
  it('-r parses as boolean resume', () => {
    const result = parseCliArgs(['-r']);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.flags.resume).toBe(true);
    expect(result.flags.verbose).toBe(false);
  });

  it('-r <id> takes the id as first positional (repo convention)', () => {
    const result = parseCliArgs(['-r', 'abc']);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.flags.resume).toBe(true);
    expect(result.input).toEqual(['abc']);
  });

  it('--resume <id> still works (long form unchanged)', () => {
    const result = parseCliArgs(['--resume', 'abc']);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.flags.resume).toBe(true);
    expect(result.input).toEqual(['abc']);
  });

  it('--resume --all parses (interactive select across workspaces)', () => {
    const result = parseCliArgs(['--resume', '--all']);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.flags.resume).toBe(true);
    expect(result.flags.all).toBe(true);
  });

  it('-r<id> (attached) is not supported and errors loudly', () => {
    const result = parseCliArgs(['-rabc']);
    expect(result.status).toBe('error');
  });
});

describe('parseCliArgs — verbose flag', () => {
  it('--verbose parses as boolean (long-only)', () => {
    const result = parseCliArgs(['--verbose']);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.flags.verbose).toBe(true);
    expect(result.flags.version).toBe(false);
  });

  it('-vb is NOT a verbose short: the parser splits it into -v -b', () => {
    // yargs-parser has no multi-char short flags: `-vb` becomes `-v` + `-b`.
    // With -v meaning --version this must NOT silently print the version —
    // the unknown -b makes it a usage error instead.
    const result = parseCliArgs(['-vb']);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.problems.some((p) => p.includes('-b'))).toBe(true);
  });
});

describe('parseCliArgs — valid long forms keep working', () => {
  it('no arguments yields defaults', () => {
    const result = parseCliArgs([]);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.flags.homeDir).toBeUndefined();
    expect(result.flags.workspaceDir).toBeUndefined();
    expect(result.flags.fresh).toBe(false);
    expect(result.flags.verbose).toBe(false);
    expect(result.flags.version).toBe(false);
    expect(result.input).toEqual([]);
  });

  it('string flags with values parse', () => {
    const result = parseCliArgs(['--home-dir', '/h', '--workspace-dir', '/w', '--config', 'a.json']);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.flags.homeDir).toBe('/h');
    expect(result.flags.workspaceDir).toBe('/w');
    expect(result.flags.config).toBe('a.json');
  });

  it('equals form parses for string flags', () => {
    const result = parseCliArgs(['--config=a.json', '--home-dir=/h', '-w=/w']);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.flags.config).toBe('a.json');
    expect(result.flags.homeDir).toBe('/h');
    expect(result.flags.workspaceDir).toBe('/w');
  });

  it('grouped known boolean shorts parse', () => {
    const result = parseCliArgs(['-rn', '--all']);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.flags.resume).toBe(true);
    expect(result.flags.fresh).toBe(true);
    expect(result.flags.all).toBe(true);
  });

  it('server subcommand with server flags parses', () => {
    const result = parseCliArgs(['server', '--session', 'resume:abc', '--inject-previous-tasks', '--log-level', 'debug']);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.input[0]).toBe('server');
    expect(result.flags.session).toBe('resume:abc');
    expect(result.flags.injectPreviousTasks).toBe(true);
    expect(result.flags.logLevel).toBe('debug');
  });

  it('`--` passthrough keeps later tokens positional', () => {
    const result = parseCliArgs(['--resume', '--', '-v']);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.flags.resume).toBe(true);
    expect(result.flags.version).toBe(false);
    expect(result.input).toEqual(['-v']);
  });
});

describe('parseCliArgs — unknown flags are rejected, not ignored', () => {
  it('unknown long flag', () => {
    const result = parseCliArgs(['--foo']);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.problems.some((p) => p.includes('--foo'))).toBe(true);
    expect(result.help).toContain('Usage');
  });

  it('unknown long flag with a value echoes the flag name', () => {
    const result = parseCliArgs(['--foo=bar']);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.problems.some((p) => p.includes('--foo'))).toBe(true);
  });

  it('unknown dashed long flag echoes the original spelling', () => {
    const result = parseCliArgs(['--foo-bar']);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.problems.some((p) => p.includes('--foo-bar'))).toBe(true);
  });

  it('unknown short flag', () => {
    const result = parseCliArgs(['-x']);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.problems.some((p) => p.includes('-x'))).toBe(true);
  });

  it('unknown short inside a group is reported', () => {
    const result = parseCliArgs(['-v', '-b']);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.problems.some((p) => p.includes('-b'))).toBe(true);
  });

  it('usage errors beat --version and --help', () => {
    expect(parseCliArgs(['--foo', '-v']).status).toBe('error');
    expect(parseCliArgs(['--foo', '-h']).status).toBe('error');
  });
});

describe('parseCliArgs — silently-swallowed flags are rejected', () => {
  it('case variant of a known flag (--Version) errors with original spelling', () => {
    const result = parseCliArgs(['--Version']);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.problems.some((p) => p.includes('--Version'))).toBe(true);
  });

  it('case variant with dashes (--Home-dir) errors', () => {
    const result = parseCliArgs(['--Home-dir', '/x']);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.problems.some((p) => p.includes('--Home-dir'))).toBe(true);
  });

  it('underscore variant of a known flag (--log_level) errors', () => {
    const result = parseCliArgs(['--log_level', 'debug']);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.problems.some((p) => p.includes('--log_level'))).toBe(true);
  });

  it('--no-<flag> negation of a known flag errors', () => {
    const result = parseCliArgs(['--no-fresh']);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.problems.some((p) => p.includes('--no-fresh'))).toBe(true);
  });
});

describe('parseCliArgs — boolean flags must not carry values', () => {
  it('--resume=abc errors', () => {
    const result = parseCliArgs(['--resume=abc']);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.problems.some((p) => p.includes('--resume'))).toBe(true);
  });

  it('--fresh=x errors', () => {
    expect(parseCliArgs(['--fresh=x']).status).toBe('error');
  });

  it('-r=x errors (short form)', () => {
    expect(parseCliArgs(['-r=x']).status).toBe('error');
  });

  it('-nr=5 errors (grouped short whose last letter is boolean)', () => {
    expect(parseCliArgs(['-nr=5']).status).toBe('error');
  });

  it('-c=x is fine (string short takes the value)', () => {
    expect(parseCliArgs(['-c=x']).status).toBe('ok');
  });
});

describe('parseCliArgs — string flags missing a value are rejected', () => {
  it.each([
    ['--config'],
    ['-c'],
    ['--config', '--verbose'],
    ['--home-dir'],
    ['--workspace-dir'],
    ['--log-level'],
    ['--session'],
  ])('%j errors with "requires a value"', (...argv) => {
    const result = parseCliArgs(argv);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.problems.some((p) => p.includes('requires a value'))).toBe(true);
  });

  it('mentions the flag long name', () => {
    const result = parseCliArgs(['--config']);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.problems.some((p) => p.includes('--config'))).toBe(true);
  });
});

describe('parseCliArgs — duplicate flags', () => {
  it('--config given twice errors', () => {
    const result = parseCliArgs(['--config', 'a.json', '--config', 'b.json']);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.problems.some((p) => p.includes('only be set once'))).toBe(true);
    expect(result.help).toContain('Usage');
  });
});

describe('parseCliArgs — --workspace alias and resume semantics', () => {
  it('--workspace parses as the canonical workspaceDir flag', () => {
    const result = parseCliArgs(['--workspace', '/w']);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.flags.workspaceDir).toBe('/w');
  });

  it('--workspace=/w (equals form) parses', () => {
    const result = parseCliArgs(['--workspace=/w']);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.flags.workspaceDir).toBe('/w');
  });

  it('--workspace combines with --resume <id>', () => {
    const result = parseCliArgs(['--workspace', '/w', '--resume', 'abc']);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.flags.workspaceDir).toBe('/w');
    expect(result.flags.resume).toBe(true);
    expect(result.input).toEqual(['abc']);
  });

  it('--workspace without a value errors with "requires a value"', () => {
    const result = parseCliArgs(['--workspace']);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.problems.some((p) => p.includes('requires a value'))).toBe(true);
  });

  it('--workspace together with -w errors as a duplicate', () => {
    const result = parseCliArgs(['-w', '/x', '--workspace', '/y']);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.problems.some((p) => p.includes('only be set once'))).toBe(true);
  });

  it('--Workspace (case variant of the alias) is still rejected', () => {
    const result = parseCliArgs(['--Workspace', '/w']);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.problems.some((p) => p.includes('--Workspace'))).toBe(true);
  });
});

describe('parseCliArgs — help documents --workspace semantics', () => {
  const help = (() => {
    const result = parseCliArgs(['--help']);
    return result.status === 'help' ? result.help : '';
  })();

  it('lists the flag with its alias', () => {
    expect(help).toContain('--workspace-dir, -w');
    expect(help).toContain('Alias: --workspace.');
  });

  it('explains the new-session and resume meanings separately', () => {
    expect(help).toContain('New session: recorded as its initial workspace.');
    expect(help).toContain("--resume: never rewrites the session's recorded");
    expect(help).toContain('it only filters the picker');
  });
});
