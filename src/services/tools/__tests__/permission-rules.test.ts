/**
 * Worker permission rules — now a thin adapter over the shared access policy.
 *
 * These cases document BOTH the preserved behaviour (dangerous bash commands,
 * out-of-workspace access, the relative-path and URL extraction regressions)
 * and the ONE deliberate change that came with adopting the policy: a denylist
 * hit is a hard `deny` instead of an approval prompt. The policy's
 * `read-within-home` allow is narrowed for workers — anything outside the
 * workspace / task allowedDirs / configured roots still asks, reads included.
 *
 * Every scope uses a temp HOME that CONTAINS the denylist entries, so the
 * assertions are independent of the real user's home directory.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  decideToolAccess,
  evaluateBashAccess,
  evaluateFileAccess,
  type WorkerAccessScope,
} from '@/services/tools/permission-rules';

/** Stand-in home dir containing the built-in denylisted locations. */
let home: string;
/** Task workspace — deliberately NOT inside home (mirrors a checkout elsewhere). */
let ws: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'wayang-perm-home-'));
  ws = mkdtempSync(join(tmpdir(), 'wayang-perm-ws-'));
  mkdirSync(join(home, '.ssh'), { recursive: true });
  writeFileSync(join(home, '.ssh', 'id_rsa'), 'secret');
  writeFileSync(join(home, '.zshrc'), 'export PATH');
  mkdirSync(join(home, 'docs'), { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});

function scope(overrides: Partial<WorkerAccessScope> = {}): WorkerAccessScope {
  return { homeDir: home, workspace: ws, ...overrides };
}

