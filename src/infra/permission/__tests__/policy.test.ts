import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  decideAccess,
  defaultSensitivePaths,
  isDenied,
  isPathWithin,
  isSensitiveSegmentPath,
  matchSensitiveEntry,
  normalizePath,
} from '@/infra/permission/policy';

/**
 * Fixture tree (created once per run, under the OS temp dir):
 *
 *   root/
 *     home/
 *       .ssh/id_rsa
 *       .npmrc
 *       .wayang/sessions/
 *       documents/
 *         nested/
 *       home-sibling-not-really/   (name collision only — see boundary tests)
 *     work/
 *       src/
 *     outside/
 *     link-to-work -> work
 */
let root: string;
let home: string;
let work: string;
let outside: string;
let link: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'wayang-policy-')));
  home = join(root, 'home');
  work = join(root, 'work');
  outside = join(root, 'outside');
  link = join(root, 'link-to-work');

  mkdirSync(join(home, '.ssh'), { recursive: true });
  mkdirSync(join(home, '.wayang', 'sessions'), { recursive: true });
  mkdirSync(join(home, 'documents', 'nested'), { recursive: true });
  mkdirSync(join(work, 'src'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(home, '.ssh', 'id_rsa'), 'secret');
  writeFileSync(join(home, '.npmrc'), '//registry/:_authToken=secret');
  symlinkSync(work, link);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('normalizePath', () => {
  it('keeps absolute paths absolute', () => {
    expect(normalizePath(join(home, 'documents'))).toBe(join(home, 'documents'));
  });

  it('resolves relative paths against the provided base', () => {
    expect(normalizePath('documents', { base: home })).toBe(join(home, 'documents'));
    expect(normalizePath('./documents/nested', { base: home })).toBe(join(home, 'documents', 'nested'));
  });

  it('collapses .. lexically', () => {
    expect(normalizePath('../outside', { base: home })).toBe(outside);
    expect(normalizePath(join(home, 'documents', '..', 'documents'))).toBe(join(home, 'documents'));
  });

  it('drops trailing slashes', () => {
    expect(normalizePath(`${join(home, 'documents')}/`)).toBe(join(home, 'documents'));
    expect(normalizePath(`${join(home, 'documents')}///`)).toBe(join(home, 'documents'));
  });

  it('resolves symlinks via realpath', () => {
    expect(normalizePath(link)).toBe(realpathSync(work));
    expect(normalizePath(join(link, 'src'))).toBe(join(realpathSync(work), 'src'));
  });

  it('falls back to the lexical path for paths that do not exist, without throwing', () => {
    const ghost = join(home, 'ghost', 'deep', 'file.txt');
    expect(() => normalizePath(ghost)).not.toThrow();
    expect(normalizePath(ghost)).toBe(resolve(ghost));
    expect(normalizePath('ghost/file.txt', { base: home })).toBe(join(home, 'ghost', 'file.txt'));
  });
});

describe('defaultSensitivePaths', () => {
  it('lists the built-in credential locations under home', () => {
    const denied = defaultSensitivePaths(home);
    expect(denied).toContain(join(home, '.ssh'));
    expect(denied).toContain(join(home, '.gnupg'));
    expect(denied).toContain(join(home, '.aws'));
    expect(denied).toContain(join(home, '.kube'));
    expect(denied).toContain(join(home, '.docker', 'config.json'));
    expect(denied).toContain(join(home, '.netrc'));
    expect(denied).toContain(join(home, '.npmrc'));
    expect(denied).toContain(join(home, '.config', 'gh'));
    expect(denied).toContain(join(home, '.wayang.config.json'));
    expect(denied).toContain(join(home, '.wayang'));
    expect(denied.every((p) => p.startsWith(home))).toBe(true);
  });
});

describe('isDenied / isPathWithin: segment boundaries', () => {
  it('matches equal paths and descendants', () => {
    expect(isDenied('/a/b', ['/a/b'])).toBe(true);
    expect(isDenied('/a/b/c', ['/a/b'])).toBe(true);
  });

  it('does not match a sibling that merely shares a string prefix', () => {
    expect(isDenied('/a/bc', ['/a/b'])).toBe(false);
    expect(isDenied('/a/bcd/e', ['/a/b'])).toBe(false);
  });

  it('handles the root boundary', () => {
    expect(isPathWithin('/', '/anything')).toBe(true);
    expect(isPathWithin('/', '/')).toBe(true);
    expect(isDenied('/etc/passwd', ['/'])).toBe(true);
    expect(isPathWithin('/a', '/')).toBe(false);
  });

  it('handles the home boundary', () => {
    expect(isPathWithin(home, join(home, 'documents'))).toBe(true);
    expect(isPathWithin(home, `${home}-sibling`)).toBe(false);
    expect(isPathWithin(home, root)).toBe(false);
  });

  it('does not mistake .sshfoo for inside .ssh', () => {
    const denied = defaultSensitivePaths(home);
    expect(isDenied(join(home, '.ssh', 'id_rsa'), denied)).toBe(true);
    expect(isDenied(join(home, '.sshfoo', 'id_rsa'), denied)).toBe(false);
    expect(isDenied(join(home, '.wayang', 'sessions'), denied)).toBe(true);
  });
});

describe('decideAccess: the sensitive list wins over every allow rule', () => {
  it('asks (never allows) a READ that is also inside configAllowedDirs, autoAllowRoots and the workspace', () => {
    const result = decideAccess({
      path: join(home, '.ssh', 'id_rsa'),
      access: 'read',
      homeDir: home,
      taskWorkspace: home,
      taskAllowedDirs: [home],
      configAllowedDirs: [home],
      autoAllowRoots: [home],
    });
    expect(result).toEqual({
      decision: 'ask',
      matchedRule: 'sensitive-list',
      resolvedPath: join(home, '.ssh', 'id_rsa'),
      matchedEntry: '.ssh',
      matchedSource: 'segment',
      sensitive: true,
    });
  });

  it('denies writes into a single sensitive file inside the task workspace', () => {
    const result = decideAccess({
      path: join(home, '.npmrc'),
      access: 'write',
      homeDir: home,
      taskWorkspace: home,
    });
    expect(result.decision).toBe('deny');
    expect(result.matchedRule).toBe('sensitive-list-write');
    expect(result.matchedEntry).toBe('.npmrc');
  });

  it('treats an UNKNOWN access like a read for the sensitive list (bash), but never as a home-scope allow', () => {
    const sensitive = decideAccess({ path: join(home, '.ssh', 'id_rsa'), access: 'unknown', homeDir: home });
    expect(sensitive.decision).toBe('ask');
    expect(sensitive.matchedRule).toBe('sensitive-list');

    // `unknown` does not earn the read-within-home allow.
    const plain = decideAccess({ path: join(home, 'documents', 'n.md'), access: 'unknown', homeDir: home });
    expect(plain.decision).toBe('ask');
    expect(plain.matchedRule).toBe('outside-all');
  });

  it('honours extraSensitiveDirs and still keeps the built-in defaults', () => {
    const extra = join(work, 'private');
    const fromExtra = decideAccess({
      path: join(extra, 'notes.md'),
      access: 'read',
      homeDir: home,
      taskWorkspace: work,
      extraSensitiveDirs: [extra],
    });
    // A configured sensitive dir is a protected location: the read asks, the
    // workspace allow does not override it.
    expect(fromExtra.decision).toBe('ask');
    expect(fromExtra.matchedRule).toBe('sensitive-list');
    expect(fromExtra.matchedEntry).toBe(extra);
    expect(fromExtra.matchedSource).toBe('config-dir');

    const writeExtra = decideAccess({
      path: join(extra, 'notes.md'),
      access: 'write',
      homeDir: home,
      taskWorkspace: work,
      extraSensitiveDirs: [extra],
    });
    expect(writeExtra.decision).toBe('deny');
    expect(writeExtra.matchedRule).toBe('sensitive-list-write');

    // Relative configured entries resolve against home.
    const relative = decideAccess({
      path: join(home, 'vault', 'k.txt'),
      access: 'read',
      homeDir: home,
      extraSensitiveDirs: ['vault'],
    });
    expect(relative.decision).toBe('ask');
    expect(relative.matchedEntry).toBe('vault');

    const fromDefault = decideAccess({
      path: join(home, '.gnupg', 'key.gpg'),
      access: 'read',
      homeDir: home,
      extraSensitiveDirs: [extra],
    });
    expect(fromDefault.decision).toBe('ask');
    expect(fromDefault.matchedEntry).toBe('.gnupg');
  });
});

describe('decideAccess: read vs write scope', () => {
  it('allows reading an ordinary directory inside home', () => {
    const result = decideAccess({ path: join(home, 'documents'), access: 'read', homeDir: home });
    expect(result.decision).toBe('allow');
    expect(result.matchedRule).toBe('read-within-home');
    // The structured narrowing signal — consumers key off this, not the string.
    expect(result.withinReadScope).toBe(true);
  });

  it('sets withinReadScope only for the read-inside-home allow', () => {
    // Explicit allow roots are NOT read-scope-only narrowing targets.
    expect(
      decideAccess({ path: join(home, 'documents'), access: 'read', homeDir: home, configAllowedDirs: [join(home, 'documents')] })
        .withinReadScope,
    ).toBeFalsy();
    expect(
      decideAccess({ path: join(home, 'documents'), access: 'read', homeDir: home, taskWorkspace: join(home, 'documents') })
        .withinReadScope,
    ).toBeFalsy();
    // Writes are never allowed by the read-inside-home rule.
    expect(decideAccess({ path: join(home, 'documents', 'n.md'), access: 'write', homeDir: home }).withinReadScope).toBeFalsy();
    // Deny / ask results carry the flag as falsy too.
    expect(decideAccess({ path: join(home, '.ssh', 'id_rsa'), access: 'read', homeDir: home }).withinReadScope).toBeFalsy();
    expect(decideAccess({ path: outside, access: 'read', homeDir: home }).withinReadScope).toBeFalsy();
  });

  it('does not allow writing inside home outside any workspace', () => {
    const result = decideAccess({ path: join(home, 'documents', 'note.md'), access: 'write', homeDir: home });
    expect(result.decision).toBe('ask');
    expect(result.matchedRule).toBe('outside-all');
  });

  it('allows writing inside home when it is the task workspace', () => {
    const result = decideAccess({
      path: join(home, 'documents', 'note.md'),
      access: 'write',
      homeDir: home,
      taskWorkspace: join(home, 'documents'),
    });
    expect(result.decision).toBe('allow');
    expect(result.matchedRule).toBe('task-workspace');
  });

  it('asks for reads outside home', () => {
    const result = decideAccess({ path: outside, access: 'read', homeDir: home, taskWorkspace: work });
    expect(result).toEqual({ decision: 'ask', matchedRule: 'outside-all', resolvedPath: outside });
  });

  it('does not treat a home-sibling as inside home', () => {
    const sibling = `${home}-sibling`;
    expect(decideAccess({ path: sibling, access: 'read', homeDir: home }).decision).toBe('ask');
  });

  it('asks for the filesystem root even on read', () => {
    expect(decideAccess({ path: '/', access: 'read', homeDir: home }).decision).toBe('ask');
  });
});

describe('decideAccess: configured allow rules', () => {
  it('allows via configAllowedDirs for both read and write', () => {
    const read = decideAccess({ path: outside, access: 'read', homeDir: home, configAllowedDirs: [outside] });
    expect(read.matchedRule).toBe('config-allowed');
    const write = decideAccess({ path: join(outside, 'f.txt'), access: 'write', homeDir: home, configAllowedDirs: [outside] });
    expect(write.decision).toBe('allow');
    expect(write.matchedRule).toBe('config-allowed');
  });

  it('allows via autoAllowRoots', () => {
    const result = decideAccess({ path: join(outside, 'f.txt'), access: 'read', homeDir: home, autoAllowRoots: [outside] });
    expect(result.decision).toBe('allow');
    expect(result.matchedRule).toBe('auto-allow-root');
  });

  it('prefers configAllowedDirs over autoAllowRoots when both match', () => {
    const result = decideAccess({
      path: outside,
      access: 'read',
      homeDir: home,
      configAllowedDirs: [outside],
      autoAllowRoots: [outside],
    });
    expect(result.matchedRule).toBe('config-allowed');
  });

  it('respects segment boundaries for configured dirs', () => {
    const result = decideAccess({ path: `${outside}-other`, access: 'read', homeDir: home, autoAllowRoots: [outside] });
    expect(result.decision).toBe('ask');
  });
});

describe('decideAccess: task allowedDirs scope', () => {
  it('allows a task-allowed directory when passed', () => {
    const result = decideAccess({
      path: join(home, 'documents', 'nested'),
      access: 'write',
      homeDir: home,
      taskWorkspace: work,
      taskAllowedDirs: [join(home, 'documents')],
    });
    expect(result.decision).toBe('allow');
    expect(result.matchedRule).toBe('task-allowed');
  });

  it('asks for the same path when no task allowedDirs are passed', () => {
    const result = decideAccess({
      path: join(home, 'documents', 'nested'),
      access: 'write',
      homeDir: home,
      taskWorkspace: work,
    });
    expect(result.decision).toBe('ask');
    expect(result.matchedRule).toBe('outside-all');
  });

  it('does not leak one task allowedDirs into another task', () => {
    const other = decideAccess({
      path: join(home, 'documents', 'nested'),
      access: 'write',
      homeDir: home,
      taskWorkspace: work,
      taskAllowedDirs: [],
    });
    expect(other.decision).toBe('ask');
  });
});

describe('decideAccess: canonicalization inputs', () => {
  it('resolves relative paths against cwd', () => {
    const result = decideAccess({ path: 'documents/note.md', cwd: home, access: 'read', homeDir: home });
    expect(result.decision).toBe('allow');
    expect(result.resolvedPath).toBe(join(home, 'documents', 'note.md'));
  });

  it('resolves symlinked paths before matching', () => {
    const result = decideAccess({ path: join(link, 'src'), access: 'write', homeDir: home, taskWorkspace: work });
    expect(result.decision).toBe('allow');
    expect(result.matchedRule).toBe('task-workspace');
    expect(result.resolvedPath).toBe(join(realpathSync(work), 'src'));
  });

  it('asks for a sensitive READ reached through a symlinked home (write stays denied)', () => {
    const homeLink = join(root, 'link-to-home');
    symlinkSync(home, homeLink);
    const read = decideAccess({ path: join(homeLink, '.ssh', 'id_rsa'), access: 'read', homeDir: home });
    expect(read.decision).toBe('ask');
    expect(read.matchedRule).toBe('sensitive-list');
    expect(read.matchedEntry).toBe('.ssh');
    // The canonical target is what gets matched — a symlinked spelling cannot
    // downgrade a write to an approval.
    expect(decideAccess({ path: join(homeLink, '.ssh', 'id_rsa'), access: 'write', homeDir: home }).decision).toBe('deny');
  });
});

/**
 * Regression suite for the lexical-fallback bypass: a non-existent path whose
 * ancestor chain contains a symlink used to normalize to its *lexical* spelling,
 * which no longer matched the sensitive list's canonical prefix.
 */
describe('normalizePath: deepest existing ancestor through symlinked parents', () => {
  let homeLink: string;
  let realHome: string;

  beforeAll(() => {
    homeLink = join(root, 'link-to-home-anchor');
    symlinkSync(home, homeLink);
    realHome = realpathSync(home);
  });

  it('refuses a missing file under .ssh reached through a symlinked directory', () => {
    // <link>/.ssh/new_key — /tmp/link -> home, new_key does not exist.
    const target = join(homeLink, '.ssh', 'new_key');
    const normalized = normalizePath(target);
    expect(normalized).toBe(join(realHome, '.ssh', 'new_key'));
    expect(isDenied(normalized, defaultSensitivePaths(home))).toBe(true);
    expect(decideAccess({ path: target, access: 'write', homeDir: home }).decision).toBe('deny');
    // The canonical path is judged, so the read still asks for approval.
    expect(decideAccess({ path: target, access: 'read', homeDir: home }).decision).toBe('ask');
  });

  it('refuses to WRITE an existing file under .ssh reached through a symlinked directory', () => {
    const target = join(homeLink, '.ssh', 'existing_key');
    writeFileSync(join(home, '.ssh', 'existing_key'), 'secret');
    expect(realpathSync(target)).toBe(join(realHome, '.ssh', 'existing_key'));
    expect(normalizePath(target)).toBe(join(realHome, '.ssh', 'existing_key'));
    expect(decideAccess({ path: target, access: 'write', homeDir: home }).matchedRule).toBe('sensitive-list-write');
  });

  it('keeps the lexical result for missing paths with no symlinked ancestor', () => {
    const ghost = join(home, 'no-such-dir', 'no-such-file.txt');
    expect(normalizePath(ghost)).toBe(resolve(ghost));
    expect(normalizePath('no-such-dir/no-such-file.txt', { base: home })).toBe(join(home, 'no-such-dir', 'no-such-file.txt'));
    // And it must not be mistaken for something inside the sensitive list.
    expect(isDenied(normalizePath(ghost), defaultSensitivePaths(home))).toBe(false);
    expect(decideAccess({ path: ghost, access: 'read', homeDir: home }).decision).toBe('allow');
  });

  it('re-appends a deep missing tail onto the resolved ancestor', () => {
    // <link>/a/b/c — neither a, b nor c exist.
    const target = join(homeLink, 'a', 'b', 'c');
    expect(normalizePath(target)).toBe(join(realHome, 'a', 'b', 'c'));
    expect(normalizePath(`${target}/`)).toBe(join(realHome, 'a', 'b', 'c'));
    expect(normalizePath(join(homeLink, 'documents', '..', 'a', 'b', 'c'))).toBe(join(realHome, 'a', 'b', 'c'));
  });
});

/**
 * Regression suite for the single-home-anchor sensitive-list bug: with
 * `--home-dir` pointing somewhere other than the real home, the credential
 * directories under the REAL home fell outside the home-anchored list and only
 * produced a generic approval prompt (`outside-all`, no reason). The
 * anchor-independent sensitive-segment rule closes that gap: the hit is named
 * (and reads now ask *with* that context, writes are refused).
 */
describe('decideAccess: anchor-independent sensitive segments', () => {
  it('asks (with the entry named) for a READ under a root that is NOT the injected home', () => {
    // `outside` is a sibling of home — the injected homeDir does NOT contain it.
    const target = join(outside, '.ssh', 'id_rsa');
    const result = decideAccess({ path: target, access: 'read', homeDir: home });
    expect(result.decision).toBe('ask');
    expect(result.matchedRule).toBe('sensitive-list');
    expect(result.matchedEntry).toBe('.ssh');
  });

  it('splits by access: reads ask, writes are refused', () => {
    for (const [path, entry] of [
      [join(outside, '.aws', 'credentials'), '.aws'],
      [join(outside, '.netrc'), '.netrc'],
    ] as const) {
      const read = decideAccess({ path, access: 'read', homeDir: home });
      expect(read.decision).toBe('ask');
      expect(read.matchedEntry).toBe(entry);
      const write = decideAccess({ path, access: 'write', homeDir: home });
      expect(write.decision).toBe('deny');
      expect(write.matchedRule).toBe('sensitive-list-write');
    }
  });

  it('outranks every allow rule: config allowedDirs, autoAllowRoots, task allowedDirs and the workspace', () => {
    const result = decideAccess({
      path: join(outside, '.ssh', 'id_rsa'),
      access: 'read',
      homeDir: home,
      configAllowedDirs: [outside],
      autoAllowRoots: [outside],
      taskWorkspace: outside,
      taskAllowedDirs: [outside],
    });
    // None of the allow rules can launder it — the best case is an approval.
    expect(result.decision).toBe('ask');
    expect(result.matchedRule).toBe('sensitive-list');
    expect(result.matchedEntry).toBe('.ssh');
  });

  it('denies a sensitive path reached through a symlink, even when the leaf does not exist', () => {
    mkdirSync(join(outside, '.ssh'), { recursive: true });
    const linkToSsh = join(root, 'link-to-outside-ssh');
    symlinkSync(join(outside, '.ssh'), linkToSsh);
    const target = join(linkToSsh, 'missing_key'); // leaf missing on purpose
    expect(normalizePath(target)).toBe(join(outside, '.ssh', 'missing_key'));
    expect(decideAccess({ path: target, access: 'read', homeDir: home }).decision).toBe('ask');
    expect(decideAccess({ path: target, access: 'write', homeDir: home }).decision).toBe('deny');
  });

  it('denies a .ssh directory INSIDE the task workspace (intentional strictness)', () => {
    // Deliberately stricter than the workspace allow: credentials must never be
    // touched silently, even when they happen to live inside an allowed tree.
    const result = decideAccess({
      path: join(work, '.ssh', 'id_rsa'),
      access: 'write',
      homeDir: home,
      taskWorkspace: work,
      taskAllowedDirs: [work],
    });
    expect(result.decision).toBe('deny');
    expect(result.matchedRule).toBe('sensitive-list-write');
    expect(result.matchedEntry).toBe('.ssh');
  });

  it('matches WHOLE segments only: b.ssh / .sshfoo / .SSH are not sensitive', () => {
    expect(isSensitiveSegmentPath('/a/b.ssh')).toBe(false);
    expect(isSensitiveSegmentPath('/a/.sshfoo')).toBe(false);
    // Case-sensitive on Linux: .SSH is a different directory from .ssh.
    expect(isSensitiveSegmentPath('/a/.SSH')).toBe(false);
    // And decideAccess does not deny them (they fall through to ask here).
    expect(decideAccess({ path: '/a/b.ssh', access: 'read', homeDir: home }).decision).not.toBe('deny');
    expect(decideAccess({ path: '/a/.sshfoo', access: 'read', homeDir: home }).decision).not.toBe('deny');
    expect(decideAccess({ path: '/a/.SSH', access: 'read', homeDir: home }).decision).not.toBe('deny');
  });

  it('covers every configured sensitive segment anywhere in the path', () => {
    for (const segment of [
      '.ssh', '.gnupg', '.aws', '.azure', '.gcloud', '.kube',
      '.netrc', '.git-credentials', '.npmrc', '.pypirc', '.wayang',
    ]) {
      expect(isSensitiveSegmentPath(`/srv/project/${segment}`)).toBe(true);
    }
    expect(isSensitiveSegmentPath('/srv/project/.wayang.config.json')).toBe(true);
  });

  it('.docker counts only as the pair .docker/config.json', () => {
    expect(isSensitiveSegmentPath('/srv/x/.docker/config.json')).toBe(true);
    expect(isSensitiveSegmentPath('/srv/x/.docker')).toBe(false);
    expect(isSensitiveSegmentPath('/srv/x/.docker/other.json')).toBe(false);
    // The pair's entry name is the pair itself, not the bare `.docker` segment.
    expect(matchSensitiveEntry('/srv/x/.docker/config.json')).toEqual({ entry: '.docker/config.json', source: 'pair' });
  });

  it('reports the exact entry and its source for every table', () => {
    expect(matchSensitiveEntry('/srv/x/.ssh/id_rsa')).toEqual({ entry: '.ssh', source: 'segment' });
    expect(matchSensitiveEntry('/srv/x/.wayang.config.json')).toEqual({ entry: '.wayang.config.json', source: 'filename' });
    expect(matchSensitiveEntry('/srv/x/.config/gh/hosts.yml')).toBeUndefined();
    // `.config/gh` is a home-anchored (multi-segment) entry: it is reported in
    // its configured spelling when it sits under the injected home.
    expect(decideAccess({ path: join(home, '.config', 'gh', 'hosts.yml'), access: 'read', homeDir: home })).toMatchObject({
      decision: 'ask',
      matchedEntry: '.config/gh',
      matchedSource: 'home-default',
    });
  });
});

describe('decideAccess: sensitiveMode escape hatch', () => {
  it("'deny' restores the hard refusal for reads as well", () => {
    const read = decideAccess({ path: join(home, '.ssh', 'id_rsa'), access: 'read', homeDir: home, sensitiveMode: 'deny' });
    expect(read.decision).toBe('deny');
    expect(read.matchedRule).toBe('sensitive-list');
    expect(read.matchedEntry).toBe('.ssh');

    const write = decideAccess({ path: join(home, '.ssh', 'id_rsa'), access: 'write', homeDir: home, sensitiveMode: 'deny' });
    expect(write.decision).toBe('deny');
    expect(write.matchedRule).toBe('sensitive-list-write');

    // Nothing sensitive: the mode changes nothing.
    expect(decideAccess({ path: join(home, 'documents'), access: 'read', homeDir: home, sensitiveMode: 'deny' }).decision).toBe(
      'allow',
    );
  });

  it("'ask' is the default", () => {
    expect(decideAccess({ path: join(home, '.ssh', 'id_rsa'), access: 'read', homeDir: home }).decision).toBe('ask');
    expect(
      decideAccess({ path: join(home, '.ssh', 'id_rsa'), access: 'read', homeDir: home, sensitiveMode: 'ask' }).decision,
    ).toBe('ask');
  });
});
