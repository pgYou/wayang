/**
 * Worker permission rules — now a thin adapter over the shared access policy.
 *
 * These cases document BOTH the preserved behaviour (dangerous bash commands,
 * out-of-workspace access, the relative-path and URL extraction regressions)
 * and the sensitive list: a hit in EITHER direction — read or write — is an
 * approval prompt carrying the matched entry, and only `sensitiveMode: 'deny'`
 * turns it into a hard refusal. What the list always guarantees is that no
 * allow rule (workspace, task allowedDirs, config allowedDirs / autoAllowRoots)
 * can make a sensitive hit pass silently. The policy's `read-within-home` allow is narrowed for workers —
 * anything outside the workspace / task allowedDirs / configured roots still
 * asks, reads included.
 *
 * Every scope uses a temp HOME that CONTAINS the sensitive entries, so the
 * assertions are independent of the real user's home directory.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  decideToolAccess,
  evaluateBashAccess,
  evaluateFileAccess,
  expandHome,
  type WorkerAccessScope,
} from '@/services/tools/permission-rules';

/** Stand-in home dir containing the built-in sensitive locations. */
let home: string;
/** Task workspace — deliberately NOT inside home (mirrors a checkout elsewhere). */
let ws: string;
/** The real $HOME, saved while tests point it at the stand-in home. */
let realHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'wayang-perm-home-'));
  ws = mkdtempSync(join(tmpdir(), 'wayang-perm-ws-'));
  // `~` / `$HOME` expand against the PROCESS home (os.homedir() reads $HOME
  // on POSIX). Point $HOME at the stand-in home so tilde paths in these tests
  // resolve into it, keeping assertions independent of the real user's home —
  // and matching the default production state where the policy anchor and the
  // process home are the same directory.
  realHome = process.env.HOME;
  process.env.HOME = home;
  mkdirSync(join(home, '.ssh'), { recursive: true });
  writeFileSync(join(home, '.ssh', 'id_rsa'), 'secret');
  writeFileSync(join(home, '.zshrc'), 'export PATH');
  mkdirSync(join(home, 'docs'), { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
  process.env.HOME = realHome;
});

function scope(overrides: Partial<WorkerAccessScope> = {}): WorkerAccessScope {
  return { userHome: home, workspace: ws, ...overrides };
}

/**
 * Canonical spelling of a path, mirroring the policy's `normalizePath`
 * semantics WITHOUT importing it (the tests must not borrow the code under
 * test to compute their own expectations).
 *
 * `mkdtempSync(join(tmpdir(), …))` hands back the platform's spelling of the
 * temp dir, which on macOS is the un-resolved `/var/folders/…` — while the
 * policy `realpath`s what it judges and reports `/private/var/folders/…`.
 * Both name the same file; only the spelling differs. Resolve the deepest
 * EXISTING ancestor with `realpathSync` and glue the missing tail back on:
 *
 *   /tmp/link/new_key   (/tmp/link -> /home/u)  =>  /home/u/new_key
 */
