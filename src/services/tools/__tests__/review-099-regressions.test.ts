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

  describe('P1-1 awk — a program-level redirect / pipe is not a read', () => {
    it.each([
      // The target lives in a variable, so the old literal-target regex missed it.
      ["awk 'BEGIN{f=\"/etc/x\"; print \"y\" > f}'", 'exec-capability'],
      // A pipe into a command held in a variable.
      ["awk 'BEGIN{c=\"sh -c id\"; print \"x\" | c}'", 'exec-capability'],
      // A `>` in the SAME statement as a print asks: awk's grammar reads
      // `print … > target` as a redirection, and the statement-level split
      // cannot prove the `>` is the comparison inside the condition.
      // `||` is still coarse (logical-or and pipe share the character).
      ["awk 'BEGIN{if (1 > 0) print \"y\"}'", 'exec-capability'],
      ["awk 'BEGIN{print (1 || 0)}'", 'exec-capability'],
      // An unterminated string literal cannot be parsed confidently.
      ["awk 'BEGIN{print \"unterminated'", 'exec-capability'],
      // A REAL shell redirect on the awk line is a redirect token the redirect
      // tiers judge: a target escaping the workspace asks (write-scope).
      ["awk '{print}' f > ../escape.txt", 'write-scope'],
    ])('%s → ask (%s)', (command, rule) => {
      const result = verdict(command);
      expect(result.decision).toBe('ask');
      expect(result.matchedRule).toBe(rule);
    });

    it('a read-only program without a redirect / pipe still allows', () => {
      expect(verdict("awk 'BEGIN{print 1}'").decision).toBe('allow');
      expect(verdict("awk '{print $1}' src/index.ts").decision).toBe('allow');
      expect(verdict("awk -F: '{print $1}' src/index.ts").decision).toBe('allow');
      // A `>` / `|` INSIDE a string literal is just text, not a redirection.
      expect(verdict("awk 'BEGIN{print \"a>b|c\"}'").decision).toBe('allow');
    });

    it('a comparison `>` is awk syntax, not a redirection (0.9.9 walkthrough fix)', () => {
      // No print in the statement: the `>` is greater-than, so the program is
      // a verified read — these used to ask on the coarse "program text
      // contains >" scan.
      expect(verdict("awk '$3 > 100' f").decision).toBe('allow');
      expect(verdict("awk 'NR>1' f").decision).toBe('allow');
      // Pattern-action: the comparison lives in the pattern chunk, the print
      // in its own action chunk — both clean.
      expect(verdict("awk '$3 > 100 {print $1}' f").decision).toBe('allow');
    });

    it('an in-workspace shell redirect keeps the #51 layer 2 write allow (not awk-specific)', () => {
      // `out` resolves inside the workspace, so the redirect write is allowed
      // EXACTLY like `echo hi > out` — awk is not special-cased here. The
      // walkthrough note expected an ask for this shape; the gate's contract
      // is (and was): a RELATIVE redirect target that escapes the workspace
      // asks (write-scope, pinned above), one inside it is a designed silent
      // write. Pinned so the boundary is explicit.
      const result = verdict("awk '{print}' f > out");
      expect(result.decision).toBe('allow');
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

  describe('P1-6 unknown reasons name the actual failed check', () => {
    it('an off-table verb says it is not on the capability tables', () => {
      for (const command of ['ps aux', 'some-unknown-command --flag']) {
        const result = verdict(command);
        expect(result.decision).toBe('ask');
        expect(result.matchedRule).toBe('unknown-capability');
        expect(result.reason).toContain('not on the bash capability tables');
        expect(result.reason).not.toContain('subcommand');
      }
    });

    it('a non-read subcommand of a table verb names the subcommand, not a missing table entry', () => {
      for (const command of ['git branch -D x', 'npm run build']) {
        const result = verdict(command);
        expect(result.decision).toBe('ask');
        expect(result.matchedRule).toBe('unknown-capability');
        expect(result.reason).toContain('is on the capability tables');
        expect(result.reason).toContain('subcommand / shape is not covered as read-only');
      }
    });

    it('git -c names the configuration override', () => {
      const result = verdict('git -c core.pager=cat status');
      expect(result.decision).toBe('ask');
      expect(result.matchedRule).toBe('unknown-capability');
      expect(result.reason).toContain('git -c');
      expect(result.reason).toContain('external configuration');
      expect(result.reason).not.toContain('not on the bash capability tables');
    });
  });

  // Round 3 (C1/C3/C5) — `.agents/tmp/review-result.md`, section 五.C.
  describe('review round 3 — permission gate', () => {
    describe('C1: xargs value options no longer shift the pattern slot', () => {
      it.each([
        // -A takes a value: without the value-option table '3' ate the pattern
        // slot and 'pat' posed as a file operand, so this ALLOWED while the
        // bare form asked — the ask direction was inverted.
        ['xargs grep -A 3 pat'],
        ['xargs grep pat'],
        ['find . | xargs grep -A 3 pat'],
        ['xargs rg -C 2 pat'],
        ['xargs grep --context 3 pat'],
      ])('%s → ask (no literal operand, like the bare form)', (command) => {
        const result = verdict(command);
        expect(result.decision).toBe('ask');
        expect(result.matchedRule).toBe('unknown-capability');
        expect(result.reason).toContain('no literal operand');
      });

      it('control: a valueless flag keeps the real operand — the ordinary gate judges it', () => {
        // -n takes NO value, so 'pat' stays the pattern and 'file' stays a
        // literal operand: the no-literal-operand ask must not fire (it fired
        // only if -n were misread as value-taking, which would swallow 'pat'
        // and turn 'file' into the pattern).
        const result = verdict('xargs grep -n pat file');
        expect(result.decision).toBe('allow');
      });

      it('a pattern supplied via -e consumes the pattern slot, later words stay operands', () => {
        // 'foo' is -e's VALUE (the pattern itself): 'file' must not be demoted
        // to the pattern slot and dropped from the operand list.
        expect(verdict('xargs grep -e foo file').decision).toBe('allow');
        expect(verdict('xargs grep -e foo').decision).toBe('ask');
      });
    });

    describe('C3: glued `git -c` judges like the split form', () => {
      it.each([
        ['git -ccore.pager=cat log'],
        ['git -c core.pager=cat log'],
      ])('%s → ask (both spellings identical)', (command) => {
        const result = verdict(command);
        expect(result.decision).toBe('ask');
        expect(result.matchedRule).toBe('unknown-capability');
        expect(result.reason).toContain('git -c');
        expect(result.reason).toContain('external configuration');
      });
    });

    describe('C5: the destructive tier carries the asking paths', () => {
      it('find -delete asks and names the path it would act on', () => {
        const result = verdict('find /etc -name "*.conf" -delete');
        expect(result.decision).toBe('ask');
        expect(result.matchedRule).toBe('dangerous-bash');
        expect(result.access).toBe('write');
        expect(result.askPaths).toContain('/etc');
      });

      it('a read-access dangerous line still carries no askPaths (no grant reuse)', () => {
        // `sudo cat <path>` is a destructive WRAPPER over a read: attaching
        // askPaths here would let a pre-granted read of the path silently
        // cover the escalated run (reusableGrantKeys reuses read grants).
        const result = verdict('sudo cat /etc/passwd');
        expect(result.decision).toBe('ask');
        expect(result.matchedRule).toBe('dangerous-bash');
        expect(result.access).toBe('read');
        expect(result.askPaths).toBeUndefined();
      });
    });
  });

  describe('P0-4 background / detached execution escapes the task lifecycle', () => {
    // From `.agents/tmp/builtin-tools-gap-analysis.md` §四: `nohup node
    // drive-server.mjs … &` ran twice (19:15:52 / 19:17:33) with no
    // permission_request, while `timeout 60 node drive-server.mjs …` asked
    // (seq 236). Root cause: the trailing `&` is only the lexer's segment
    // terminator (no tier read it), `nohup` is a stripped wrapper, and the
    // session's real command redirected stdout into the workspace, which
    // classified the whole segment as an in-scope write before `node`'s exec
    // class could fire. Now ANY background / detached shape asks.
    it.each([
      'nohup node drive-server.mjs &',
      'node drive-server.mjs &',
      'nohup node x.mjs',
      'echo hi &',
      'nohup git status &',
      'nohup git status',
      'setsid node x.mjs',
      'node x.mjs & disown',
      'disown node x.mjs',
    ])('%s → ask (background-capability)', (command) => {
      const result = verdict(command);
      expect(result.decision).toBe('ask');
      expect(result.matchedRule).toBe('background-capability');
      expect(result.reason).toContain('task lifecycle');
    });

    it('the gap-analysis shape — nohup + output redirect + `&` — asks, not the write classification', () => {
      const result = verdict(
        'nohup node .agents/tmp/drive-server.mjs dist/cli.js > .agents/tmp/drive.log 2>&1 &\necho started',
      );
      expect(result.decision).toBe('ask');
      expect(result.matchedRule).toBe('background-capability');
    });

    it('a judged `-c` script cannot launder the nohup prefix', () => {
      const result = verdict('nohup bash -c "git status"');
      expect(result.decision).toBe('ask');
      expect(result.matchedRule).toBe('background-capability');
    });

    it('timeout keeps its exec ask (both sides of the observed inconsistency now ask)', () => {
      const result = verdict('timeout 60 node drive-server.mjs');
      expect(result.decision).toBe('ask');
      expect(result.matchedRule).toBe('exec-capability');
    });

    it('a destructive nohup keeps the dangerous tier (priority unchanged)', () => {
      const result = verdict('nohup rm -rf x');
      expect(result.decision).toBe('ask');
      expect(result.matchedRule).toBe('dangerous-bash');
    });

    it('a detached read asks on the background rule — no reusable path grant, and the sensitive hit is carried (#42 shape)', () => {
      const result = verdict('nohup cat ~/.ssh/id_rsa');
      expect(result.decision).toBe('ask');
      expect(result.matchedRule).toBe('background-capability');
      expect(result.matchedEntry).toBe('.ssh');
      expect(result.sensitive).toBe(true);
      expect(result.askPaths).toBeUndefined();
    });

    it.each(['git status', 'git status && echo hi'])('%s → allow (no backgrounding)', (command) => {
      expect(verdict(command).decision).toBe('allow');
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
