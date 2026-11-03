import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  decideAccess,
  defaultDeniedPaths,
  isDenied,
  isPathWithin,
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

describe('defaultDeniedPaths', () => {
  it('lists the built-in credential locations under home', () => {
    const denied = defaultDeniedPaths(home);
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
    const denied = defaultDeniedPaths(home);
    expect(isDenied(join(home, '.ssh', 'id_rsa'), denied)).toBe(true);
    expect(isDenied(join(home, '.sshfoo', 'id_rsa'), denied)).toBe(false);
    expect(isDenied(join(home, '.wayang', 'sessions'), denied)).toBe(true);
  });
});

describe('decideAccess: denylist wins over every allow rule', () => {
  it('denies a path that is also inside configAllowedDirs, autoAllowRoots and the task workspace', () => {
    const result = decideAccess({
      path: join(home, '.ssh', 'id_rsa'),
      access: 'read',
      homeDir: home,
      taskWorkspace: home,
      taskAllowedDirs: [home],
      configAllowedDirs: [home],
      autoAllowRoots: [home],
    });
    expect(result).toEqual({ decision: 'deny', matchedRule: 'denylist', resolvedPath: join(home, '.ssh', 'id_rsa') });
  });

  it('denies writes into a single denied file inside the task workspace', () => {
    const result = decideAccess({
      path: join(home, '.npmrc'),
      access: 'write',
      homeDir: home,
      taskWorkspace: home,
    });
    expect(result.decision).toBe('deny');
    expect(result.matchedRule).toBe('denylist');
  });

  it('honours extraDeniedDirs and still keeps the built-in defaults', () => {
    const extra = join(work, 'private');
    const fromExtra = decideAccess({
      path: join(extra, 'notes.md'),
      access: 'read',
      homeDir: home,
      taskWorkspace: work,
      extraDeniedDirs: [extra],
    });
    expect(fromExtra.decision).toBe('deny');
    expect(fromExtra.matchedRule).toBe('denylist');

    const fromDefault = decideAccess({
      path: join(home, '.gnupg', 'key.gpg'),
      access: 'read',
      homeDir: home,
      extraDeniedDirs: [extra],
    });
    expect(fromDefault.decision).toBe('deny');
  });
});

describe('decideAccess: read vs write scope', () => {
  it('allows reading an ordinary directory inside home', () => {
    const result = decideAccess({ path: join(home, 'documents'), access: 'read', homeDir: home });
    expect(result.decision).toBe('allow');
    expect(result.matchedRule).toBe('read-within-home');
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

  it('denies a denylisted target reached through a symlinked home', () => {
    const homeLink = join(root, 'link-to-home');
    symlinkSync(home, homeLink);
    const result = decideAccess({ path: join(homeLink, '.ssh', 'id_rsa'), access: 'read', homeDir: home });
    expect(result.decision).toBe('deny');
    expect(result.matchedRule).toBe('denylist');
  });
});