describe('evaluateBashAccess', () => {
  describe('destructive-command tier is preserved', () => {
    it.each([
      'rm -rf build',
      'sudo make install',
      'chmod +x deploy.sh',
      'echo hi && rm -rf build',
      'true; dd if=/dev/zero of=x bs=1 count=1',
      'cat foo | sudo tee /etc/hosts',
    ])('%s → ask', (command) => {
      expect(evaluateBashAccess(scope(), command).decision).toBe('ask');
    });
  });

  describe('paths outside the workspace still require approval', () => {
    it.each([
      'cat /etc/hosts',
      './configure --prefix=/usr/local',
      'tee /tmp/x.yml',
      'ln -s /usr/local/bin/node node',
    ])('%s → ask', (command) => {
      expect(evaluateBashAccess(scope(), command).decision).toBe('ask');
    });

    it('bash is judged as a WRITE, so a home file outside the workspace still asks', () => {
      // `~/.zshrc` is readable by the policy, but bash cannot prove the
      // command only reads, so candidates are judged as writes (strict).
      expect(evaluateBashAccess(scope(), `cat ${home}/.zshrc`).decision).toBe('ask');
      expect(evaluateBashAccess(scope(), 'cat ~/.zshrc').decision).toBe('ask');
    });

    it('absolute path inside the workspace runs', () => {
      expect(evaluateBashAccess(scope(), `cat ${ws}/src/cli.ts`).decision).toBe('allow');
    });

    it('cd into the workspace runs', () => {
      const command = `cd ${ws} && git diff v0.4.0 HEAD -- package.json`;
      expect(evaluateBashAccess(scope(), command).decision).toBe('allow');
    });
  });

  describe('regression: relative sub-paths are not absolute paths', () => {
    // The old extractor matched any /word substring, so `src/cli.ts` produced
    // the bogus absolute path `/cli.ts` and gated nearly every command.
    it.each([
      'sed -n 1,10p src/cli.ts',
      'mkdir -p build/out',
      'stat -f %z dist/cli.js',
      'wc -l < src/cli.ts',
      'npx vitest run src/services/tools/permission-rules.test.ts',
      `cd ${ws} && git diff v0.4.0 HEAD -- package.json src/types/config.ts src/types/index.ts tsconfig.json`,
    ])('%s → allow (no path candidate)', (command) => {
      const verdict = evaluateBashAccess(scope(), command);
      expect(verdict.decision).toBe('allow');
      expect(verdict.matchedRule).toBe('no-path');
    });
  });

  describe('regression: URLs are not filesystem paths', () => {
    it.each([
      'curl -s https://api.example.com/v1/data',
      'git clone https://github.com/foo/bar.git',
      'open https://github.com/foo/bar',
      'npm install axios',
    ])('%s → allow', (command) => {
      expect(evaluateBashAccess(scope(), command).decision).toBe('allow');
    });
  });

  it('plain commands run', () => {
    expect(evaluateBashAccess(scope(), 'ls -la').decision).toBe('allow');
    expect(evaluateBashAccess(scope(), 'npm test').decision).toBe('allow');
    expect(evaluateBashAccess(scope(), 'cat package.json').decision).toBe('allow');
    expect(evaluateBashAccess(scope(), 'git status').decision).toBe('allow');
  });

  describe('denylist is a hard deny and outranks every allow', () => {
    it('a denylisted path refuses the whole command', () => {
      const verdict = evaluateBashAccess(scope(), 'cat ~/.ssh/id_rsa');
      expect(verdict.decision).toBe('deny');
      expect(verdict.matchedRule).toBe('denylist');
    });

    it('deny outranks the destructive-command tier', () => {
      expect(evaluateBashAccess(scope(), 'rm -rf ~/.ssh').decision).toBe('deny');
    });

    it('one denied candidate refuses an otherwise benign command line', () => {
      expect(evaluateBashAccess(scope(), 'cat ok.txt && tee ~/.ssh/authorized_keys').decision).toBe('deny');
    });

    it('deny outranks a config allowedDirs covering the whole home', () => {
      const verdict = evaluateBashAccess(scope({ permission: { allowedDirs: [home] } }), 'cat ~/.ssh/id_rsa');
      expect(verdict.decision).toBe('deny');
    });

    it('deny outranks a task allowedDirs naming the denied dir', () => {
      const verdict = evaluateBashAccess(
        scope({ taskAllowedDirs: [join(home, '.ssh')] }),
        'cat ~/.ssh/id_rsa',
      );
      expect(verdict.decision).toBe('deny');
    });
  });

  it('a denylisted target is never reported as an allowed candidate', () => {
    // Both a permitted workspace path and a denied path in one command: the
    // first allow must not short-circuit the deny.
    const command = `cat ${ws}/README.md; cat ~/.ssh/id_rsa`;
    expect(evaluateBashAccess(scope(), command).decision).toBe('deny');
  });

  describe('~user and shell constructs that cannot be resolved statically', () => {
    it("cat ~root/.ssh/x → ask (another user's home is not resolved or allowed)", () => {
      const verdict = evaluateBashAccess(scope(), 'cat ~root/.ssh/x');
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe('home-other-user');
    });

    it('cat $HOME/.ssh/id_rsa → deny (expanded, then denied)', () => {
      const verdict = evaluateBashAccess(scope(), 'cat $HOME/.ssh/id_rsa');
      expect(verdict.decision).toBe('deny');
      expect(verdict.matchedRule).toBe('denylist');
    });

    it('cat ${HOME}/.ssh/id_rsa → deny', () => {
      expect(evaluateBashAccess(scope(), 'cat ${HOME}/.ssh/id_rsa').decision).toBe('deny');
    });

    it('echo x > $HOME/notes.txt → ask (output redirection)', () => {
      const verdict = evaluateBashAccess(scope(), 'echo x > $HOME/notes.txt');
      expect(verdict.decision).toBe('ask');
      expect(verdict.reason).toContain('output redirection');
    });

    it('cat $(echo /etc/passwd) → ask (command substitution)', () => {
      const verdict = evaluateBashAccess(scope(), 'cat $(echo /etc/passwd)');
      expect(verdict.decision).toBe('ask');
      expect(verdict.reason).toContain('command substitution');
    });

    it('backtick command substitution → ask', () => {
      const verdict = evaluateBashAccess(scope(), 'cat `echo /etc/passwd`');
      expect(verdict.decision).toBe('ask');
      expect(verdict.reason).toContain('command substitution');
    });

    it("awk '{print $1}' file is NOT command substitution and does not force an ask", () => {
      const verdict = evaluateBashAccess(scope(), "awk '{print $1}' file");
      expect(verdict.decision).toBe('allow');
      expect(verdict.matchedRule).toBe('no-path');
    });

    it('a write into the workspace via redirection still asks (target is not statically trusted)', () => {
      const verdict = evaluateBashAccess(scope(), 'echo hi > notes.txt');
      expect(verdict.decision).toBe('ask');
      expect(verdict.reason).toContain('output redirection');
    });

    it('fd duplication (2>&1) is not mistaken for a file redirection', () => {
      expect(evaluateBashAccess(scope(), 'ls -la 2>&1').decision).toBe('allow');
    });
  });
});

