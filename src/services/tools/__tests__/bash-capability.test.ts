// #51 layer 2 — the bash capability gate: exec / network / dynamic / unknown
// verbs ask, reads inside the allowed directories and writes inside the
// workspace allow, and write targets that escape the workspace ask with the
// write-scope rule.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evaluateBashAccess } from '@/services/tools/permission-rules/bash-access';
import type { WorkerAccessScope } from '@/services/tools/permission-rules/types';

let home: string;
let ws: string;
let realHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'wayang-cap-home-'));
  ws = mkdtempSync(join(tmpdir(), 'wayang-cap-ws-'));
  realHome = process.env.HOME;
  process.env.HOME = home;
  mkdirSync(join(home, '.ssh'), { recursive: true });
  writeFileSync(join(home, '.ssh', 'id_rsa'), 'secret');
  mkdirSync(join(ws, 'src'), { recursive: true });
  writeFileSync(join(ws, 'src', 'index.ts'), 'export {};\n');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
  process.env.HOME = realHome;
});

function scope(): WorkerAccessScope {
  return { userHome: home, workspace: ws };
}

describe('evaluateBashAccess capability gate (#51 layer 2)', () => {
  describe('exec / dynamic shapes ask', () => {
    it.each([
      { command: "python -c 'print(1)'", rule: 'exec-capability' },
      { command: "node -e '0'", rule: 'exec-capability' },
      { command: "awk 'BEGIN{system(\"id\")}'", rule: 'exec-capability' },
      { command: 'bash <<EOF\ntrue\nEOF', rule: 'exec-capability' },
      { command: "bash <<< 'true'", rule: 'exec-capability' },
      { command: 'bash <(true)', rule: 'exec-capability' },
      // ksh is NOT on the shell-`-c` recursion table, so the head word itself
      // decides: an interpreter at the command position is exec-capability.
      { command: 'ksh -c true', rule: 'exec-capability' },
      { command: "env -S 'sh -c true'", rule: 'exec-capability' },
      { command: 'script -c true /dev/null', rule: 'unknown-capability' },
      { command: 'su -c true', rule: 'unknown-capability' },
      { command: 'ssh host true', rule: 'unknown-capability' },
      { command: 'source x.sh', rule: 'dynamic-shell' },
    ])('$command → ask ($rule)', ({ command, rule }) => {
      const verdict = evaluateBashAccess(scope(), command);
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe(rule);
    });

    it('a variable in the command position is a dynamic construct', () => {
      const verdict = evaluateBashAccess(scope(), 'X=rm; $X -rf ./src');
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe('dynamic-shell');
    });
  });

  describe('unknown verbs ask', () => {
    it.each(['make', 'npm run build'])('%s → ask (unknown-capability)', (command) => {
      const verdict = evaluateBashAccess(scope(), command);
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe('unknown-capability');
    });
  });

  describe('network verbs ask', () => {
    it('curl → ask (network-capability)', () => {
      const verdict = evaluateBashAccess(scope(), 'curl example.com');
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe('network-capability');
    });
  });

  describe('reads and in-workspace writes allow', () => {
    it.each([
      'pwd',
      'git status',
      'ls',
      'cat src/index.ts',
      'grep -n foo src/index.ts',
      'echo hi > .agents/tmp/a.txt',
      'cat a && tee b',
      'cd src && cat index.ts',
    ])('%s → allow', (command) => {
      const verdict = evaluateBashAccess(scope(), command);
      expect(verdict.decision).toBe('allow');
    });
  });

  describe('write targets escaping the workspace ask (write-scope)', () => {
    it.each(['tee ../y', 'cp x ../y', 'echo x > ../z'])('%s → ask (write-scope)', (command) => {
      const verdict = evaluateBashAccess(scope(), command);
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe('write-scope');
    });
  });

  describe('the sensitive list keeps its priority', () => {
    it('cat ~/.ssh/id_rsa → ask naming .ssh', () => {
      const verdict = evaluateBashAccess(scope(), 'cat ~/.ssh/id_rsa');
      expect(verdict.decision).toBe('ask');
      expect(verdict.matchedRule).toBe('sensitive-list');
      expect(verdict.matchedEntry).toBe('.ssh');
    });
  });
});
