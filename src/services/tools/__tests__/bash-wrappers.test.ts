// #86 — bash capability additions (A) and wrapper decomposition (B).
//
// Table-driven so every rule has at least one allow and one ask shape. The
// scope mirrors bash-capability.test.ts: a temp HOME holding the sensitive
// entries and a temp workspace deliberately outside it, so a relative operand
// is inside the silent scope and an absolute one is not.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evaluateBashAccess } from '@/services/tools/permission-rules/bash-access';
import type { ToolAccessDecision, WorkerAccessScope } from '@/services/tools/permission-rules/types';

let home: string;
let ws: string;
let realHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'wayang-86-home-'));
  ws = mkdtempSync(join(tmpdir(), 'wayang-86-ws-'));
  realHome = process.env.HOME;
  process.env.HOME = home;
  mkdirSync(join(home, '.ssh'), { recursive: true });
  writeFileSync(join(home, '.ssh', 'id_rsa'), 'secret');
  mkdirSync(join(ws, 'src'), { recursive: true });
  writeFileSync(join(ws, 'src', 'index.ts'), 'export {};\n');
  writeFileSync(join(ws, 'a.txt'), 'a\n');
  writeFileSync(join(ws, 'b.txt'), 'b\n');
  writeFileSync(join(ws, 'package.json'), '{}\n');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
  process.env.HOME = realHome;
});

function scope(): WorkerAccessScope {
  return { userHome: home, workspace: ws };
}

function verdict(command: string): ToolAccessDecision {
  return evaluateBashAccess(scope(), command);
}

function allow(command: string): void {
  const result = verdict(command);
  expect(result.decision, `${command} → ${result.matchedRule}: ${result.reason ?? ''}`).toBe('allow');
}

function ask(command: string, rule?: string): void {
  const result = verdict(command);
  expect(result.decision, `${command} → ${result.matchedRule}: ${result.reason ?? ''}`).toBe('ask');
  if (rule !== undefined) expect(result.matchedRule).toBe(rule);
}

describe('#86 A — command-table additions', () => {
  describe('git read subcommands (extended readFlags + list-only flags)', () => {
    it.each([
      'git status --short',
      'git log --oneline -5',
      'git diff HEAD',
      'git show HEAD',
      'git rev-parse --abbrev-ref HEAD',
      'git branch -vv',
      'git branch --show-current',
      'git branch -a',
      'git branch --list',
      'git remote -v',
      'git tag -l',
      'git ls-tree HEAD',
      'git cat-file -p HEAD',
      'git merge-base a b',
      'git cherry a b',
      'git rev-list HEAD',
      'git reflog',
      'git worktree list',
      'git config --get user.name',
      'git config --list',
    ])('%s → allow (read)', (command) => {
      allow(command);
      expect(verdict(command).access).toBe('read');
    });

    it.each([
      { command: 'git branch -a foo', rule: 'unknown-capability' },
      { command: 'git branch -D x', rule: 'unknown-capability' },
      { command: 'git tag -d x', rule: 'unknown-capability' },
      { command: 'git worktree add ../x', rule: 'unknown-capability' },
      { command: 'git reflog delete', rule: 'unknown-capability' },
      { command: 'git config user.name x', rule: 'unknown-capability' },
      { command: 'git ls-remote origin', rule: 'unknown-capability' },
    ])('$command → ask ($rule)', ({ command, rule }) => {
      ask(command, rule);
    });
  });

  describe('checksum / digest commands', () => {
    it.each(['sha256sum package.json', 'md5sum package.json', 'shasum package.json', 'cksum package.json'])(
      '%s → allow (read)',
      (command) => {
        allow(command);
        expect(verdict(command).access).toBe('read');
      },
    );

    it('a digest of a path outside the workspace asks', () => {
      ask('sha256sum /etc/passwd', 'outside-all');
    });
  });

  describe('gh read subcommands', () => {
    it.each(['gh run list', 'gh run view 1', 'gh issue list', 'gh issue view 1 --json title', 'gh pr list', 'gh pr view 1', 'gh auth status'])(
      '%s → allow (read)',
      (command) => {
        allow(command);
        expect(verdict(command).access).toBe('read');
      },
    );

    it.each([
      { command: 'gh issue create', rule: 'unknown-capability' },
      { command: 'gh pr merge 1', rule: 'unknown-capability' },
      { command: 'gh pr close 1', rule: 'unknown-capability' },
      { command: 'gh api user', rule: 'unknown-capability' },
      { command: 'gh auth login', rule: 'unknown-capability' },
    ])('$command → ask ($rule)', ({ command, rule }) => {
      ask(command, rule);
    });
  });

  describe('pure version probes', () => {
    it.each(['node --version', 'node -v', 'npm --version', 'npm -v', 'python3 --version', 'python3 -V'])(
      '%s → allow (read)',
      (command) => {
        allow(command);
        expect(verdict(command).access).toBe('read');
      },
    );

    it.each([
      { command: 'node --version script.js', rule: 'exec-capability' },
      { command: 'npm --version run build', rule: 'unknown-capability' },
      { command: 'python3 --version -c "print(1)"', rule: 'exec-capability' },
    ])('$command → ask ($rule)', ({ command, rule }) => {
      ask(command, rule);
    });
  });
});