describe('evaluateFileAccess', () => {
  it('relative path inside the workspace runs', () => {
    expect(evaluateFileAccess(scope(), 'read_file', { path: 'src/cli.ts' }).decision).toBe('allow');
  });

  it('absolute path inside the workspace runs', () => {
    const verdict = evaluateFileAccess(scope(), 'write_file', { path: `${ws}/src/cli.ts` });
    expect(verdict.decision).toBe('allow');
    expect(verdict.matchedRule).toBe('task-workspace');
  });

  it('absolute path outside the workspace and outside home asks', () => {
    const verdict = evaluateFileAccess(scope(), 'read_file', { path: '/etc/hosts' });
    expect(verdict.decision).toBe('ask');
    expect(verdict.matchedRule).toBe('outside-all');
  });

  it('anything inside home but outside the worker scopes asks (reads AND writes)', () => {
    // The policy's `read-within-home` rule is narrowed for workers: the
    // denylist only covers credentials/tool config, so a silent read of the
    // rest of the user's home would expose .env files, keys and other
    // projects' sources. Reads there ask exactly like writes do.
    expect(evaluateFileAccess(scope(), 'read_file', { path: '~/.zshrc' }).decision).toBe('ask');
    expect(evaluateFileAccess(scope(), 'search_content', { path: '~/docs' }).decision).toBe('ask');
    expect(evaluateFileAccess(scope(), 'search_files', { path: '~' }).decision).toBe('ask');
    expect(evaluateFileAccess(scope(), 'write_file', { path: '~/.zshrc' }).decision).toBe('ask');
    expect(evaluateFileAccess(scope(), 'edit_file', { path: '~/docs/a.md' }).decision).toBe('ask');
  });

  it('task allowedDirs are honoured', () => {
    const verdict = evaluateFileAccess(scope({ taskAllowedDirs: [join(home, 'docs')] }), 'write_file', {
      path: join(home, 'docs', 'a.md'),
    });
    expect(verdict.decision).toBe('allow');
    expect(verdict.matchedRule).toBe('task-allowed');
  });

  it('config allowedDirs / autoAllowRoots are honoured', () => {
    const allowed = evaluateFileAccess(scope({ permission: { allowedDirs: [join(home, 'docs')] } }), 'write_file', {
      path: join(home, 'docs', 'a.md'),
    });
    expect(allowed.decision).toBe('allow');
    expect(allowed.matchedRule).toBe('config-allowed');

    const auto = evaluateFileAccess(scope({ permission: { autoAllowRoots: ['docs'] } }), 'write_file', {
      path: join(home, 'docs', 'a.md'),
    });
    expect(auto.decision).toBe('allow');
    expect(auto.matchedRule).toBe('auto-allow-root');
  });

  it('config deniedDirs extend the denylist', () => {
    const verdict = evaluateFileAccess(scope({ permission: { deniedDirs: ['docs'] } }), 'read_file', {
      path: join(home, 'docs', 'a.md'),
    });
    expect(verdict.decision).toBe('deny');
  });

  it('~ paths expand against the injected home, and the denylist wins', () => {
    expect(evaluateFileAccess(scope(), 'read_file', { path: '~/.ssh/id_rsa' }).decision).toBe('deny');
    // Not denylisted, but still outside the worker's scopes → asks.
    expect(evaluateFileAccess(scope(), 'read_file', { path: '~/.zshrc' }).decision).toBe('ask');
  });

  it("~user paths are not resolved and ask instead of allow", () => {
    const read = evaluateFileAccess(scope(), 'read_file', { path: '~root/.ssh/id_rsa' });
    expect(read.decision).toBe('ask');
    expect(read.matchedRule).toBe('home-other-user');
    expect(evaluateFileAccess(scope(), 'write_file', { path: '~someone/x' }).decision).toBe('ask');
  });

  it('a symlink inside the workspace cannot smuggle a denylisted path', () => {
    symlinkSync(join(home, '.ssh'), join(ws, 'link'));
    const verdict = evaluateFileAccess(scope(), 'read_file', { path: 'link/id_rsa' });
    expect(verdict.decision).toBe('deny');
    expect(verdict.matchedRule).toBe('denylist');
  });

  it('missing or non-string path is not gated', () => {
    expect(evaluateFileAccess(scope(), 'read_file', {}).decision).toBe('allow');
    expect(evaluateFileAccess(scope(), 'read_file', { path: '' }).decision).toBe('allow');
    expect(evaluateFileAccess(scope(), 'read_file', { path: 42 }).decision).toBe('allow');
  });
});