function canonical(p: string): string {
  const lexical = resolve(p);
  const peeled: string[] = [];
  let candidate = lexical;

  for (let depth = 0; depth <= 32; depth += 1) {
    try {
      const resolved = realpathSync(candidate);
      return peeled.length === 0 ? resolved : resolve(join(resolved, ...peeled));
    } catch {
      // Missing or unreadable — peel one segment and retry on the parent.
    }
    const parent = dirname(candidate);
    if (parent === candidate) break; // hit the filesystem root
    peeled.unshift(basename(candidate));
    candidate = parent;
  }

  return lexical;
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
   * 0.8.4: the destructive tier and the path rules must read the SAME command
   * position. The path rules already stripped `sudo` / `env` / `nohup` / `time`
   * / `nice` / `ionice` / `command` / `exec` / `builtin` (and leading
   * assignments), while the tier was a line-start regex — so `rm -rf x` asked
   * and `nohup rm -rf x` fell through to `allow (no-path)`.
   */
  describe('the destructive tier sees through wrapper prefixes (0.8.4)', () => {
    it.each([
      'nohup rm -rf x',
      'nice rm -rf x',
      'nice -n 5 rm -rf x',
      'ionice -c 3 rm -rf x',
      'env FOO=1 rm -rf x',
      'env -i rm -rf x',
      'time rm -rf x',
      'command rm -rf x',
      'exec rm -rf x',
      'builtin rm -rf x',
      'nohup nice -n 5 env FOO=1 rm -rf x',
      'FOO=1 rm -rf x',
      'nohup chmod 777 x',
      'nohup shutdown -h now',
      'nohup kill -9 1234',
      'nohup dd if=/dev/zero of=/dev/sda',
      // A wrapper that is dangerous on its own, even with no command behind it.
      'nohup sudo rm -rf x',
      'nohup sudo -i',
    ])('%s → ask (dangerous-bash)', (command) => {
      const verdict = evaluateBashAccess(scope(), command);
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe('dangerous-bash');
    });

    it('keeps the plain forms asking (the old regex cases are a subset)', () => {
      for (const command of ['rm -rf x', 'sudo rm -rf x', 'echo hi && rm -rf x', 'cat x | sudo tee /etc/hosts']) {
        expect(evaluateBashAccess(scope(), command).matchedRule).toBe('dangerous-bash');
      }
    });

    it.each(['nohup echo hi', 'nice -n 5 ls -la', 'env FOO=1 ls', 'command -v rm', 'builtin -V rm', 'rmdir x'])(
      '%s → not the destructive tier',
      (command) => {
        expect(evaluateBashAccess(scope(), command).matchedRule).not.toBe('dangerous-bash');
      },
    );
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
      expect(verdict.resolvedPath).toBe(canonical(join(home, '.ssh', 'id_rsa')));
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

    it('a sensitive WRITE asks (naming the entry) instead of being refused', () => {
      for (const command of [
        'sudo rm -rf ~/.ssh',
        'sudo tee ~/.ssh/authorized_keys x',
        'sudo dd if=x of=$HOME/.ssh/id_rsa',
      ]) {
        const verdict = evaluateBashAccess(scope(), command);
        // 0.8.4: a sensitive write is approvable, so the command asks.
        expect(verdict.decision).toBe('ask');
        // These lines are ALSO destructive, and the destructive tier owns the
        // rule name (#42) — it carries the sensitive hit so the approval still
        // names the credential directory.
        expect(verdict.matchedRule).toBe('dangerous-bash');
        expect(verdict.matchedEntry).toBe('.ssh');
        expect(verdict.matchedSource).toBe('segment');
        expect(verdict.sensitive).toBe(true);
        expect(verdict.access).toBe('write');
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

    it('a literal cd chain that STAYS in the workspace runs (0.9.2 cd slice)', () => {
      // 0.9.2 (#51 follow-up): the leading literal `cd <dir> && …` run is now
      // resolved with a local cwd cursor, so a chain that never leaves the
      // workspace no longer asks — the relative paths after it are confined to
      // a directory this gate has already vetted.
      const command = `cd ${ws} && git diff v0.4.0 HEAD -- package.json`;
      const verdict = evaluateBashAccess(scope(), command);
      expect(verdict.decision).toBe('allow');
      expect(verdict.matchedRule).toBe('no-path');

      // The shapes the slice does NOT resolve keep the #51 fail-closed ask.
      for (const unresolved of [`cd ${ws}; git diff v0.4.0 HEAD`, 'cd $DIR && git diff HEAD']) {
        const ask = evaluateBashAccess(scope(), unresolved);
        expect(ask.decision).toBe('ask');
        expect(ask.matchedRule).toBe('dynamic-shell');
        expect(ask.reason).toContain('cd <dir>');
      }
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
      'git diff v0.4.0 HEAD -- package.json src/types/config.ts src/types/index.ts tsconfig.json',
    ])('%s → allow (no path candidate)', (command) => {
      const verdict = evaluateBashAccess(scope(), command);
      expect(verdict.decision).toBe('allow');
      expect(verdict.matchedRule).toBe('no-path');
    });

    // #51 layer 2: `npx` is not on the capability tables, so it asks on the
    // unknown-capability rule — the point of the regression (no bogus absolute
    // path candidate) still holds: the reason is the verb, not a path.
    it('npx asks on the capability gate, not on a bogus path candidate', () => {
      const verdict = evaluateBashAccess(scope(), 'npx vitest run src/services/tools/permission-rules.test.ts');
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe('unknown-capability');
    });
  });

  describe('regression: URLs are not filesystem paths', () => {
    // #51 layer 2: these still never produce a PATH candidate — the ask comes
    // from the capability gate (network / unknown), not from a path rule.
    it.each([
      { command: 'curl -s https://api.example.com/v1/data', rule: 'network-capability' },
      { command: 'git clone https://github.com/foo/bar.git', rule: 'unknown-capability' },
      { command: 'open https://github.com/foo/bar', rule: 'unknown-capability' },
      { command: 'npm install axios', rule: 'unknown-capability' },
    ])('$command → ask ($rule), never a path rule', ({ command, rule }) => {
      const verdict = evaluateBashAccess(scope(), command);
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe(rule);
    });
  });

  it('plain commands run', () => {
    expect(evaluateBashAccess(scope(), 'ls -la').decision).toBe('allow');
    expect(evaluateBashAccess(scope(), 'cat package.json').decision).toBe('allow');
    expect(evaluateBashAccess(scope(), 'git status').decision).toBe('allow');
    // #51 layer 2: an off-table verb asks on the capability gate.
    expect(evaluateBashAccess(scope(), 'npm test').matchedRule).toBe('unknown-capability');
  });

  describe('the sensitive list outranks every allow: reads ask, writes are refused', () => {
    it('a sensitive READ asks, naming the matched entry', () => {
      const verdict = evaluateBashAccess(scope(), 'cat ~/.ssh/id_rsa');
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe('sensitive-list');
      expect(verdict.matchedEntry).toBe('.ssh');
      expect(verdict.access).toBe('read');
    });

    it('a sensitive WRITE asks instead of being refused (entry always named)', () => {
      // `tee` / `cp` are not destructive, so the sensitive rule names the ask.
      for (const [command, entry] of [
        ['tee ~/.ssh/authorized_keys x', '.ssh'],
        ['cp notes.md ~/.aws/credentials', '.aws'],
        ['dd if=x of=$HOME/.ssh/id_rsa', '.ssh'],
      ] as const) {
        const verdict = evaluateBashAccess(scope(), command);
        expect(verdict.decision).toBe('ask');
        expect(verdict.matchedEntry).toBe(entry);
        expect(verdict.access).toBe('write');
        // `dd` also trips the destructive tier, which keeps the rule name but
        // carries the hit (#42); the others report the sensitive rule itself.
        expect(['sensitive-list', 'dangerous-bash']).toContain(verdict.matchedRule);
      }
      // The rule name a plain (non-destructive) sensitive write reports.
      expect(evaluateBashAccess(scope(), 'tee ~/.ssh/authorized_keys x').matchedRule).toBe('sensitive-list');
      expect(evaluateBashAccess(scope(), 'tee ~/.ssh/authorized_keys x').matchedSource).toBe('segment');
    });

    it('cp into a sensitive file asks with the write direction', () => {
      const verdict = evaluateBashAccess(scope(), `cp ${join(ws, 'notes.md')} ~/.aws/credentials`);
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe('sensitive-list');
      expect(verdict.matchedEntry).toBe('.aws');
      expect(verdict.matchedSource).toBe('segment');
      expect(verdict.access).toBe('write');
    });

    it('one sensitive WRITE candidate makes an otherwise benign command line ask', () => {
      const mixed = evaluateBashAccess(scope(), 'cat ok.txt && tee ~/.ssh/authorized_keys');
      expect(mixed.decision).toBe('ask');
      expect(mixed.matchedRule).toBe('sensitive-list');
      expect(mixed.matchedEntry).toBe('.ssh');
      // …and a read-only mix asks as well (every candidate is a read).
      const readMix = evaluateBashAccess(scope(), 'cat ok.txt && cat ~/.ssh/id_rsa');
      expect(readMix.decision).toBe('ask');
      expect(readMix.matchedRule).toBe('sensitive-list');
      expect(readMix.access).toBe('read');
    });

    it('an output redirection into a sensitive path is judged as a WRITE (still an ask, never an allow)', () => {
      const verdict = evaluateBashAccess(scope(), 'echo key > ~/.ssh/authorized_keys');
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe('sensitive-list');
      expect(verdict.matchedEntry).toBe('.ssh');
      expect(verdict.access).toBe('write');
    });

    it('the allow rules cannot launder a sensitive hit, in either direction', () => {
      for (const command of ['cat ~/.ssh/id_rsa', 'tee ~/.ssh/authorized_keys v']) {
        const withAllowed = evaluateBashAccess(scope({ permission: { allowedDirs: [home] } }), command);
        expect(withAllowed.decision).toBe('ask');
        expect(withAllowed.matchedRule).toBe('sensitive-list');
        expect(withAllowed.matchedEntry).toBe('.ssh');

        const withTaskGrant = evaluateBashAccess(scope({ taskAllowedDirs: [join(home, '.ssh')] }), command);
        expect(withTaskGrant.decision).toBe('ask');
        expect(withTaskGrant.matchedRule).toBe('sensitive-list');
      }

      // A workspace that IS the home directory does not help either: the
      // workspace allow sits BELOW the sensitive list in the rule order.
      const wsIsHome = evaluateBashAccess(
        scope({ workspace: home, taskAllowedDirs: [home], permission: { autoAllowRoots: [home] } }),
        'tee ~/.ssh/authorized_keys v',
      );
      expect(wsIsHome.decision).toBe('ask');
      expect(wsIsHome.matchedRule).toBe('sensitive-list');
      expect(wsIsHome.access).toBe('write');
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

    it('rm $HOME/.ssh/id_rsa → ask (the write variant, expanded then matched)', () => {
      const verdict = evaluateBashAccess(scope(), 'rm $HOME/.ssh/id_rsa');
      expect(verdict.decision).toBe('ask');
      // Destructive AND sensitive: the destructive tier owns the rule name and
      // the sensitive hit rides along.
      expect(verdict.matchedRule).toBe('dangerous-bash');
      expect(verdict.matchedEntry).toBe('.ssh');
      expect(verdict.access).toBe('write');
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

    it("awk '{print $1}' file is NOT command substitution — #51 layer 2 asks on exec, not on $", () => {
      // `$1` inside the awk script is still not a command substitution; the
      // ask comes from the capability gate (awk is an interpreter verb).
      const verdict = evaluateBashAccess(scope(), "awk '{print $1}' file");
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe('exec-capability');
    });

    it('a write into the workspace via redirection allows (#51 layer 2)', () => {
      // The redirected write is judged by the write-scope rule: inside the
      // workspace it runs, outside it asks.
      const verdict = evaluateBashAccess(scope(), 'echo hi > notes.txt');
      expect(verdict.decision).toBe('allow');
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
      // #51 layer 2: `npm` is an unknown-capability verb, so this line now
      // asks on the capability gate (the grep read next to it no longer launders it).
      const listing = evaluateBashAccess(scope(), 'npm ls -g --depth=0 2>/dev/null | grep -i waya');
      expect(listing.decision).toBe('ask');
      expect(listing.matchedRule).toBe('unknown-capability');
    });

    it('a redirection into a real file asks only when it escapes the workspace (#51 layer 2)', () => {
      // Inside the workspace the redirected write is allowed: the capability
      // gate classifies the segment as a write whose target stays in scope.
      expect(evaluateBashAccess(scope(), 'echo hi > out.txt').decision).toBe('allow');
      expect(evaluateBashAccess(scope(), `echo hi > ${ws}/out.txt`).decision).toBe('allow');
      // …and out of the workspace it keeps its policy verdict.
      expect(evaluateBashAccess(scope(), 'echo hi > /etc/passwd').decision).toBe('ask');
      // A target that escapes via `..` asks on the write-scope rule.
      const escape = evaluateBashAccess(scope(), 'ls -la >/dev/null && echo x > ../real.txt');
      expect(escape.decision).toBe('ask');
      expect(escape.matchedRule).toBe('write-scope');
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

    it('a sensitive path inside a substitution still asks, naming the entry', () => {
      const read = evaluateBashAccess(scope(), 'cat "$(cat $HOME/.ssh/id_rsa)"');
      expect(read.decision).toBe('ask');
      // The inner hit survives the wrap: the approval still names the entry.
      expect(read.matchedEntry).toBe('.ssh');
      expect(read.resolvedPath).toBe(canonical(join(home, '.ssh', 'id_rsa')));
      // A broken command mentioning a sensitive path keeps the hit too — it is
      // an ask under the default mode, not an unreviewed run.
      const broken = evaluateBashAccess(scope(), 'tee ~/.ssh/authorized_keys "x');
      expect(broken.decision).toBe('ask');
      expect(broken.matchedRule).toBe('sensitive-list');
      expect(broken.matchedEntry).toBe('.ssh');
      expect(broken.access).toBe('write');
      // …and it is a refusal when the user asked for no prompts.
      const strict = evaluateBashAccess(scope({ permission: { sensitiveMode: 'deny' } }), 'tee ~/.ssh/authorized_keys "x');
      expect(strict.decision).toBe('deny');
      expect(strict.matchedRule).toBe('sensitive-list');
    });
  });

  /**
   * 0.8.4: `bash -c '…'` / `sh -c '…'` hide the real command behind a string
   * argument. The outer line only shows `bash` — off the read-only table,
   * yielding no path candidate — so `bash -c "cat ~/.ssh/id_rsa"` used to be an
   * unconditional `allow (no-path)`. The script is now judged by the SAME rules
   * as the line itself, recursively, and the stricter verdict wins.
   */
  describe('a shell -c script is judged by the same rules (0.8.4)', () => {
    it.each([
      ['bash -c "cat ~/.ssh/id_rsa"', 'sensitive-list'],
      ['bash -lc "cat ~/.ssh/id_rsa"', 'sensitive-list'],
      ['bash -ic "cat ~/.ssh/id_rsa"', 'sensitive-list'],
      ['sh -c "cat ~/.ssh/id_rsa"', 'sensitive-list'],
      ['dash -c "cat ~/.ssh/id_rsa"', 'sensitive-list'],
      ['zsh -c "cat ~/.ssh/id_rsa"', 'sensitive-list'],
      ['bash --command "cat ~/.ssh/id_rsa"', 'sensitive-list'],
      ['bash -o pipefail -c "cat ~/.ssh/id_rsa"', 'sensitive-list'],
      ['bash -lc "cp x ~/.aws/credentials"', 'sensitive-list'],
      ['bash -c "cat $HOME/.ssh/id_rsa"', 'sensitive-list'],
      ['bash -c "rm -rf /"', 'dangerous-bash'],
      ['bash -c "cat /etc/hostname"', 'outside-all'],
      ['sh -c "cat /etc/hostname"', 'outside-all'],
    ])('%s → ask (%s)', (command, rule) => {
      const verdict = evaluateBashAccess(scope(), command);
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe(rule);
    });

    it('names the inner sensitive entry, so the approval is actionable', () => {
      const verdict = evaluateBashAccess(scope(), 'bash -c "cat ~/.ssh/id_rsa"');
      expect(verdict.matchedEntry).toBe('.ssh');
      expect(verdict.sensitive).toBe(true);
      expect(verdict.resolvedPath).toBe(canonical(join(home, '.ssh', 'id_rsa')));
      expect(verdict.access).toBe('read');
      expect(verdict.reason).toContain('bash -c');
    });

    it('can be refused outright under sensitiveMode: deny', () => {
      const strict = scope({ permission: { sensitiveMode: 'deny' } });
      expect(evaluateBashAccess(strict, 'bash -c "cat ~/.ssh/id_rsa"').decision).toBe('deny');
    });

    it.each(['bash -c "ls -la"', 'sh -c "git status"', 'bash -c "cat notes.txt"', 'bash -lc "ls"'])(
      '%s → allow (a read-only inner command changes nothing)',
      (command) => {
        expect(evaluateBashAccess(scope(), command).decision).toBe('allow');
      },
    );

    it('follows nesting recursively (nested -c still asks)', () => {
      const verdict = evaluateBashAccess(scope(), `bash -c "bash -c 'cat ~/.ssh/id_rsa'"`);
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedEntry).toBe('.ssh');
    });

    it('asks past the depth limit instead of following it further', () => {
      const nested = (levels: number): string => {
        let command = 'cat ~/.ssh/id_rsa';
        for (let i = 0; i < levels; i += 1) command = `bash -c ${JSON.stringify(command)}`;
        return command;
      };
      // Five levels are followed (the innermost verdict is still the hit)…
      expect(evaluateBashAccess(scope(), nested(5)).matchedEntry).toBe('.ssh');
      // …the sixth only asks, naming the depth limit.
      const tooDeep = evaluateBashAccess(scope(), nested(6));
      expect(tooDeep.decision).toBe('ask');
      expect(tooDeep.matchedRule).toBe('dynamic-shell');
      expect(tooDeep.reason).toContain('nested deeper than');
    });

    it.each([
      'bash -c "cat /etc/hostname',
      `bash -c 'cat "x'`,
      'bash -c "$CMD"',
      'bash -c "$(cat script.txt)"',
      'bash -c',
    ])('%s → ask (the script cannot be judged statically)', (command) => {
      const verdict = evaluateBashAccess(scope(), command);
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe('dynamic-shell');
    });

    it('bash script.sh (no -c) now asks (#51): a script FILE is never read', () => {
      // The file's contents are not part of the command line this gate judges,
      // so the inner commands it runs are unanalyzed — fail closed instead of
      // the old silent allow (same scope as xargs / find -exec, issue #51).
      const verdict = evaluateBashAccess(scope(), 'bash script.sh');
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe('dynamic-shell');
      expect(verdict.reason).toContain('script file');
      // A sensitive operand still wins over the fallback tier.
      expect(evaluateBashAccess(scope(), 'bash script.sh ~/.ssh/id_rsa').matchedRule).toBe('sensitive-list');
    });

    it('a wrapped shell is still recognized (sudo bash -c …)', () => {
      // `sudo` is caught by the destructive tier first — the point here is that
      // the shell is found behind the wrapper too, so the verdict is an ask
      // either way and never a silent allow.
      const verdict = evaluateBashAccess(scope(), 'sudo bash -c "cat /etc/hostname"');
      expect(verdict.decision).toBe('ask');
      expect(['dangerous-bash', 'outside-all']).toContain(verdict.matchedRule);
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
      // …and a write that TOUCHES a sensitive path asks under the write
      // direction, even though the verb itself (`cp`) is not a read.
      const write = evaluateBashAccess(scope(), 'cp ~/notes.md ~/.ssh/id_rsa');
      expect(write.decision).toBe('ask');
      expect(write.matchedRule).toBe('sensitive-list');
      expect(write.access).toBe('write');
    });

    /**
     * GNU sed hides two capabilities inside the SCRIPT STRING: `e` runs a shell
     * command (`sed -n '1e id'`, `s///e`) and `w` / `W` / `r` / `R` write or
     * read a file. A token-level sweep cannot see them, so the script is now
     * validated against a whitelist: anything we cannot locate (`-f file`) or
     * that carries another command is `unknown` (→ ask), never a read.
     */
    describe('sed scripts that can execute or write are not read', () => {
      it.each([
        'sed -n 1,5p ~/f',
        "sed -n '/x/p' ~/f",
        "sed 's/a/b/' ~/f",
        "sed -n '1p;2p' ~/f",
        "sed -n 's/a/b/g' ~/f",
        'sed --version',
        "sed -n -e '1p' -e '2p' ~/f",
        // Address forms the stripper has to read through.
        "sed -n '/a;b/p' ~/f",
        "sed -n '1,5!p' ~/f",
        "sed -n '/x/,/y/p' ~/f",
        "sed -n '$p' ~/f",
        "sed -n 'y/a/b/' ~/f",
        "sed -n -e1p -e2p ~/f",
      ])('%s is still read', (command) => {
        expect(evaluateBashAccess(scope(), command).access).toBe('read');
      });

      it.each([
        "sed -n '1e cmd' ~/f",
        "sed 's/a/b/e' ~/f",
        "sed -n 'w /tmp/x' ~/f",
        "sed -n 'W /tmp/x' ~/f",
        "sed -n '1r /etc/passwd' ~/f",
        'sed -f script.sed ~/f',
        "sed -n '1e' ~/f",
        "sed --expression='1e cmd' ~/f",
      ])('%s is no longer read (the script executes or writes)', (command) => {
        const verdict = evaluateBashAccess(scope(), command);
        expect(verdict.decision).toBe('ask');
        expect(verdict.access).not.toBe('read');
      });

      it('the same judgement applies inside a command substitution', () => {
        const verdict = evaluateBashAccess(scope(), "echo $(sed -n '1e cmd' ~/f)");
        expect(verdict.decision).toBe('ask');
        expect(verdict.access).not.toBe('read');
      });

      it('the -i write form is still a write, not an unknown', () => {
        for (const command of ["sed -i 's/a/b/' ~/f", "sed -i.bak 's/a/b/' ~/f"]) {
          expect(evaluateBashAccess(scope(), command).access).toBe('write');
        }
      });

      it('the file tools are untouched by the sed check', () => {
        expect(evaluateFileAccess(scope(), 'read_file', { path: `${ws}/a.txt` }).access).toBe('read');
        expect(evaluateFileAccess(scope(), 'write_file', { path: `${ws}/a.txt` }).access).toBe('write');
      });
    });
  });

  /**
   * The 0.8.4 P0 fix: the read-only table's deferred conditions used to reach
   * only the audit `access`, never the decision. A table command that FAILED
   * its condition (`sed`'s script whitelist) with no absolute-path operand
   * produced no candidate at all, and the no-candidate fallback allowed it
   * silently — so `sed -n '1e id' package.json` executed arbitrary commands
   * with zero approvals. These cases pin the fail-closed tier: such a segment
   * asks as `read-only-unverified`, whatever its operands spell.
   */
  describe('a read-only table command that cannot be verified asks (0.8.4 P0)', () => {
    it.each([
      "sed -n '1e id' package.json",
      "sed 's/version/VER/e' package.json",
      "sed 's/version/VER/w out.txt' package.json",
      "sed -n 'w out.txt' package.json",
      // The path rides INSIDE the quoted script, so it is no path candidate —
      // the exact shape that used to fall through to the allow.
      "sed -n 'r /etc/hostname' package.json",
      "sed -n 'r hostname.txt' package.json",
      'sed -f mini.sed package.json',
      "sed -n '1p;e echo poisoned' package.json",
      "sed --expression='1e cmd' package.json",
    ])('%s → ask + read-only-unverified (no absolute-path operand)', (command) => {
      const verdict = evaluateBashAccess(scope(), command);
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe('read-only-unverified');
      expect(verdict.access).toBe('unknown');
      expect(verdict.reason).toContain('cannot be verified as read-only');
      // Not a one-path decision, so the task approval memory (#46) can never
      // cover it with an old grant — a grant must not launder the script.
      expect(verdict.askPaths).toBeUndefined();
    });

    it('the same failure asks even when a candidate IS present and would be allowed', () => {
      // Workspace-absolute operand: the policy allows the path, but the
      // verdict may not rest on a verification that failed.
      const inside = evaluateBashAccess(scope(), `sed -n '1e cmd' ${ws}/f`);
      expect(inside.decision).toBe('ask');
      expect(inside.matchedRule).toBe('read-only-unverified');
      // `~/f` used to ask as outside-all; the unverified tier now owns the ask.
      const home = evaluateBashAccess(scope(), 'sed -f mini.sed ~/f');
      expect(home.decision).toBe('ask');
      expect(home.matchedRule).toBe('read-only-unverified');
    });

    it.each([
      "sed -n '1p' package.json",
      "sed -n -e '1p' -e '2p' package.json",
      "sed -n '1p;2p' package.json",
      "sed 's/a/b/' package.json",
      'sed -n 1,10p src/cli.ts',
    ])('%s is a VERIFIED read and still runs (allow + read)', (command) => {
      const verdict = evaluateBashAccess(scope(), command);
      expect(verdict.decision).toBe('allow');
      expect(verdict.matchedRule).toBe('no-path');
      expect(verdict.access).toBe('read');
    });

    it('a write segment is settled as a write BEFORE the read-only check (write priority)', () => {
      // `-i` is a flagged write: the segment never reaches the read-only
      // check, so it is never "unverified". With a candidate the direction is
      // a write, exactly as before.
      expect(evaluateBashAccess(scope(), "sed -i 's/a/b/' ~/f").access).toBe('write');
      // Without a candidate the historic no-candidate shape is unchanged.
      const verdict = evaluateBashAccess(scope(), "sed -i 's/a/b/' package.json");
      expect(verdict.decision).toBe('allow');
      expect(verdict.matchedRule).toBe('no-path');
      expect(verdict.access).toBe('unknown');
    });

    it('the command-substitution interior keeps asking (inner logic unchanged)', () => {
      const verdict = evaluateBashAccess(scope(), "echo $(sed -n '1e cmd' package.json)");
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe('dynamic-shell');
      expect(verdict.reason).toContain('command substitution');
      // …and a VERIFIED sed inside a substitution stays exempt.
      expect(evaluateBashAccess(scope(), 'echo $(sed -n "1p" notes.txt)').decision).toBe('allow');
    });

    it('a sensitive hit keeps its priority over the unverified tier', () => {
      const verdict = evaluateBashAccess(scope(), "sed -n '1e id' ~/.ssh/id_rsa");
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe('sensitive-list');
      expect(verdict.matchedEntry).toBe('.ssh');
      // Under `sensitiveMode: 'deny'` it is still REFUSED, never downgraded to
      // an unverified ask.
      const strict = evaluateBashAccess(scope({ permission: { sensitiveMode: 'deny' } }), "sed -n '1e id' ~/.ssh/id_rsa");
      expect(strict.decision).toBe('deny');
      expect(strict.matchedRule).toBe('sensitive-list');
      // …and the plain sensitive-write control is untouched.
      expect(evaluateBashAccess(scope(), 'tee ~/.ssh/authorized_keys').matchedRule).toBe('sensitive-list');
    });

    it("git's subcommand check stays a classifier, not a deferred condition (scope guard)", () => {
      // A non-read git subcommand is "determined not a read", like an
      // off-table command — #51 layer 2 escalates it on the capability gate.
      for (const command of ['git clone https://github.com/foo/bar.git', 'git push', 'git clean -fdx']) {
        const verdict = evaluateBashAccess(scope(), command);
        expect(verdict.decision).toBe('ask');
        expect(verdict.matchedRule).toBe('unknown-capability');
        expect(verdict.access).toBe('unknown');
      }
    });

    it('a mixed line escalates on its unverified segment and is never audited as a read', () => {
      for (const command of [
        'cat package.json && sed -f mini.sed package.json',
        'cat ~/notes.md && sed -n \'1e id\' p',
      ]) {
        const verdict = evaluateBashAccess(scope(), command);
        expect(verdict.decision).toBe('ask');
        expect(verdict.matchedRule).toBe('read-only-unverified');
        expect(verdict.access).toBe('unknown');
      }
    });
  });

  /**
   * #51: a command that carries an INNER command this gate never analyzes used
   * to be an unconditional `allow (no-path)` — the outer word produces no path
   * candidate, so the sensitive / path rules saw nothing. No parser or
   * recursion is added: recognizing the shape is enough to fail closed, and the
   * reason names the shape so the controller can act on it. A static `-c`
   * script is NOT in this set — it is already judged recursively (0.8.4).
   */
  describe('#51 fail-closed fallback for unanalyzed inner commands', () => {
    describe('every shape asks and names the shape in the reason', () => {
      it.each([
        ['xargs rm -rf build', 'xargs'],
        ['echo hi | xargs -n1 echo', 'xargs'],
        ['find . -exec rm {} +', 'find -exec'],
        ['find . -execdir sh -c "id" {} +', 'find -execdir'],
        ['find . -ok rm {} +', 'find -ok'],
        ['eval "echo hi"', 'eval'],
        ['cd - && ls -la', 'cd <dir>'],
        ['(cd build && ls)', 'subshell (cd ...)'],
        ['pushd build && ls', 'pushd <dir>'],
        ['popd && ls', 'popd <dir>'],
        ['bash script.sh', 'script file'],
        ['sh deploy.sh', 'script file'],
        ['for f in a b; do cat "$f"; done', 'compound keyword'],
        ['if true; then echo yes; fi', 'compound keyword'],
      ])('%s → ask (reason names %s)', (command, shape) => {
        const verdict = evaluateBashAccess(scope(), command);
        expect(verdict.decision).toBe('ask');
        expect(verdict.matchedRule).toBe('dynamic-shell');
        expect(verdict.reason).toContain(shape);
      });
    });

    it('the escalation is not a one-path decision (no askPaths)', () => {
      expect(evaluateBashAccess(scope(), 'xargs rm').askPaths).toBeUndefined();
    });

    it('a sensitive hit keeps priority over the fallback', () => {
      const verdict = evaluateBashAccess(scope(), 'bash script.sh ~/.ssh/id_rsa');
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe('sensitive-list');
      expect(verdict.matchedEntry).toBe('.ssh');
    });

    it('no-path read-only commands still allow with no reason', () => {
      for (const command of ['ls -la', 'git status', 'pwd']) {
        const verdict = evaluateBashAccess(scope(), command);
        expect(verdict.decision).toBe('allow');
        expect(verdict.matchedRule).toBe('no-path');
        expect(verdict.reason).toBeUndefined();
      }
    });

    it('a shell -c script keeps its recursive verdict (an inner read-only command still allows)', () => {
      expect(evaluateBashAccess(scope(), 'bash -c "ls -la"').decision).toBe('allow');
      expect(evaluateBashAccess(scope(), 'sh -c "git status"').decision).toBe('allow');
      const hit = evaluateBashAccess(scope(), 'sh -c "cat ~/.ssh/id_rsa"');
      expect(hit.decision).toBe('ask');
      expect(hit.matchedEntry).toBe('.ssh');
    });

    it('ordinary commands with an explicit path are unchanged (no false positive)', () => {
      // `grep -rn '/api/' src` currently asks as outside-all; the fallback must
      // not claim it as one of the six shapes.
      const verdict = evaluateBashAccess(scope(), "grep -rn '/api/' src");
      expect(verdict.matchedRule).toBe('outside-all');
      expect(verdict.reason).toBeUndefined();
      for (const command of ['cat package.json', 'sed -n 1,10p src/cli.ts', 'git status']) {
        expect(evaluateBashAccess(scope(), command).decision).toBe('allow');
      }
    });
  });

  /**
   * 0.9.2 (#51 follow-up): a leading run of LITERAL `cd <dir>` segments joined
   * only by `&&` is walked with a cwd cursor before the rest of the line is
   * judged. The cursor starts at the workspace (the shell's cwd), each target is
   * expanded / made absolute against the CURSOR / canonicalized and judged as a
   * read, and a target that lands outside the silent scope asks with its own
   * reason. The cursor is local to one analysis — never module state, never
   * carried across commands — and the slice can only ask, never allow, where the
   * old #51 fallback asked.
   */
  describe('a literal `cd` chain is resolved with a local cwd cursor (0.9.2)', () => {
    beforeEach(() => {
      mkdirSync(join(ws, 'src'), { recursive: true });
      mkdirSync(join(ws, 'test'), { recursive: true });
      mkdirSync(join(home, 'docs'), { recursive: true });
    });

    it('(a) `cd <workspace>/src && ls acp` runs', () => {
      const verdict = evaluateBashAccess(scope(), `cd ${ws}/src && ls acp`);
      expect(verdict.decision).toBe('allow');
      expect(verdict.matchedRule).toBe('no-path');
      expect(verdict.access).toBe('read');
    });

    it('(b) `cd <workspace> && cat package.json` runs', () => {
      const verdict = evaluateBashAccess(scope(), `cd ${ws} && cat package.json`);
      expect(verdict.decision).toBe('allow');
      expect(verdict.matchedRule).toBe('no-path');
    });

    it('(c) `cd ~/docs && ls` asks: the policy allows the read, the worker scope does not', () => {
      // Real semantics, not an assumption: `~/docs` is inside the POLICY home
      // (rule 6 would allow the read) but outside the worker's silent scope,
      // so the same `allowReadWithinHome: false` that governs file tools
      // makes the policy itself return the `read-within-home` ask.
      const verdict = evaluateBashAccess(scope(), 'cd ~/docs && ls');
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe('read-within-home');
      expect(verdict.reason).toContain('inside the home directory');
      // The reason names BOTH the spelling and the path it resolved to.
      expect(verdict.reason).toContain('~/docs');
      expect(verdict.reason).toContain(canonical(join(home, 'docs')));
    });

    it('(d) `cd /tmp && ls` asks, naming the scope boundary', () => {
      const verdict = evaluateBashAccess(scope(), 'cd /tmp && ls');
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe('outside-all');
      expect(verdict.reason).toContain('outside the allowed scope');
      expect(verdict.reason).toContain('"/tmp"');
    });

    it('(e) `cd ~/.ssh && ls` asks, naming the sensitive entry', () => {
      const verdict = evaluateBashAccess(scope(), 'cd ~/.ssh && ls');
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedEntry).toBe('.ssh');
      expect(verdict.sensitive).toBe(true);
    });

    it('(f) `cd $X && ls` keeps the #51 fail-closed ask (target not literal)', () => {
      const verdict = evaluateBashAccess(scope(), 'cd $X && ls');
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe('dynamic-shell');
      expect(verdict.reason).toContain('fail-closed');
      expect(verdict.reason).toContain('issue #51');
    });

    it('(g) `cd a; cd b && ls` asks: a `;` chain is never crossed', () => {
      const verdict = evaluateBashAccess(scope(), 'cd a; cd b && ls');
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe('dynamic-shell');
    });

    it('(h) `(cd <workspace> && ls)` asks: a subshell restores the old cwd', () => {
      const verdict = evaluateBashAccess(scope(), `(cd ${ws} && ls)`);
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe('dynamic-shell');
    });

    it('(i) `cd <workspace> && rm -rf build` still asks (dangerous tier)', () => {
      // Resolving the cd must not launder the segment it re-bases.
      const verdict = evaluateBashAccess(scope(), `cd ${ws} && rm -rf build`);
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe('dangerous-bash');
    });

    it('(j) `cd <workspace>/src && cd ../test && ls` runs', () => {
      // `../test` is resolved against the CURSOR (`<workspace>/src`), which is
      // still inside the workspace.
      const verdict = evaluateBashAccess(scope(), `cd ${ws}/src && cd ../test && ls`);
      expect(verdict.decision).toBe('allow');
      expect(verdict.matchedRule).toBe('no-path');
    });

    it('(j2) `cd <workspace> && cd .. && ls` asks: the base is the cursor, not the workspace', () => {
      // `..` climbs out of the workspace, one level above it. Were the base the
      // workspace instead of the cursor, `cd ..` would have been judged as
      // `<workspace>/..` — a different (and still outside) directory. The reason
      // proves where it landed.
      const verdict = evaluateBashAccess(scope(), `cd ${ws} && cd .. && ls`);
      expect(verdict.decision).toBe('ask');
      expect(verdict.reason).toContain('outside the allowed scope');
      expect(verdict.reason).toContain('".."');
      expect(verdict.resolvedPath).toBe(canonical(dirname(ws)));
      expect(verdict.resolvedPath).not.toBe(canonical(ws));
    });

    it('the cursor is per-analysis: an earlier allow does not carry into the next call', () => {
      // Two independent calls, same scope. The second one starts from the
      // workspace again, not from where the first chain ended.
      expect(evaluateBashAccess(scope(), `cd ${ws}/src && ls`).decision).toBe('allow');
      const second = evaluateBashAccess(scope(), 'cd .. && ls');
      expect(second.decision).toBe('ask');
      expect(second.resolvedPath).toBe(canonical(dirname(ws)));
    });

    it('a non-literal cd after a literal one stops the walk and keeps the #51 ask', () => {
      // The first `cd` is resolved, the second is not: the remaining line still
      // carries an unanalyzed cwd change, so the fail-closed ask stands.
      const verdict = evaluateBashAccess(scope(), `cd ${ws} && cd - && ls`);
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe('dynamic-shell');
      expect(verdict.reason).toContain('cd <dir>');
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

  it('config sensitiveDirs extend the sensitive list (both directions ask)', () => {
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
    expect(write.decision).toBe('ask');
    expect(write.matchedRule).toBe('sensitive-list');
    expect(write.matchedEntry).toBe('docs');
    expect(write.matchedSource).toBe('config-dir');
    expect(write.access).toBe('write');
  });

  it('the deprecated deniedDirs alias protects exactly like sensitiveDirs', () => {
    const read = evaluateFileAccess(scope({ permission: { deniedDirs: ['docs'] } }), 'read_file', {
      path: join(home, 'docs', 'a.md'),
    });
    expect(read.decision).toBe('ask');
    expect(read.matchedEntry).toBe('docs');
    expect(read.matchedRule).toBe('sensitive-list');
  });

  it('sensitiveMode: deny refuses BOTH directions without asking', () => {
    const strict = scope({ permission: { sensitiveMode: 'deny' } });
    const read = evaluateFileAccess(strict, 'read_file', { path: '~/.ssh/id_rsa' });
    expect(read.decision).toBe('deny');
    expect(read.matchedRule).toBe('sensitive-list');
    expect(read.matchedEntry).toBe('.ssh');

    const write = evaluateFileAccess(strict, 'write_file', { path: '~/.ssh/id_rsa', content: 'x' });
    expect(write.decision).toBe('deny');
    expect(write.matchedRule).toBe('sensitive-list');
    expect(write.matchedEntry).toBe('.ssh');
    expect(write.access).toBe('write');
    // A refusal under 'deny' carries the direction in its message (attached by
    // `decideToolAccess`, the layer that hands text back to a worker).
    const refusal = decideToolAccess(strict, 'write_file', { path: '~/.ssh/id_rsa', content: 'x' });
    expect(refusal.message).toContain('refusing to write');
    expect(refusal.message).toContain('sensitiveMode is "deny"');
  });

  it('~ paths expand against the process home ($HOME), and the sensitive list wins', () => {
    const readKey = evaluateFileAccess(scope(), 'read_file', { path: '~/.ssh/id_rsa' });
    expect(readKey.decision).toBe('ask');
    expect(readKey.matchedEntry).toBe('.ssh');
    expect(readKey.resolvedPath).toBe(canonical(join(home, '.ssh', 'id_rsa')));
    // A sensitive WRITE inside the task allowedDirs still asks: the grant is
    // outranked by the sensitive rule and cannot pre-approve the write.
    const writeKey = evaluateFileAccess(scope({ taskAllowedDirs: [join(home, '.ssh')] }), 'write_file', {
      path: join(home, '.ssh', 'authorized_keys'),
      content: 'x',
    });
    expect(writeKey.decision).toBe('ask');
    expect(writeKey.matchedRule).toBe('sensitive-list');
    expect(writeKey.matchedEntry).toBe('.ssh');
    expect(writeKey.access).toBe('write');
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
    // Writing through the same link asks as well — never an allow, never a
    // silent run.
    const write = evaluateFileAccess(scope(), 'write_file', { path: 'link/id_rsa', content: 'x' });
    expect(write.decision).toBe('ask');
    expect(write.matchedRule).toBe('sensitive-list');
    expect(write.matchedEntry).toBe('.ssh');
    expect(write.access).toBe('write');
  });

  it('missing or non-string path is not gated', () => {
    expect(evaluateFileAccess(scope(), 'read_file', {}).decision).toBe('allow');
    expect(evaluateFileAccess(scope(), 'read_file', { path: '' }).decision).toBe('allow');
    expect(evaluateFileAccess(scope(), 'read_file', { path: 42 }).decision).toBe('allow');
  });
});

describe('decideToolAccess', () => {
  it('asks (no refusal text) for a sensitive write under the default mode', () => {
    const verdict = decideToolAccess(scope(), 'write_file', { path: '~/.ssh/authorized_keys', content: 'x' });
    expect(verdict.decision).toBe('ask');
    expect(verdict.matchedRule).toBe('sensitive-list');
    expect(verdict.matchedEntry).toBe('.ssh');
    expect(verdict.access).toBe('write');
    // Only a refusal carries a message; an ask is described by the approval.
    expect(verdict.message).toBeUndefined();
  });

  it('attaches a disclosure-safe message on a refused sensitive write (sensitiveMode: deny)', () => {
    const strict = scope({ permission: { sensitiveMode: 'deny' } });
    const verdict = decideToolAccess(strict, 'write_file', { path: '~/.ssh/authorized_keys', content: 'x' });
    expect(verdict.decision).toBe('deny');
    // The worker's own spelling is echoed; the sensitive entry is not named.
    expect(verdict.message).toContain('~/.ssh/authorized_keys');
    expect(verdict.message).toContain('sensitive list');
    expect(verdict.message).toContain('refusing to write');
    expect(verdict.message).not.toContain('.ssh (');
  });

  it('does not echo any path or entry for a refused bash command (sensitiveMode: deny)', () => {
    const strict = scope({ permission: { sensitiveMode: 'deny' } });
    const verdict = decideToolAccess(strict, 'bash', { command: 'rm -rf ~/.ssh' });
    expect(verdict.decision).toBe('deny');
    expect(verdict.message).not.toContain('.ssh');
    expect(verdict.message).toContain('sensitive list');
    expect(verdict.message).toContain('would write');
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
 * still be recognized as sensitive — both directions ask WITH the entry named
 * (not a bare "outside-all").
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

  it('write_file on <realHome>/.ssh/id_rsa → ask, with the entry and direction', () => {
    const verdict = decideToolAccess(scope(), 'write_file', {
      path: join(realHome, '.ssh', 'id_rsa'),
      content: 'x',
    });
    expect(verdict.decision).toBe('ask');
    expect(verdict.matchedRule).toBe('sensitive-list');
    expect(verdict.matchedEntry).toBe('.ssh');
    expect(verdict.access).toBe('write');
  });

  it('write_file on <realHome>/.ssh/id_rsa → deny under sensitiveMode: deny', () => {
    const strict = scope({ permission: { sensitiveMode: 'deny' } });
    const verdict = decideToolAccess(strict, 'write_file', { path: join(realHome, '.ssh', 'id_rsa'), content: 'x' });
    expect(verdict.decision).toBe('deny');
    expect(verdict.matchedRule).toBe('sensitive-list');
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

  it('write_file on ~/.wayang/tmp/a.txt is no longer refused', () => {
    const verdict = evaluateFileAccess(scope(), 'write_file', { path: '~/.wayang/tmp/a.txt' });
    expect(verdict.decision).not.toBe('deny');
    expect(verdict.matchedRule).not.toBe('sensitive-list');
    expect(verdict.decision).toBe('ask');
    expect(verdict.message).toBeUndefined();
  });

  it('edit_file on ~/.wayang/tmp/a.txt is no longer refused', () => {
    const verdict = evaluateFileAccess(scope(), 'edit_file', { path: join(home, '.wayang', 'tmp', 'a.txt') });
    expect(verdict.decision).toBe('ask');
    expect(verdict.matchedRule).not.toBe('sensitive-list');
  });

  it('bash redirect into ~/.wayang/tmp is not a sensitive hit', () => {
    const verdict = decideToolAccess(scope(), 'bash', { command: 'echo hi > ~/.wayang/tmp/a.txt' });
    expect(verdict.decision).not.toBe('deny');
    expect(verdict.matchedRule).not.toBe('sensitive-list');
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

  it('write_file on ~/.wayang.config.json is not refused', () => {
    const write = decideToolAccess(scope(), 'write_file', { path: '~/.wayang.config.json', content: 'x' });
    expect(write.decision).not.toBe('deny');
    expect(write.matchedRule).not.toBe('sensitive-list');
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
    expect(verdict.matchedRule).not.toBe('sensitive-list');
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

      // 0.8.4: the write direction asks too (see sensitivity above); only
      // `sensitiveMode: 'deny'` refuses it.
      const write = decideToolAccess(scope(), 'write_file', { path, content: 'x' });
      expect(write.decision).toBe('ask');
      expect(write.matchedRule).toBe('sensitive-list');
      expect(write.access).toBe('write');
      expect(write.message).toBeUndefined();
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

/**
 * 0.8.4: a sensitive WRITE is routed through the approval flow instead of being
 * refused outright. The matrix below is the contract: under the default
 * `sensitiveMode: 'ask'` every direction asks (with `matchedEntry` /
 * `matchedSource` / `resolvedPath` / `access`), and only `sensitiveMode: 'deny'`
 * refuses. NO path is ever allowed because every allow rule — workspace, task
 * allowedDirs, config allowedDirs, autoAllowRoots — sits BELOW the sensitive
 * list, so the choice is always "ask or refuse", never "pass silently".
 */
describe('sensitive writes go through approval (0.8.4)', () => {
  const sensitiveWrites = [
    { command: 'tee ~/.ssh/authorized_keys', entry: '.ssh' },
    { command: 'rm -rf ~/.ssh', entry: '.ssh' },
    { command: 'cp x ~/.aws/credentials', entry: '.aws' },
  ];

  it.each(sensitiveWrites)('$command → ask with the entry and access=write', ({ command, entry }) => {
    const verdict = evaluateBashAccess(scope(), command);
    expect(verdict.decision).toBe('ask');
    expect(verdict.matchedEntry).toBe(entry);
    expect(verdict.matchedSource).toBe('segment');
    expect(verdict.sensitive).toBe(true);
    expect(verdict.access).toBe('write');
    expect(verdict.resolvedPath).toContain(entry);
  });

  it('cat ~/.ssh/id_rsa → ask with access=read (unchanged)', () => {
    const verdict = evaluateBashAccess(scope(), 'cat ~/.ssh/id_rsa');
    expect(verdict.decision).toBe('ask');
    expect(verdict.matchedRule).toBe('sensitive-list');
    expect(verdict.matchedEntry).toBe('.ssh');
    expect(verdict.access).toBe('read');
  });

  it.each(sensitiveWrites)('$command → deny under sensitiveMode: deny', ({ command }) => {
    const strict = scope({ permission: { sensitiveMode: 'deny' } });
    const verdict = evaluateBashAccess(strict, command);
    expect(verdict.decision).toBe('deny');
    expect(verdict.matchedRule).toBe('sensitive-list');
    expect(verdict.access).toBe('write');
  });

  it('a sensitive read is denied too under sensitiveMode: deny (regression)', () => {
    const strict = scope({ permission: { sensitiveMode: 'deny' } });
    const verdict = evaluateBashAccess(strict, 'cat ~/.ssh/id_rsa');
    expect(verdict.decision).toBe('deny');
    expect(verdict.matchedRule).toBe('sensitive-list');
    expect(verdict.access).toBe('read');
  });

  it('a workspace / allowedDirs grant covering the sensitive path still asks, never allows', () => {
    const grants: Partial<WorkerAccessScope>[] = [
      { workspace: home },
      { taskAllowedDirs: [join(home, '.ssh')] },
      { permission: { allowedDirs: [join(home, '.ssh')] } },
      { permission: { autoAllowRoots: [home] } },
      { workspace: home, taskAllowedDirs: [home], permission: { allowedDirs: [home], autoAllowRoots: [home] } },
    ];
    for (const grant of grants) {
      const verdict = evaluateBashAccess(scope(grant), 'tee ~/.ssh/authorized_keys x');
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe('sensitive-list');
      expect(verdict.matchedEntry).toBe('.ssh');
      expect(verdict.access).toBe('write');
    }
  });

  it('write_file / edit_file into a sensitive path ask as writes as well', () => {
    for (const tool of ['write_file', 'edit_file']) {
      const verdict = evaluateFileAccess(scope(), tool, { path: '~/.ssh/authorized_keys', content: 'x' });
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe('sensitive-list');
      expect(verdict.matchedEntry).toBe('.ssh');
      expect(verdict.access).toBe('write');
      // An ask carries no refusal text — the approval request explains it.
      expect(verdict.message).toBeUndefined();
    }
  });
});

/**
 * 0.8.4 semantic split: `~` EXPANSION anchors on the PROCESS home ($HOME) —
 * the same file a shell opens — while the POLICY BOUNDARY (scope.userHome) is
 * a separate decision input that may anchor elsewhere (an injected scope, a
 * custom wayang root in the old derivation). These cases pin the divergence:
 * expansion must NOT follow the boundary, and a path that lands outside the
 * boundary must ask rather than be silently allowed.
 */
describe('process-home expansion vs the policy boundary (0.8.4)', () => {
  /** A second temp dir used as the process home while the scope anchors at `home`. */
  let otherHome: string;

  beforeEach(() => {
    otherHome = mkdtempSync(join(tmpdir(), 'wayang-perm-other-'));
  });

  afterEach(() => {
    rmSync(otherHome, { recursive: true, force: true });
  });

  /** Scope anchored at `home` (the suite's stand-in) while $HOME is elsewhere. */
  function divergentScope(): WorkerAccessScope {
    return { userHome: home, workspace: ws };
  }

  it('expandHome anchors on the process home, not on any injected value', () => {
    process.env.HOME = otherHome;
    try {
      expect(expandHome('~').path).toBe(otherHome);
      expect(expandHome('~/x').path).toBe(join(otherHome, 'x'));
      expect(expandHome('$HOME/x').path).toBe(join(otherHome, 'x'));
      expect(expandHome('${HOME}/x').path).toBe(join(otherHome, 'x'));
      expect(expandHome('$HOMEDIR/x').path).toBe('$HOMEDIR/x');
      expect(expandHome('relative/x').path).toBe('relative/x');
      expect(expandHome('/abs/x').path).toBe('/abs/x');
      expect(expandHome('~user/x')).toMatchObject({ path: '~user/x', unresolvable: true });
    } finally {
      process.env.HOME = home;
    }
  });

  it('a file-tool `~` path resolves to the process home and asks when outside the boundary', () => {
    process.env.HOME = otherHome;
    try {
      const verdict = evaluateFileAccess(divergentScope(), 'read_file', { path: '~/x' });
      // Expanded to the PROCESS home (what `cat ~/x` would open)…
      expect(verdict.resolvedPath).toBe(canonical(join(otherHome, 'x')));
      // …but the boundary anchors at `home`, so the path is outside every
      // allowed scope: ask (outside-all), never a silent allow.
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe('outside-all');
    } finally {
      process.env.HOME = home;
    }
  });

  it('a `~` path inside the boundary still narrows read-within-home to ask (default behaviour preserved)', () => {
    // $HOME === the scope anchor (the default production state): unchanged.
    const verdict = evaluateFileAccess(divergentScope(), 'read_file', { path: '~/x' });
    expect(verdict.resolvedPath).toBe(canonical(join(home, 'x')));
    expect(verdict.decision).toBe('ask');
    expect(verdict.matchedRule).toBe('read-within-home');
  });

  it('bash judges `cat ~/x` and `cat $HOME/x` identically (same expanded path)', () => {
    process.env.HOME = otherHome;
    try {
      const tilde = evaluateBashAccess(divergentScope(), 'cat ~/x');
      const envVar = evaluateBashAccess(divergentScope(), 'cat $HOME/x');
      expect(tilde.decision).toBe('ask');
      expect(envVar.decision).toBe('ask');
      expect(tilde.matchedRule).toBe('outside-all');
      expect(envVar.matchedRule).toBe('outside-all');
      // Both ask about the SAME path — the one a shell would open.
      expect(tilde.askPaths).toEqual([canonical(join(otherHome, 'x'))]);
      expect(envVar.askPaths).toEqual(tilde.askPaths);
    } finally {
      process.env.HOME = home;
    }
  });
});
