/**
 * 0.9.9 walkthrough fixes — bash gate ORDERING and destructive-tier scope:
 *
 *   1. A sensitive DENY must outrank the unquoted-heredoc ask. The heredoc
 *      branch returns before the main candidate sweep runs, so
 *      `cat ~/.ssh/id_rsa <<EOF` used to downgrade a hard refusal
 *      (sensitiveMode: 'deny') into the heredoc ask AND lose its matched
 *      entry. The branch now runs the sweep's deny/hit part first; in ask
 *      mode the heredoc ask carries the hit like the destructive tier does.
 *   2. Destructive write spellings (`sed -i`, `find -delete`) ask inside the
 *      workspace too, exactly like `rm -rf build` did — they delete/rewrite
 *      what they name, so an in-scope target must not make them silent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { evaluateBashAccess, type WorkerAccessScope } from '@/services/tools/permission-rules';

/** Stand-in home dir containing the built-in sensitive locations. */
let home: string;
/** Task workspace — deliberately NOT inside home. */
let ws: string;
/** The real $HOME, saved while tests point it at the stand-in home. */
let realHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'wayang-deny-home-'));
  ws = mkdtempSync(join(tmpdir(), 'wayang-deny-ws-'));
  realHome = process.env.HOME;
  process.env.HOME = home;
  mkdirSync(join(home, '.ssh'), { recursive: true });
  writeFileSync(join(home, '.ssh', 'id_rsa'), 'secret');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
  process.env.HOME = realHome;
});

function scope(overrides: Partial<WorkerAccessScope> = {}): WorkerAccessScope {
  return { userHome: home, workspace: ws, ...overrides };
}

function strict(overrides: Partial<WorkerAccessScope> = {}): WorkerAccessScope {
  return scope({ permission: { sensitiveMode: 'deny' }, ...overrides });
}

describe('a sensitive deny outranks the unquoted-heredoc ask', () => {
  it('cat ~/.ssh/id_rsa <<EOF is refused under sensitiveMode: deny, with the entry preserved', () => {
    const verdict = evaluateBashAccess(strict(), 'cat ~/.ssh/id_rsa <<EOF\nbody\nEOF');
    expect(verdict.decision).toBe('deny');
    expect(verdict.matchedRule).toBe('sensitive-list');
    // The audit trail keeps the hit — the denial is not a bare heredoc ask.
    expect(verdict.matchedEntry).toBe('.ssh');
    expect(verdict.sensitive).toBe(true);
  });

  it('a sensitive WRITE through a heredoc line is refused too (deny mode)', () => {
    const verdict = evaluateBashAccess(strict(), 'tee ~/.ssh/authorized_keys <<EOF\nx\nEOF');
    expect(verdict.decision).toBe('deny');
    expect(verdict.matchedRule).toBe('sensitive-list');
    expect(verdict.matchedEntry).toBe('.ssh');
  });

  it('in ask mode the heredoc ask carries the sensitive hit (matchedEntry preserved)', () => {
    const verdict = evaluateBashAccess(scope(), 'cat ~/.ssh/id_rsa <<EOF\nbody\nEOF');
    expect(verdict.decision).toBe('ask');
    expect(verdict.matchedRule).toBe('dynamic-shell');
    expect(verdict.reason).toContain('heredoc');
    // Losing matchedEntry here would lose the audit lead — carry it like the
    // destructive / detached tiers do.
    expect(verdict.matchedEntry).toBe('.ssh');
    expect(verdict.sensitive).toBe(true);
  });

  it('a heredoc line with NO sensitive candidate keeps the bare heredoc ask', () => {
    const verdict = evaluateBashAccess(strict(), 'cat <<EOF\n$(rm -rf x)\nEOF');
    expect(verdict.decision).toBe('ask');
    expect(verdict.matchedRule).toBe('dynamic-shell');
    expect(verdict.matchedEntry).toBeUndefined();
    expect(verdict.sensitive).toBeUndefined();
  });

  it('a quoted delimiter never takes the heredoc branch — the ordinary sweep denies (deny mode)', () => {
    // Contrast case: `<<'EOF'` keeps the body literal, so the line is judged by
    // the ordinary candidate sweep and refuses as before.
    const verdict = evaluateBashAccess(strict(), "cat ~/.ssh/id_rsa <<'EOF'\n$(rm -rf x)\nEOF");
    expect(verdict.decision).toBe('deny');
    expect(verdict.matchedRule).toBe('sensitive-list');
    expect(verdict.matchedEntry).toBe('.ssh');
  });
});

describe('destructive write spellings ask inside the workspace too', () => {
  it.each([
    'find . -delete',
    'find . -name x -delete',
    'sed -i s/a/b/ f',
    // Glued short-flag spelling counts (`-i.bak`) — same matcher as the
    // write-direction split.
    'sed -i.bak s/a/b/ f',
  ])('%s → ask (dangerous-bash)', (command) => {
    const verdict = evaluateBashAccess(scope(), command);
    expect(verdict.decision).toBe('ask');
    expect(verdict.matchedRule).toBe('dangerous-bash');
  });

  it('rm -rf keeps its destructive ask (regression anchor)', () => {
    const verdict = evaluateBashAccess(scope(), 'rm -rf build');
    expect(verdict.decision).toBe('ask');
    expect(verdict.matchedRule).toBe('dangerous-bash');
  });

  it('plain sed / find without the destructive flags keep their verdicts', () => {
    expect(evaluateBashAccess(scope(), "sed 's/a/b/' f").decision).toBe('allow');
    expect(evaluateBashAccess(scope(), "sed 's/a/b/' f").access).toBe('read');
    expect(evaluateBashAccess(scope(), 'find . -name x').decision).toBe('allow');
    // A non-destructive write flag keeps its ordinary write verdict: -fprint
    // writes a file, so the scope rules judge it, but it is not a delete.
    expect(evaluateBashAccess(scope(), 'find . -name x -fprint out.txt').decision).toBe('allow');
  });

  it('a sensitive target still DENIES first — the destructive ask never downgrades it (deny mode)', () => {
    const verdict = evaluateBashAccess(strict(), 'sed -i s/a/b/ ~/.ssh/id_rsa');
    expect(verdict.decision).toBe('deny');
    expect(verdict.matchedRule).toBe('sensitive-list');
    expect(verdict.matchedEntry).toBe('.ssh');
  });

  it('the destructive ask carries the sensitive hit in ask mode (#42 shape)', () => {
    const verdict = evaluateBashAccess(scope(), 'sed -i s/a/b/ ~/.ssh/id_rsa');
    expect(verdict.decision).toBe('ask');
    expect(verdict.matchedRule).toBe('dangerous-bash');
    expect(verdict.matchedEntry).toBe('.ssh');
    expect(verdict.sensitive).toBe(true);
  });
});