describe('decideToolAccess', () => {
  it('attaches a disclosure-safe message on deny', () => {
    const verdict = decideToolAccess(scope(), 'read_file', { path: '~/.ssh/id_rsa' });
    expect(verdict.decision).toBe('deny');
    // The worker's own spelling is echoed; the denylist entry is not named.
    expect(verdict.message).toContain('~/.ssh/id_rsa');
    expect(verdict.message).toContain('deny list');
  });

  it('does not echo any path for a denied bash command', () => {
    const verdict = decideToolAccess(scope(), 'bash', { command: 'cat ~/.ssh/id_rsa' });
    expect(verdict.decision).toBe('deny');
    expect(verdict.message).not.toContain('.ssh');
    expect(verdict.message).toContain('deny list');
  });

  it('leaves allow/ask verdicts without a message', () => {
    expect(decideToolAccess(scope(), 'bash', { command: 'ls' }).message).toBeUndefined();
    expect(decideToolAccess(scope(), 'read_file', { path: '/etc/hosts' }).message).toBeUndefined();
  });
});

/**
 * Regression: with `--home-dir` pointing at a directory that is NOT the real
 * home, the real home's credential dirs sit outside the home anchor. They must
 * still be a hard DENY (no approval request), not an "outside-all → ask".
 */
describe('anchor-independent denylist: real home outside the injected home', () => {
  let realHome: string;

  beforeEach(() => {
    realHome = mkdtempSync(join(tmpdir(), 'wayang-real-home-'));
    mkdirSync(join(realHome, '.ssh'), { recursive: true });
    writeFileSync(join(realHome, '.ssh', 'id_rsa'), 'PRIVATE');
    writeFileSync(join(realHome, 'notes.txt'), 'public');
  });

  afterEach(() => {
    rmSync(realHome, { recursive: true, force: true });
  });

  it('read_file on <realHome>/.ssh/id_rsa → deny (no approval prompt)', () => {
    const verdict = decideToolAccess(scope(), 'read_file', { path: join(realHome, '.ssh', 'id_rsa') });
    expect(verdict.decision).toBe('deny');
    expect(verdict.matchedRule).toBe('denylist');
    expect(verdict.message).toContain('deny list');
  });

  it('bash `cat <realHome>/.ssh/id_rsa` → deny (no approval prompt)', () => {
    const verdict = decideToolAccess(scope(), 'bash', { command: `cat ${join(realHome, '.ssh', 'id_rsa')}` });
    expect(verdict.decision).toBe('deny');
  });

  it('a non-sensitive file in the real home still asks (the rule is segment-scoped)', () => {
    const verdict = decideToolAccess(scope(), 'read_file', { path: join(realHome, 'notes.txt') });
    expect(verdict.decision).toBe('ask');
  });
});
