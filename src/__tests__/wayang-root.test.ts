/**
 * resolveWayangRoot — the wayang ROOT resolution (0.8.4).
 *
 * `--wayang-root` relocates wayang's runtime state (data at `<root>/.wayang`,
 * config at `<root>/.wayang.config.json`); it never selects the OS user home
 * the permission policy anchors on. `--home-dir` is its deprecated alias with
 * identical semantics. These cases pin the precedence, the default and the
 * deprecation signal the CLI warns on.
 */
import { describe, expect, it } from 'vitest';
import { parseCliArgs, resolveWayangRoot } from '@/cli-args';

describe('resolveWayangRoot', () => {
  it('defaults to $HOME when no root flag is given', () => {
    expect(resolveWayangRoot({}, { HOME: '/home/u' })).toEqual({
      root: '/home/u',
      usedDeprecatedHomeDir: false,
    });
    // The historic `~` literal when HOME is unset (resolved against cwd).
    expect(resolveWayangRoot({}, {}).root).toBe(`${process.cwd()}/~`);
  });

  it('uses --wayang-root when given', () => {
    expect(resolveWayangRoot({ wayangRoot: '/data/w' }, { HOME: '/home/u' })).toEqual({
      root: '/data/w',
      usedDeprecatedHomeDir: false,
    });
  });

  it('the deprecated --home-dir maps to the same root and flags a warn', () => {
    expect(resolveWayangRoot({ homeDir: '/data/w' }, { HOME: '/home/u' })).toEqual({
      root: '/data/w',
      usedDeprecatedHomeDir: true,
    });
  });

  it('--wayang-root wins when both are given (still warns about the alias)', () => {
    expect(resolveWayangRoot({ wayangRoot: '/new', homeDir: '/old' }, { HOME: '/home/u' })).toEqual({
      root: '/new',
      usedDeprecatedHomeDir: true,
    });
  });

  it('parses both spellings from argv', () => {
    const canonical = parseCliArgs(['--wayang-root', '/data/w']);
    expect(canonical.status).toBe('ok');
    if (canonical.status === 'ok') expect(canonical.flags.wayangRoot).toBe('/data/w');

    const alias = parseCliArgs(['--home-dir', '/data/w']);
    expect(alias.status).toBe('ok');
    if (alias.status === 'ok') {
      expect(alias.flags.homeDir).toBe('/data/w');
      expect(alias.flags.wayangRoot).toBeUndefined();
    }
  });

  it('rejects --wayang-root without a value', () => {
    const result = parseCliArgs(['--wayang-root']);
    expect(result.status).toBe('error');
  });
});