describe('#86 B — wrapper / compound decomposition', () => {
  describe('timeout / watch launchers', () => {
    it.each(['timeout 30 git status', 'timeout 5 ls', 'watch -n 2 git status', 'timeout 5 bash -c "ls"'])(
      '%s → allow',
      (command) => {
        allow(command);
      },
    );

    it.each([
      { command: 'timeout 5 rm -rf x', rule: 'dangerous-bash' },
      { command: 'timeout 5 bash -c "rm -rf x"', rule: 'dangerous-bash' },
      { command: 'timeout 5 sh -c "cat ~/.ssh/id_rsa"', rule: 'sensitive-list' },
    ])('$command → ask ($rule)', ({ command, rule }) => {
      ask(command, rule);
    });
  });

  describe('cd chain (`&&` and `;`)', () => {
    it.each(['cd src && git log', 'cd src; git log', 'cd src && cd sub && ls', 'cd src; cd sub && ls'])(
      '%s → allow',
      (command) => {
        allow(command);
      },
    );

    it.each([
      { command: 'cd /x && git log', rule: 'outside-all' },
      { command: 'cd /x; git log', rule: 'outside-all' },
      { command: 'cd $DIR && git log', rule: 'unknown-capability' },
    ])('$command → ask ($rule)', ({ command, rule }) => {
      ask(command, rule);
    });
  });

  describe('literal assignment prefix', () => {
    it.each([
      'R=src; git -C $R status',
      'R=src git -C $R status',
      'R=src; cd $R && cat index.ts',
      'X=$(cat src/index.ts); echo $X',
    ])('%s → allow', (command) => {
      allow(command);
    });

    it.each([
      { command: 'R=/path; git -C $R status', rule: 'outside-all' },
      { command: 'X=$(rm -rf /); echo $X', rule: 'dangerous-bash' },
      { command: 'export R=/path; git status', rule: 'unknown-capability' },
      { command: 'R=(a b); echo $R', rule: 'unknown-capability' },
    ])('$command → ask ($rule)', ({ command, rule }) => {
      ask(command, rule);
    });
  });

  describe('command substitution', () => {
    it.each(['echo $(cat src/index.ts)', 'echo $(git status)', 'echo "$(cat src/index.ts)"'])(
      '%s → allow',
      (command) => {
        allow(command);
      },
    );

    it.each([
      { command: 'echo $(rm -rf x)', rule: 'dynamic-shell' },
      { command: 'echo $(cat /etc/passwd)', rule: 'dynamic-shell' },
    ])('$command → ask ($rule)', ({ command, rule }) => {
      ask(command, rule);
    });
  });

  describe('xargs', () => {
    it.each([
      // A literal operand keeps the ordinary gate: the inner command is judged
      // exactly as if it had been written out.
      'find . -name "*.ts" | xargs cat package.json',
      'find . -name "*.ts" | xargs wc -l package.json',
      'ls | xargs cat package.json',
    ])('%s → allow', (command) => {
      allow(command);
    });

    it.each([
      { command: 'find . | xargs rm -rf', rule: 'dangerous-bash' },
      { command: 'xargs rm', rule: 'dangerous-bash' },
      { command: 'echo hi | xargs -n1 echo', rule: 'unknown-capability' },
      { command: 'find . | xargs -I{} cat {}', rule: 'unknown-capability' },
      { command: 'xargs sh -c "rm -rf x"', rule: 'dangerous-bash' },
      // #86: a read / write verb with no literal operand gets its operands from
      // stdin — the gate cannot judge what it touches.
      { command: 'find . | xargs grep x', rule: 'unknown-capability' },
      { command: 'find . -name "*.ts" | xargs wc -l', rule: 'unknown-capability' },
      { command: 'ls | xargs cat', rule: 'unknown-capability' },
    ])('$command → ask ($rule)', ({ command, rule }) => {
      ask(command, rule);
    });
  });

  describe('for loop', () => {
    it.each(['for f in a.txt b.txt; do cat $f; done', 'for f in a.txt b.txt; do wc -l "$f"; done'])(
      '%s → allow',
      (command) => {
        allow(command);
      },
    );

    it.each([
      { command: 'for f in a.txt b.txt; do rm $f; done', rule: 'dangerous-bash' },
      { command: 'for f in *.md; do cat $f; done', rule: 'unknown-capability' },
      { command: 'for f in $(ls); do cat $f; done', rule: 'unknown-capability' },
    ])('$command → ask ($rule)', ({ command, rule }) => {
      ask(command, rule);
    });
  });

  describe('awk static script check', () => {
    it.each(["awk '{print $1}' src/index.ts", "awk -F: '{print $1}' src/index.ts", "awk -v x=1 '{print x}'"])(
      '%s → allow (read)',
      (command) => {
        allow(command);
        expect(verdict(command).access).toBe('read');
      },
    );

    it.each([
      { command: "awk 'BEGIN{system(\"id\")}' src/index.ts", rule: 'exec-capability' },
      { command: "awk '{print $1 > \"out\"}' src/index.ts", rule: 'exec-capability' },
      { command: 'awk -f prog.awk src/index.ts', rule: 'exec-capability' },
    ])('$command → ask ($rule)', ({ command, rule }) => {
      ask(command, rule);
    });
  });

  describe('sed script / in-place', () => {
    it.each(['sed -n 1p src/index.ts', "sed 's/a/b/' src/index.ts", 'sed -n 1,5p package.json'])(
      '%s → allow (read)',
      (command) => {
        allow(command);
        expect(verdict(command).access).toBe('read');
      },
    );

    it.each([
      { command: "sed -n '1e id' src/index.ts", rule: 'read-only-unverified' },
      { command: 'sed -i s/a/b/ /etc/hosts', rule: 'outside-all' },
    ])('$command → ask ($rule)', ({ command, rule }) => {
      ask(command, rule);
    });
  });

  describe('process substitution', () => {
    it.each([
      'diff <(git ls-tree -r HEAD) <(git ls-tree -r origin/main)',
      'cat <(cat src/index.ts)',
    ])('%s → allow', (command) => {
      allow(command);
    });

    it.each([
      { command: 'cat <(rm -rf x)', rule: 'dynamic-shell' },
      { command: 'bash <(true)', rule: 'exec-capability' },
    ])('$command → ask ($rule)', ({ command, rule }) => {
      ask(command, rule);
    });
  });
});

describe('#86 fail-closed regressions', () => {
  it.each([
    { command: 'some-unknown-command --flag', rule: 'unknown-capability' },
    { command: 'timeout 5', rule: 'exec-capability' },
    { command: 'for f in a b; do cat "$f"; done; done', rule: 'unknown-capability' },
    { command: 'awk -f prog.awk src/index.ts', rule: 'exec-capability' },
    { command: 'diff <(git status', rule: 'dynamic-shell' },
  ])('$command → ask ($rule)', ({ command, rule }) => {
    ask(command, rule);
  });

  it('an unparsable process substitution names the parse failure, not a silent unknown', () => {
    const result = verdict('diff <(git status');
    expect(result.decision).toBe('ask');
    expect(result.reason).toContain('could not parse');
  });

  it('an unsupported xargs option names the option', () => {
    const result = verdict('find . | xargs --unknown-option grep x');
    expect(result.decision).toBe('ask');
    expect(result.reason).toContain('xargs option');
  });

  it('an export assignment names the unsupported shape', () => {
    const result = verdict('export R=/path; git status');
    expect(result.decision).toBe('ask');
    expect(result.reason).toContain('export');
  });
});
