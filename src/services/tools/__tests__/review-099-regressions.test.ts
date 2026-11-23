// 0.9.9 review regression matrix (`.agents/tmp/review-0.9.9.md`, sections 3 & 7).
//
// Every case here was executed against the real gate during the review. They
// pin the four P0 fixes and the observed allow/ask baseline so a later change
// cannot silently reopen the boundary.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evaluateBashAccess } from '@/services/tools/permission-rules/bash-access';
import type { WorkerAccessScope } from '@/services/tools/permission-rules/types';

let home: string;
let ws: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'wayang-review-home-'));
  ws = mkdtempSync(join(tmpdir(), 'wayang-review-ws-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});

function scope(): WorkerAccessScope {
  return { userHome: home, workspace: ws };
}

function verdict(command: string) {
  return evaluateBashAccess(scope(), command);
}

describe('0.9.9 review regression matrix', () => {
  describe('P0-1 xargs — a bare verb gets its operands from stdin', () => {
    it.each([
      ['xargs rm', 'dangerous-bash'],
      ["find . -name '*.log' | xargs rm", 'dangerous-bash'],
      ['cat list | xargs rm -f', 'dangerous-bash'],
      // Keep asking: an inner verb plus flags / operands is still destructive.
      ['xargs rm -rf build', 'dangerous-bash'],
    ])('%s → ask (%s)', (command, rule) => {
      const result = verdict(command);
      expect(result.decision).toBe('ask');
      expect(result.matchedRule).toBe(rule);
    });

    it.each([
      // Read with no literal operand: everything it opens comes from stdin, so
      // the outside-all call is impossible.
      ['cat list.txt | xargs cat', 'unknown-capability'],
      // `x` is grep's pattern, not a file: no literal path operand at all.
      ['xargs grep x', 'unknown-capability'],
    ])('%s → ask (%s)', (command, rule) => {
      const result = verdict(command);
      expect(result.decision).toBe('ask');
      expect(result.matchedRule).toBe(rule);
      expect(result.reason).toContain('stdin');
    });
  });

  describe('P0-2 awk — load / include flags are execution entry points', () => {
    it.each([
      ["awk -i inplace '{print}' f.txt", 'exec-capability'],
      ["awk --load x.so '{print}' f.txt", 'exec-capability'],
      ['awk --include x.awk', 'exec-capability'],
      ['awk --include=x.awk', 'exec-capability'],
    ])('%s → ask (%s)', (command, rule) => {
      const result = verdict(command);
      expect(result.decision).toBe('ask');
      expect(result.matchedRule).toBe(rule);
    });
  });

  describe('P0-3 heredoc — an unquoted delimiter lets the shell expand the body', () => {
    it.each([
      "cat <<'EOF'\n$(rm -rf x)\nEOF",
      'cat <<"EOF"\n$(rm -rf x)\nEOF',
      "cat <<-'EOF'\n$(rm -rf x)\nEOF",
    ])('%s → quoted delimiter keeps the current verdict (allow)', (command) => {
      const result = verdict(command);
      expect(result.decision).toBe('allow');
      expect(result.matchedRule).toBe('no-path');
    });

    it.each([
      ['cat <<EOF\n$(rm -rf x)\nEOF', 'dynamic-shell'],
      ['cat <<-EOF\n$(rm -rf x)\nEOF', 'dynamic-shell'],
    ])('%s → ask (%s)', (command, rule) => {
      const result = verdict(command);
      expect(result.decision).toBe('ask');
      expect(result.matchedRule).toBe(rule);
      expect(result.reason).toContain('heredoc');
      expect(result.reason).toContain('command substitution');
    });

    it('a dynamically built delimiter cannot be judged as quoted → ask', () => {
      // The lexer cannot tell whether a `$DELIM` delimiter is quoted; it either
      // ends in its own fail-closed heredoc ask or in a parse failure. Both ask.
      expect(verdict('cat <<$DELIM\nbody\nEOF').decision).toBe('ask');
    });
  });

  describe('gate baseline from the review run', () => {
    it.each([
      ['sha256sum /etc/hostname', 'outside-all'],
      ['ps aux', 'unknown-capability'],
    ])('%s → ask (%s)', (command, rule) => {
      const result = verdict(command);
      expect(result.decision).toBe('ask');
      expect(result.matchedRule).toBe(rule);
    });

    it.each([
      'git status --short',
      'npm --version',
      'for f in 1 2 3; do echo $f; done',
      "awk 'BEGIN{print 1}'",
    ])('%s → allow', (command) => {
      expect(verdict(command).decision).toBe('allow');
    });
  });
});
