/**
 * Worker permission rules — now a thin adapter over the shared access policy.
 *
 * These cases document BOTH the preserved behaviour (dangerous bash commands,
 * out-of-workspace access, the relative-path and URL extraction regressions)
 * and the 0.8.1 sensitive-list split: a sensitive hit on a READ is an approval
 * prompt (with the matched entry reported), while a sensitive hit on a WRITE is
 * still a hard `deny` — an approval prompt for rewriting `authorized_keys` must
 * not exist. The policy's `read-within-home` allow is narrowed for workers —
 * anything outside the workspace / task allowedDirs / configured roots still
 * asks, reads included.
 *
 * Every scope uses a temp HOME that CONTAINS the sensitive entries, so the
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

/** Stand-in home dir containing the built-in sensitive locations. */
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

  /**
   * #42: the destructive tier must not swallow the sensitive hit the candidate
   * sweep already found — a `sudo cat ~/.ssh/id_rsa` approval has to say BOTH
   * "dangerous command" and "touches .ssh".
   */
  describe('the destructive tier keeps the sensitive hit it found (#42)', () => {
    it('sudo cat ~/.ssh/id_rsa → ask, dangerous rule PLUS the .ssh hit', () => {
      const verdict = evaluateBashAccess(scope(), 'sudo cat ~/.ssh/id_rsa');
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe('dangerous-bash');
      expect(verdict.matchedEntry).toBe('.ssh');
      expect(verdict.matchedSource).toBe('segment');
      expect(verdict.resolvedPath).toBe(join(home, '.ssh', 'id_rsa'));
      expect(verdict.sensitive).toBe(true);
      // `cat` is on the read-only table (the `sudo` prefix is stripped before
      // the lookup), so the direction is read — the danger rule still asks.
      expect(verdict.access).toBe('read');
    });

    it('sudo cat /etc/hostname → ask with NO hit (nothing sensitive to report)', () => {
      const verdict = evaluateBashAccess(scope(), 'sudo cat /etc/hostname');
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe('dangerous-bash');
      expect(verdict.matchedEntry).toBeUndefined();
      expect(verdict.matchedSource).toBeUndefined();
      expect(verdict.sensitive).toBeUndefined();
    });

    it('a dangerous command pointing at a write reports access: write', () => {
      expect(evaluateBashAccess(scope(), 'sudo tee /tmp/x.yml').access).toBe('write');
      // Mixed candidates: the strictest access wins (write > unknown).
      const mixed = evaluateBashAccess(scope(), 'sudo cat /etc/hostname && tee /tmp/y.yml');
      expect(mixed.matchedRule).toBe('dangerous-bash');
      expect(mixed.access).toBe('write');
    });

    it('a sensitive WRITE is still a hard deny, dangerous command or not', () => {
      for (const command of [
        'sudo rm -rf ~/.ssh',
        'sudo tee ~/.ssh/authorized_keys x',
        'sudo dd if=x of=$HOME/.ssh/id_rsa',
      ]) {
        const verdict = evaluateBashAccess(scope(), command);
        expect(verdict.decision).toBe('deny');
        expect(verdict.matchedRule).toBe('sensitive-list-write');
      }
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

  describe('the sensitive list outranks every allow: reads ask, writes are refused', () => {
    it('a sensitive READ asks, naming the matched entry', () => {
      const verdict = evaluateBashAccess(scope(), 'cat ~/.ssh/id_rsa');
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe('sensitive-list');
      expect(verdict.matchedEntry).toBe('.ssh');
      expect(verdict.access).toBe('read');
    });

    it('a sensitive WRITE is refused (and outranks the destructive-command tier)', () => {
      for (const command of ['rm -rf ~/.ssh', 'tee ~/.ssh/authorized_keys x', 'dd if=x of=$HOME/.ssh/id_rsa']) {
        const verdict = evaluateBashAccess(scope(), command);
        expect(verdict.decision).toBe('deny');
        expect(verdict.matchedRule).toBe('sensitive-list-write');
      }
    });

    it('one sensitive WRITE candidate refuses an otherwise benign command line', () => {
      expect(evaluateBashAccess(scope(), 'cat ok.txt && tee ~/.ssh/authorized_keys').decision).toBe('deny');
      // …while a read-only mix only asks (every candidate is a read).
      expect(evaluateBashAccess(scope(), 'cat ok.txt && cat ~/.ssh/id_rsa').decision).toBe('ask');
    });

    it('an output redirection into a sensitive path counts as a write (never an approvable read)', () => {
      const verdict = evaluateBashAccess(scope(), 'echo key > ~/.ssh/authorized_keys');
      expect(verdict.decision).toBe('deny');
      expect(verdict.matchedRule).toBe('sensitive-list-write');
    });

    it('the allow rules cannot launder a sensitive read', () => {
      const withAllowed = evaluateBashAccess(scope({ permission: { allowedDirs: [home] } }), 'cat ~/.ssh/id_rsa');
      expect(withAllowed.decision).toBe('ask');
      expect(withAllowed.matchedRule).toBe('sensitive-list');

      const withTaskGrant = evaluateBashAccess(scope({ taskAllowedDirs: [join(home, '.ssh')] }), 'cat ~/.ssh/id_rsa');
      expect(withTaskGrant.decision).toBe('ask');
      expect(withTaskGrant.matchedRule).toBe('sensitive-list');
    });
  });

  it('a sensitive target is never reported as an allowed candidate', () => {
    // Both a permitted workspace path and a sensitive path in one command: the
    // workspace allow must not short-circuit the sensitive verdict.
    const command = `cat ${ws}/README.md; cat ~/.ssh/id_rsa`;
    const verdict = evaluateBashAccess(scope(), command);
    expect(verdict.decision).toBe('ask');
    expect(verdict.matchedRule).toBe('sensitive-list');
  });

  it('a read candidate inside the workspace runs (the workspace allow is access-agnostic)', () => {
    const verdict = evaluateBashAccess(scope(), `cat ${ws}/README.md`);
    expect(verdict.decision).toBe('allow');
    expect(verdict.matchedRule).toBe('task-workspace');
    // The direction is reported, not used to gate: the workspace allow does not
    // depend on it, and a write here would still ask for the redirection tier.
    expect(verdict.access).toBe('read');
  });

  describe('~user and shell constructs that cannot be resolved statically', () => {
    it("cat ~root/.ssh/x → ask (another user's home is not resolved or allowed)", () => {
      const verdict = evaluateBashAccess(scope(), 'cat ~root/.ssh/x');
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe('home-other-user');
    });

    it('cat $HOME/.ssh/id_rsa → ask (expanded, then matched as a sensitive read)', () => {
      const verdict = evaluateBashAccess(scope(), 'cat $HOME/.ssh/id_rsa');
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe('sensitive-list');
      expect(verdict.matchedEntry).toBe('.ssh');
    });

    it('cat ${HOME}/.ssh/id_rsa → ask', () => {
      const verdict = evaluateBashAccess(scope(), 'cat ${HOME}/.ssh/id_rsa');
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedEntry).toBe('.ssh');
    });

    it('rm $HOME/.ssh/id_rsa → deny (the write variant keeps the hard refusal)', () => {
      const verdict = evaluateBashAccess(scope(), 'rm $HOME/.ssh/id_rsa');
      expect(verdict.decision).toBe('deny');
      expect(verdict.matchedRule).toBe('sensitive-list-write');
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

  /**
   * 0.8.1 PR2: the diagnostics idioms that used to ask for no reason. A
   * discard target (`/dev/null`, `/dev/stdout`, `/dev/stderr`) is not a file
   * write, and `2>&1` retargets a descriptor rather than opening a path — so
   * neither may reach the "output redirection" escalation.
   */
  describe('discard redirections and fd duplication are exempt', () => {
    it.each([
      'ls -la >/dev/null',
      'ls -la 2>/dev/null',
      'ls -la >>/dev/null',
      'ls -la &>/dev/null',
      'ls -la &>>/dev/null',
      'ls -la >/dev/stdout',
      'ls -la 2>/dev/stderr',
      'ls -la > /dev/null 2>&1',
      'ls -la 2>&1',
      'ls -la >&2',
      'ls -la 1>&2',
      'tee /dev/null',
    ])('%s → allow (writes no file)', (command) => {
      const verdict = evaluateBashAccess(scope(), command);
      expect(verdict.decision).toBe('allow');
      expect(verdict.reason).toBeUndefined();
    });

    it('the two reported false positives no longer ask', () => {
      const probe = evaluateBashAccess(
        scope(),
        'command -v waya >/dev/null 2>&1 && readlink -f "$(command -v waya)"',
      );
      expect(probe.decision).toBe('allow');
      const listing = evaluateBashAccess(scope(), 'npm ls -g --depth=0 2>/dev/null | grep -i waya');
      expect(listing.decision).toBe('allow');
    });

    it('a redirection into a real file still asks (workspace, absolute, mixed)', () => {
      // Inside the workspace the policy would allow the write; a redirected
      // write is still not something the gate runs silently.
      const relative = evaluateBashAccess(scope(), 'echo hi > out.txt');
      expect(relative.decision).toBe('ask');
      expect(relative.reason).toContain('output redirection');
      expect(evaluateBashAccess(scope(), `echo hi > ${ws}/out.txt`).decision).toBe('ask');
      // …and out of the workspace it keeps its policy verdict.
      expect(evaluateBashAccess(scope(), 'echo hi > /etc/passwd').decision).toBe('ask');
      // Only the real target is to blame in a mixed command line.
      const mixed = evaluateBashAccess(scope(), 'ls -la >/dev/null && echo x > real.txt');
      expect(mixed.decision).toBe('ask');
      expect(mixed.reason).toContain('real.txt');
    });

    it('an fd copy of a discard target is not a path candidate', () => {
      expect(evaluateBashAccess(scope(), `ls ${ws} 2>/dev/null >/dev/null`).decision).toBe('allow');
    });
  });

  /**
   * 0.8.1 PR2: a command substitution is exempt when the command inside it is
   * read-only, and that inner command is judged by the ordinary rules — so the
   * reason for an approval names the target instead of the `$(`.
   */
  describe('command substitution: a read-only inner command is exempt', () => {
    it.each([
      'readlink -f "$(command -v waya)"',
      'echo $(pwd)',
      'echo $(date)',
      'echo `date`',
      'cat $(cat notes.txt)',
      'echo "x $(date)"',
      'echo $(echo $(date))',
      // #47: one read-only table for both classifiers — a `git` READ subcommand
      // is as exempt inside a substitution as it is at the top level.
      'echo $(git status)',
      "echo 'a`b'",
      "echo '$(date)'",
    ])('%s → allow', (command) => {
      expect(evaluateBashAccess(scope(), command).decision).toBe('allow');
    });

    it('an inner target outside the workspace still asks, naming the path', () => {
      const verdict = evaluateBashAccess(scope(), 'echo $(cat /etc/passwd)');
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe('dynamic-shell');
      expect(verdict.reason).toContain('/etc/passwd');
    });

    it('a non-read-only inner command asks', () => {
      for (const command of ['echo $(rm -rf /)', 'echo $(python -V)', 'echo $(cat a.txt | tee b.txt)']) {
        const verdict = evaluateBashAccess(scope(), command);
        expect(verdict.decision).toBe('ask');
        expect(verdict.matchedRule).toBe('dynamic-shell');
      }
    });

    it('backticked substitutions follow the same rules', () => {
      expect(evaluateBashAccess(scope(), 'readlink -f `command -v waya`').decision).toBe('allow');
      const verdict = evaluateBashAccess(scope(), 'cat `echo /etc/passwd`');
      expect(verdict.decision).toBe('ask');
      expect(verdict.reason).toContain('/etc/passwd');
    });

    it('nesting is followed up to the depth limit', () => {
      const nested = (levels: number): string => {
        let command = 'date';
        for (let i = 0; i < levels; i += 1) command = `echo $(${command})`;
        return command;
      };
      expect(evaluateBashAccess(scope(), nested(3)).decision).toBe('allow');
      const tooDeep = evaluateBashAccess(scope(), nested(6));
      expect(tooDeep.decision).toBe('ask');
      expect(tooDeep.reason).toContain('nested');
    });

    it.each(["echo 'abc", 'echo "abc', 'echo $(date', 'cat <<EOF'])(
      '%s → ask (the command cannot be parsed)',
      (command) => {
        const verdict = evaluateBashAccess(scope(), command);
        expect(verdict.decision).toBe('ask');
        expect(verdict.matchedRule).toBe('dynamic-shell');
      },
    );

    it('a sensitive path inside a substitution is still a write refusal / read ask', () => {
      const read = evaluateBashAccess(scope(), 'cat "$(cat $HOME/.ssh/id_rsa)"');
      expect(read.decision).toBe('ask');
      // The inner hit survives the wrap: the approval still names the entry.
      expect(read.matchedEntry).toBe('.ssh');
      expect(read.resolvedPath).toBe(join(home, '.ssh', 'id_rsa'));
      // A broken command mentioning a sensitive path keeps the hard refusal.
      const broken = evaluateBashAccess(scope(), 'tee ~/.ssh/authorized_keys "x');
      expect(broken.decision).toBe('deny');
      expect(broken.matchedRule).toBe('sensitive-list-write');
    });
  });

  /**
   * #47: bash candidates now have a third direction. A hit on the read-only
   * table is `read` — the direction the audit trail and the approval request
   * report — but the worker's scope is UNCHANGED: a read inside home but
   * outside the workspace / task allowedDirs / configured roots is still an
   * approval, now labelled `read-within-home` instead of falling through to
   * `outside-all` as an unknown.
   *
   * The two halves are equally important: the positives below prove the
   * classification (and the prefix stripping) works, the negatives prove it did
   * not become a way to run writes silently.
   */
  describe('#47 read-only commands are classified as reads', () => {
    it.each([
      'cat ~/notes.md',
      'grep -rn x ~/proj',
      'ls ~/dotfiles',
      'wc -l ~/notes.md',
      'sed -n 1,5p ~/notes.md',
      'find ~/docs -name x',
      'head -3 ~/notes.md',
      'rg TODO ~/proj',
      'diff ~/a.md ~/b.md',
      'du -sh ~/proj',
    ])('%s → read, and the home read is still narrowed to ask', (command) => {
      const verdict = evaluateBashAccess(scope(), command);
      expect(verdict.access).toBe('read');
      expect(verdict.matchedRule).toBe('read-within-home');
      expect(verdict.decision).toBe('ask');
    });

    it.each([
      ['sudo cat ~/notes.md', 'dangerous-bash'],
      ['sudo -u root cat ~/notes.md', 'dangerous-bash'],
      ['env FOO=1 cat ~/notes.md', 'read-within-home'],
      ['env -i FOO=bar cat ~/notes.md', 'read-within-home'],
      ['nohup cat ~/notes.md', 'read-within-home'],
      ['time cat ~/notes.md', 'read-within-home'],
      ['nice -n 5 cat ~/notes.md', 'read-within-home'],
      ['FOO=1 cat ~/notes.md', 'read-within-home'],
      ['command cat ~/notes.md', 'read-within-home'],
    ])('the wrapper prefix is stripped: %s → read (ask via %s)', (command, rule) => {
      const verdict = evaluateBashAccess(scope(), command);
      expect(verdict.access).toBe('read');
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe(rule);
    });

    it('a read-only line with no absolute path is allowed and audited as read', () => {
      for (const command of ['git status', 'git log --oneline -5', 'git --no-pager diff HEAD']) {
        const verdict = evaluateBashAccess(scope(), command);
        expect(verdict.decision).toBe('allow');
        expect(verdict.matchedRule).toBe('no-path');
        expect(verdict.access).toBe('read');
      }
      // `git branch` / `git remote` read only with an explicit list flag.
      for (const command of ['git branch -a', 'git branch --list', 'git remote -v']) {
        expect(evaluateBashAccess(scope(), command).access).toBe('read');
        expect(evaluateBashAccess(scope(), command).decision).toBe('allow');
      }
      expect(evaluateBashAccess(scope(), 'ls -la').access).toBe('read');
      expect(evaluateBashAccess(scope(), 'pwd').access).toBe('read');
    });

    it('a read inside the workspace is (as before) allowed, now reported as read', () => {
      const verdict = evaluateBashAccess(scope(), `git -C ${ws} status`);
      expect(verdict.decision).toBe('allow');
      expect(verdict.matchedRule).toBe('task-workspace');
      expect(verdict.access).toBe('read');
    });

    it.each([
      ['rm -rf ~/x', 'write'],
      ['find ~/x -delete', 'write'],
      ['find ~/x -fprint0 /tmp/x', 'write'],
      ['sed -i s/a/b/ ~/f', 'write'],
      ['sed -i.bak s/a/b/ ~/f', 'write'],
      ['cat ~/a > ~/b', 'write'],
      ['cat ~/notes.md && rm ~/x', 'write'],
    ])('%s → never read (the line writes)', (command, access) => {
      const verdict = evaluateBashAccess(scope(), command);
      expect(verdict.access).toBe(access);
      expect(verdict.access).not.toBe('read');
    });

    it.each([
      'find . -exec rm {} \\;',
      'tar -xf a.tar',
      'git clean -fdx',
      'git checkout -- .',
      'git branch -D x',
      'git remote add origin x',
      'python x.py',
      'make',
      'npm run build',
    ])('%s stays unknown (not on the read-only table)', (command) => {
      const verdict = evaluateBashAccess(scope(), command);
      expect(verdict.access).toBe('unknown');
    });

    it('a write hidden inside a command substitution keeps the line out of read', () => {
      const verdict = evaluateBashAccess(scope(), 'echo $(rm -rf ~/x)');
      expect(verdict.decision).toBe('ask');
      expect(verdict.access).not.toBe('read');
    });

    it('the sensitive list still outranks the read classification', () => {
      const read = evaluateBashAccess(scope(), 'cat ~/.ssh/id_rsa');
      expect(read.access).toBe('read');
      expect(read.decision).toBe('ask');
      expect(read.matchedRule).toBe('sensitive-list');
      expect(read.matchedEntry).toBe('.ssh');
      // …and a write that TOUCHES a sensitive path is still a hard refusal,
      // even though the verb itself (`cp`) is not a read.
      const write = evaluateBashAccess(scope(), 'cp ~/notes.md ~/.ssh/id_rsa');
      expect(write.decision).toBe('deny');
      expect(write.matchedRule).toBe('sensitive-list-write');
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
    // sensitive list only covers credentials/tool config, so a silent read of the
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

  it('config sensitiveDirs extend the sensitive list (read asks, write denied)', () => {
    const read = evaluateFileAccess(scope({ permission: { sensitiveDirs: ['docs'] } }), 'read_file', {
      path: join(home, 'docs', 'a.md'),
    });
    expect(read.decision).toBe('ask');
    expect(read.matchedEntry).toBe('docs');
    expect(read.matchedRule).toBe('sensitive-list');

    const write = evaluateFileAccess(scope({ permission: { sensitiveDirs: ['docs'] } }), 'write_file', {
      path: join(home, 'docs', 'a.md'),
      content: 'x',
    });
    expect(write.decision).toBe('deny');
    expect(write.matchedRule).toBe('sensitive-list-write');
  });

  it('the deprecated deniedDirs alias protects exactly like sensitiveDirs', () => {
    const read = evaluateFileAccess(scope({ permission: { deniedDirs: ['docs'] } }), 'read_file', {
      path: join(home, 'docs', 'a.md'),
    });
    expect(read.decision).toBe('ask');
    expect(read.matchedEntry).toBe('docs');
    expect(read.matchedRule).toBe('sensitive-list');
  });

  it('sensitiveMode: deny restores the hard refusal for sensitive reads', () => {
    const verdict = evaluateFileAccess(
      scope({ permission: { sensitiveMode: 'deny' } }),
      'read_file',
      { path: '~/.ssh/id_rsa' },
    );
    expect(verdict.decision).toBe('deny');
    expect(verdict.matchedRule).toBe('sensitive-list');
    // Writes are refused either way.
    expect(
      evaluateFileAccess(scope({ permission: { sensitiveMode: 'deny' } }), 'write_file', {
        path: '~/.ssh/id_rsa',
        content: 'x',
      }).decision,
    ).toBe('deny');
  });

  it('~ paths expand against the injected home, and the sensitive list wins', () => {
    const readKey = evaluateFileAccess(scope(), 'read_file', { path: '~/.ssh/id_rsa' });
    expect(readKey.decision).toBe('ask');
    expect(readKey.matchedEntry).toBe('.ssh');
    expect(readKey.resolvedPath).toBe(join(home, '.ssh', 'id_rsa'));
    // A sensitive WRITE inside the task workspace is still refused, even
    // though the workspace would otherwise allow the write.
    const writeKey = evaluateFileAccess(scope({ taskAllowedDirs: [join(home, '.ssh')] }), 'write_file', {
      path: join(home, '.ssh', 'authorized_keys'),
      content: 'x',
    });
    expect(writeKey.decision).toBe('deny');
    expect(writeKey.matchedRule).toBe('sensitive-list-write');
    // Not sensitive, but still outside the worker's scopes → asks.
    expect(evaluateFileAccess(scope(), 'read_file', { path: '~/.zshrc' }).decision).toBe('ask');
  });

  it("~user paths are not resolved and ask instead of allow", () => {
    const read = evaluateFileAccess(scope(), 'read_file', { path: '~root/.ssh/id_rsa' });
    expect(read.decision).toBe('ask');
    expect(read.matchedRule).toBe('home-other-user');
    expect(evaluateFileAccess(scope(), 'write_file', { path: '~someone/x' }).decision).toBe('ask');
  });

  it('a symlink inside the workspace cannot smuggle a sensitive path', () => {
    symlinkSync(join(home, '.ssh'), join(ws, 'link'));
    // Reading asks (with the entry named) — the link does not become an allow.
    const read = evaluateFileAccess(scope(), 'read_file', { path: 'link/id_rsa' });
    expect(read.decision).toBe('ask');
    expect(read.matchedRule).toBe('sensitive-list');
    expect(read.matchedEntry).toBe('.ssh');
    // Writing through the same link stays a hard refusal.
    const write = evaluateFileAccess(scope(), 'write_file', { path: 'link/id_rsa', content: 'x' });
    expect(write.decision).toBe('deny');
    expect(write.matchedRule).toBe('sensitive-list-write');
  });

  it('missing or non-string path is not gated', () => {
    expect(evaluateFileAccess(scope(), 'read_file', {}).decision).toBe('allow');
    expect(evaluateFileAccess(scope(), 'read_file', { path: '' }).decision).toBe('allow');
    expect(evaluateFileAccess(scope(), 'read_file', { path: 42 }).decision).toBe('allow');
  });
});

describe('decideToolAccess', () => {
  it('attaches a disclosure-safe message on a sensitive write', () => {
    const verdict = decideToolAccess(scope(), 'write_file', { path: '~/.ssh/authorized_keys', content: 'x' });
    expect(verdict.decision).toBe('deny');
    // The worker's own spelling is echoed; the sensitive entry is not named.
    expect(verdict.message).toContain('~/.ssh/authorized_keys');
    expect(verdict.message).toContain('sensitive list');
    expect(verdict.message).toContain('never writable');
    expect(verdict.message).not.toContain('.ssh (');
  });

  it('does not echo any path or entry for a denied bash command', () => {
    const verdict = decideToolAccess(scope(), 'bash', { command: 'rm -rf ~/.ssh' });
    expect(verdict.decision).toBe('deny');
    expect(verdict.message).not.toContain('.ssh');
    expect(verdict.message).toContain('sensitive list');
  });

  it('leaves allow/ask verdicts without a message', () => {
    expect(decideToolAccess(scope(), 'bash', { command: 'ls' }).message).toBeUndefined();
    expect(decideToolAccess(scope(), 'read_file', { path: '/etc/hosts' }).message).toBeUndefined();
    // A sensitive READ asks with the hit reported, but carries no refusal text.
    const ask = decideToolAccess(scope(), 'read_file', { path: '~/.ssh/id_rsa' });
    expect(ask.decision).toBe('ask');
    expect(ask.message).toBeUndefined();
    expect(ask.matchedEntry).toBe('.ssh');
  });
});

/**
 * Regression: with `--home-dir` pointing at a directory that is NOT the real
 * home, the real home's credential dirs sit outside the home anchor. They must
 * still be recognized as sensitive — a read asks WITH the entry named (not a
 * bare "outside-all"), and a write is refused outright.
 */
describe('anchor-independent sensitive list: real home outside the injected home', () => {
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

  it('read_file on <realHome>/.ssh/id_rsa → ask, with the entry named', () => {
    const verdict = decideToolAccess(scope(), 'read_file', { path: join(realHome, '.ssh', 'id_rsa') });
    expect(verdict.decision).toBe('ask');
    expect(verdict.matchedRule).toBe('sensitive-list');
    expect(verdict.matchedEntry).toBe('.ssh');
    expect(verdict.sensitive).toBe(true);
  });

  it('write_file on <realHome>/.ssh/id_rsa → deny (sensitive paths are never writable)', () => {
    const verdict = decideToolAccess(scope(), 'write_file', {
      path: join(realHome, '.ssh', 'id_rsa'),
      content: 'x',
    });
    expect(verdict.decision).toBe('deny');
    expect(verdict.matchedRule).toBe('sensitive-list-write');
    expect(verdict.message).toContain('sensitive list');
  });

  it('bash `cat <realHome>/.ssh/id_rsa` → ask (a read is not a refusal)', () => {
    const verdict = decideToolAccess(scope(), 'bash', { command: `cat ${join(realHome, '.ssh', 'id_rsa')}` });
    expect(verdict.decision).toBe('ask');
    expect(verdict.matchedEntry).toBe('.ssh');
  });

  it('a non-sensitive file in the real home still asks (the rule is segment-scoped)', () => {
    const verdict = decideToolAccess(scope(), 'read_file', { path: join(realHome, 'notes.txt') });
    expect(verdict.decision).toBe('ask');
  });
});

/**
 * 0.8.3: wayang's OWN paths are released from the sensitive list — both the
 * `~/.wayang` data directory (a worker can drop temp files there and read its
 * own session) and the `~/.wayang.config.json` config file (the worker has to
 * read its own config). Neither is a third-party credential, so both fall
 * through to the ordinary scope rules: a read inside home is still narrowed to
 * `ask`, and a write outside the workspace still asks.
 */
describe("wayang's own paths are released (0.8.3)", () => {
  beforeEach(() => {
    mkdirSync(join(home, '.wayang', 'tmp'), { recursive: true });
    writeFileSync(join(home, '.wayang', 'tmp', 'a.txt'), 'scratch');
    writeFileSync(join(home, '.wayang.config.json'), '{"apiKey":"secret"}');
  });

  it('read_file on ~/.wayang/tmp/a.txt → ask via the home rule, NOT the sensitive list', () => {
    const verdict = evaluateFileAccess(scope(), 'read_file', { path: '~/.wayang/tmp/a.txt' });
    // The policy allows (read-inside-home); the worker narrows that to `ask`.
    expect(verdict.decision).toBe('ask');
    expect(verdict.matchedRule).toBe('read-within-home');
    expect(verdict.matchedRule).not.toBe('sensitive-list');
    expect(verdict.sensitive).toBeUndefined();
    expect(verdict.matchedEntry).toBeUndefined();
  });

  it('write_file on ~/.wayang/tmp/a.txt is no longer denied', () => {
    const verdict = evaluateFileAccess(scope(), 'write_file', { path: '~/.wayang/tmp/a.txt' });
    expect(verdict.decision).not.toBe('deny');
    expect(verdict.matchedRule).not.toBe('sensitive-list-write');
    expect(verdict.decision).toBe('ask');
    expect(verdict.message).toBeUndefined();
  });

  it('edit_file on ~/.wayang/tmp/a.txt is no longer denied', () => {
    const verdict = evaluateFileAccess(scope(), 'edit_file', { path: join(home, '.wayang', 'tmp', 'a.txt') });
    expect(verdict.decision).toBe('ask');
    expect(verdict.matchedRule).not.toBe('sensitive-list-write');
  });

  it('bash redirect into ~/.wayang/tmp is not a sensitive write', () => {
    const verdict = decideToolAccess(scope(), 'bash', { command: 'echo hi > ~/.wayang/tmp/a.txt' });
    expect(verdict.decision).not.toBe('deny');
    expect(verdict.matchedRule).not.toBe('sensitive-list-write');
    expect(verdict.sensitive).toBeUndefined();
  });

  it('bash reading inside ~/.wayang does not name a sensitive entry', () => {
    const verdict = evaluateBashAccess(scope(), 'cat ~/.wayang/tmp/a.txt');
    expect(verdict.decision).not.toBe('deny');
    expect(verdict.matchedEntry).toBeUndefined();
    expect(verdict.sensitive).toBeUndefined();
  });

  it('a workspace-level config granting ~/.wayang now allows writes there', () => {
    const verdict = evaluateFileAccess(scope({ permission: { allowedDirs: [join(home, '.wayang')] } }), 'write_file', {
      path: '~/.wayang/tmp/b.txt',
    });
    expect(verdict.decision).toBe('allow');
    expect(verdict.matchedRule).toBe('config-allowed');
  });

  it('read_file on ~/.wayang.config.json is no longer a sensitive hit', () => {
    const read = evaluateFileAccess(scope(), 'read_file', { path: '~/.wayang.config.json' });
    // No sensitive entry: it is an ordinary "read inside home", which the
    // worker layer still narrows to an approval.
    expect(read.matchedRule).not.toBe('sensitive-list');
    expect(read.matchedRule).toBe('read-within-home');
    expect(read.matchedEntry).toBeUndefined();
    expect(read.sensitive).toBeUndefined();
    expect(read.decision).toBe('ask');
  });

  it('write_file on ~/.wayang.config.json is no longer denied', () => {
    const write = decideToolAccess(scope(), 'write_file', { path: '~/.wayang.config.json', content: 'x' });
    expect(write.decision).not.toBe('deny');
    expect(write.matchedRule).not.toBe('sensitive-list-write');
    // It asks like any other write outside the workspace.
    expect(write.decision).toBe('ask');
    expect(write.matchedEntry).toBeUndefined();
    expect(write.sensitive).toBeUndefined();
  });

  it('bash `cat ~/.wayang.config.json` reports no sensitive hit', () => {
    const verdict = evaluateBashAccess(scope(), 'cat ~/.wayang.config.json');
    expect(verdict.decision).not.toBe('deny');
    expect(verdict.matchedRule).not.toBe('sensitive-list');
    expect(verdict.matchedEntry).toBeUndefined();
    expect(verdict.sensitive).toBeUndefined();
    // Still an approval — reading outside the workspace is not silent.
    expect(verdict.decision).toBe('ask');
  });

  it('bash writing ~/.wayang.config.json is no longer refused', () => {
    const verdict = evaluateBashAccess(scope(), 'echo {} > ~/.wayang.config.json');
    expect(verdict.decision).not.toBe('deny');
    expect(verdict.matchedRule).not.toBe('sensitive-list-write');
    expect(verdict.decision).toBe('ask');
  });

  /**
   * The general workspace (`<wayangDir>/workspace`, i.e. ~/.wayang/workspace)
   * is a legitimate task workspace: everything inside it is workspace-scoped,
   * so it needs neither an approval nor a task grant — the point of a shared
   * directory for work that belongs to no codebase.
   */
  it('the general workspace works as a task workspace (inside is silently allowed)', () => {
    const generalWs = join(home, '.wayang', 'workspace');
    mkdirSync(join(generalWs, '.agents', 'tmp'), { recursive: true });
    const generalScope = scope({ workspace: generalWs });

    expect(evaluateFileAccess(generalScope, 'write_file', { path: join(generalWs, 'notes.md') })).toMatchObject({
      decision: 'allow',
      matchedRule: 'task-workspace',
    });
    expect(
      decideToolAccess(generalScope, 'write_file', {
        path: join(generalWs, '.agents', 'tmp', 'scratch.txt'),
        content: 'x',
      }).decision,
    ).toBe('allow');
    expect(
      decideToolAccess(generalScope, 'bash', { command: `mkdir -p ${join(generalWs, '.agents', 'tmp')}` }).decision,
    ).toBe('allow');
    expect(
      evaluateBashAccess(generalScope, `cat ${join(generalWs, 'notes.md')}`).decision,
    ).toBe('allow');
  });

  it('third-party credentials are unaffected (regression)', () => {
    for (const path of ['~/.ssh/id_rsa', '~/.aws/credentials', '~/.npmrc']) {
      const read = evaluateFileAccess(scope(), 'read_file', { path });
      expect(read.decision).toBe('ask');
      expect(read.matchedRule).toBe('sensitive-list');
      expect(read.sensitive).toBe(true);
      expect(read.matchedEntry).toBe(path.split('/')[1]);

      const write = decideToolAccess(scope(), 'write_file', { path, content: 'x' });
      expect(write.decision).toBe('deny');
      expect(write.matchedRule).toBe('sensitive-list-write');
      expect(write.message).toContain('sensitive list');
    }
    // `.env` was never on the sensitive list; it keeps its old shape — an
    // approval on both directions, never a silent read and never a deny.
    expect(evaluateFileAccess(scope(), 'read_file', { path: '~/.env' })).toMatchObject({
      decision: 'ask',
      matchedRule: 'read-within-home',
    });
    expect(evaluateFileAccess(scope(), 'read_file', { path: '~/.env' }).matchedEntry).toBeUndefined();
    const envWrite = evaluateFileAccess(scope(), 'write_file', { path: '~/.env' });
    expect(envWrite.decision).toBe('ask');
    expect(envWrite.matchedRule).toBe('outside-all');
    // A plain home file keeps the same "ask, not sensitive" shape as ~/.wayang.
    expect(evaluateFileAccess(scope(), 'read_file', { path: '~/.zshrc' }).matchedRule).toBe('read-within-home');
  });
});
