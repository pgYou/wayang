/**
 * run_process verdicts (0.9.9 walkthrough fix): the constant-ask baseline is
 * unchanged — every call still needs controller approval, no askPaths, the
 * reason carries the argv verbatim — but two hard refusals now sit in front of
 * it: a sensitive-list hit in argv text or cwd (the SAME scan the bash gate
 * uses), and a cwd outside the task workspace / allowedDirs. A deny must
 * never be downgraded to the baseline ask.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { decideToolAccess, type WorkerAccessScope } from '@/services/tools/permission-rules';

/** Stand-in home dir containing the built-in sensitive locations. */
let home: string;
/** Task workspace — deliberately NOT inside home. */
let ws: string;
/** An extra task-allowed directory outside the workspace. */
let allowed: string;
/** The real $HOME, saved while tests point it at the stand-in home. */
let realHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'wayang-runproc-home-'));
  ws = mkdtempSync(join(tmpdir(), 'wayang-runproc-ws-'));
  allowed = mkdtempSync(join(tmpdir(), 'wayang-runproc-allow-'));
  realHome = process.env.HOME;
  process.env.HOME = home;
  mkdirSync(join(home, '.ssh'), { recursive: true });
  writeFileSync(join(home, '.ssh', 'id_rsa'), 'secret');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
  rmSync(allowed, { recursive: true, force: true });
  process.env.HOME = realHome;
});

function scope(overrides: Partial<WorkerAccessScope> = {}): WorkerAccessScope {
  return { userHome: home, workspace: ws, ...overrides };
}

/** sensitiveMode: 'deny' — the walkthrough config where bash hard-refuses. */
function strictScope(overrides: Partial<WorkerAccessScope> = {}): WorkerAccessScope {
  return scope({ permission: { sensitiveMode: 'deny' }, ...overrides });
}

function run(scope: WorkerAccessScope, args: Record<string, unknown>) {
  return decideToolAccess(scope, 'run_process', args);
}

describe('run_process — the constant-ask baseline is unchanged', () => {
  it('a plain in-workspace call still asks, carrying the argv verbatim', () => {
    const verdict = run(scope(), { command: ['node', 'script.js'] });
    expect(verdict.decision).toBe('ask');
    expect(verdict.matchedRule).toBe('exec-capability');
    expect(verdict.reason).toContain('["node","script.js"]');
    expect(verdict.matchedEntry).toBeUndefined();
    // No askPaths on purpose: an approval is a one-call decision, never a
    // standing grant the task approval memory could reuse.
    expect(verdict.askPaths).toBeUndefined();
  });

  it('a relative cwd inside the workspace still asks (not denied)', () => {
    const verdict = run(scope(), { command: ['node', 'script.js'], cwd: 'sub' });
    expect(verdict.decision).toBe('ask');
    expect(verdict.matchedRule).toBe('exec-capability');
  });

  it('a cwd inside a task allowedDirs entry still asks (not denied)', () => {
    const verdict = run(scope({ taskAllowedDirs: [allowed] }), {
      command: ['node', 'script.js'],
      cwd: allowed,
    });
    expect(verdict.decision).toBe('ask');
    expect(verdict.matchedRule).toBe('exec-capability');
  });
});

describe('run_process — a sensitive hit is refused, not downgraded to ask', () => {
  it('argv naming a credential file: absolute spelling (deny mode)', () => {
    const verdict = run(strictScope(), { command: ['cat', join(home, '.ssh', 'id_rsa')] });
    expect(verdict.decision).toBe('deny');
    expect(verdict.matchedRule).toBe('sensitive-list');
    expect(verdict.matchedEntry).toBe('.ssh');
    expect(verdict.sensitive).toBe(true);
    // The refusal explains the boundary and names only what the worker sent.
    expect(verdict.message).toContain('run_process');
    expect(verdict.message).toContain('sensitive list');
    expect(verdict.message).toContain(join(home, '.ssh', 'id_rsa'));
  });

  it('argv naming a credential file: `~` spelling (deny mode)', () => {
    const verdict = run(strictScope(), { command: ['cat', '~/.ssh/id_rsa'] });
    expect(verdict.decision).toBe('deny');
    expect(verdict.matchedRule).toBe('sensitive-list');
    expect(verdict.matchedEntry).toBe('.ssh');
  });

  it('a path inside an argv element that spells a command is caught too (deny mode)', () => {
    const verdict = run(strictScope(), {
      command: ['bash', '-c', 'cat ~/.ssh/id_rsa'],
    });
    expect(verdict.decision).toBe('deny');
    expect(verdict.matchedRule).toBe('sensitive-list');
    expect(verdict.matchedEntry).toBe('.ssh');
  });

  it('a sensitive cwd is refused, exactly like a sensitive argv (deny mode)', () => {
    const verdict = run(strictScope(), { command: ['node', 'script.js'], cwd: join(home, '.ssh') });
    expect(verdict.decision).toBe('deny');
    expect(verdict.matchedRule).toBe('sensitive-list');
    expect(verdict.matchedEntry).toBe('.ssh');
    expect(verdict.message).toContain('sensitive list');
  });

  it('under the default ask mode the hit keeps the ask but carries the entry', () => {
    // Same source as bash: a sensitive hit asks carrying `matchedEntry`
    // instead of the bare exec-capability reason — the audit trail must not
    // lose it.
    const verdict = run(scope(), { command: ['cat', join(home, '.ssh', 'id_rsa')] });
    expect(verdict.decision).toBe('ask');
    expect(verdict.matchedRule).toBe('sensitive-list');
    expect(verdict.matchedEntry).toBe('.ssh');
    expect(verdict.sensitive).toBe(true);
    expect(verdict.askPaths).toBeUndefined();
  });

  it('a benign absolute path in argv is not a hit (no false positives)', () => {
    const verdict = run(strictScope(), { command: ['ls', '/usr/local/bin'] });
    expect(verdict.decision).toBe('ask');
    expect(verdict.matchedRule).toBe('exec-capability');
  });
});

describe('run_process — cwd must stay inside the workspace / allowedDirs', () => {
  it('a cwd outside every allowed scope is refused outright (deny mode)', () => {
    const verdict = run(strictScope(), { command: ['node', 'script.js'], cwd: '/etc' });
    expect(verdict.decision).toBe('deny');
    expect(verdict.matchedRule).toBe('write-scope');
    expect(verdict.message).toContain('outside the task workspace');
    expect(verdict.message).toContain('/etc');
  });

  it('a cwd outside every allowed scope is refused in ask mode too', () => {
    const verdict = run(scope(), { command: ['node', 'script.js'], cwd: '/etc' });
    expect(verdict.decision).toBe('deny');
    expect(verdict.matchedRule).toBe('write-scope');
  });

  it('`~user` as cwd cannot be proven in scope — refused', () => {
    const verdict = run(scope(), { command: ['node', 'script.js'], cwd: '~other-user' });
    expect(verdict.decision).toBe('deny');
    expect(verdict.message).toContain('another user\'s home');
  });
});

describe('run_process — deny outranks ask', () => {
  it('a sensitive argv deny wins over a simultaneously out-of-scope cwd', () => {
    // Both would deny; the sensitive one carries the entry, so it must win
    // the verdict — the audit trail keeps its matchedEntry.
    const verdict = run(strictScope(), {
      command: ['cat', '~/.ssh/id_rsa'],
      cwd: '/etc',
    });
    expect(verdict.decision).toBe('deny');
    expect(verdict.matchedRule).toBe('sensitive-list');
    expect(verdict.matchedEntry).toBe('.ssh');
  });
});
