/**
 * Session workspace accumulation.
 *
 * A session used to freeze `meta.workspaces` at creation: dispatching a task
 * into a second workspace never wrote the new directory back, so
 * `getLatestSessionForWorkspace`, the session picker and the TUI banner stayed
 * blind to it. The engine now notifies the session (`onTaskWorkspace`), which
 * appends the workspace idempotently by canonical path. These tests exercise
 * that wiring end-to-end: session created in A, task accepted for B, B
 * queryable — with no duplicate entry and a stable slug.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Worker implementations are irrelevant here — only task acceptance matters.
// The puppet fake exposes resolveRun so a multi-stage stage can complete and
// free the worker for reuse (the assign path).
const puppetWorkers: any[] = [];
vi.mock('@/services/agents/worker-agent', () => ({
  WorkerAgent: class {
    readonly id: string;
    readonly workspaceDir: string;
    private deferred: { resolve: (r: any) => void } | null = null;
    run = vi.fn(() => new Promise<any>((resolve) => { this.deferred = { resolve }; }));
    abort = vi.fn();
    getConversation = () => [];
    getState = () => null;
    acceptMessage = vi.fn(() => true);
    subscribe = () => () => {};
    getSnapshot = () => undefined;
    resolveRun = (r: any) => {
      if (!this.deferred) throw new Error('no pending run to resolve');
      this.deferred.resolve(r);
      this.deferred = null;
    };
    constructor(...args: any[]) {
      this.id = `agent-fake-${puppetWorkers.length}`;
      this.workspaceDir = args[4];
      puppetWorkers.push(this);
    }
  },
}));

vi.mock('@/services/agents/claude-code-worker', () => ({
  ClaudeCodeWorker: class {
    readonly id = 'cw-fake';
    readonly workspaceDir = '';
    permissionHandler = { resolvePermission: vi.fn(() => true), cleanup: vi.fn() };
    setInquirySupport = vi.fn();
    setSignalContext = vi.fn();
    run = vi.fn(() => new Promise<any>(() => { /* stays pending */ }));
    abort = vi.fn();
    getConversation = () => [];
    getState = () => null;
    acceptMessage = vi.fn(() => true);
    subscribe = () => () => {};
    getSnapshot = () => undefined;
  },
}));

import { TaskExecuteEngine } from '@/services/task-execute-engine';
import { SignalQueue } from '@/services/signal/signal-queue';
import { createMockCtx, makeTask } from '@/__tests__/helpers';
import { SkillRegistry } from '@/services/skills/registry';
import { SessionManager } from '@/services/session/session-manager';
import { getLatestSessionForWorkspace } from '@/infra/session-helpers';
import { normalizeWorkspacePath, workspaceSlugFromPath } from '@/infra/workspace-registry';

describe('session workspace accumulation', () => {
  let homeDir: string;
  let dirA: string;
  let dirB: string;
  let manager: SessionManager;
  let engine: TaskExecuteEngine;

  /** Meta.json of the session, read fresh from disk. */
  function readMeta() {
    return JSON.parse(readFileSync(join(manager.sessionDir, 'meta.json'), 'utf-8'));
  }

  /** Workspace ref as add_task would stamp it (canonical path + a slug). */
  function refOf(dir: string, slug?: string) {
    const canonical = normalizeWorkspacePath(dir);
    return { path: canonical, slug: slug ?? workspaceSlugFromPath(canonical) };
  }

  beforeEach(() => {
    puppetWorkers.length = 0;
    homeDir = mkdtempSync(join(tmpdir(), 'wayang-accum-home-'));
    dirA = mkdtempSync(join(tmpdir(), 'wayang-accum-a-'));
    dirB = mkdtempSync(join(tmpdir(), 'wayang-accum-b-'));

    // Session created in A.
    manager = SessionManager.create(homeDir, dirA);

    const ctx = createMockCtx({
      sessionDir: manager.sessionDir,
      workspaceDir: dirA,
      maxConcurrency: 3,
    });
    engine = new TaskExecuteEngine(ctx, new SignalQueue(ctx), new SkillRegistry([]), {
      // The exact wiring Supervisor installs.
      onTaskWorkspace: (workspace) => manager.addWorkspace(workspace),
    });
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  it('starts with only the creation workspace', () => {
    const workspaces = readMeta().workspaces as { path: string; slug: string }[];
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].path).toBe(normalizeWorkspacePath(dirA));
  });

  it('appends B when a task is accepted for it, and B then matches the session', () => {
    engine.add(makeTask('t1', { workspace: refOf(dirB) }));

    const workspaces = readMeta().workspaces as { path: string; slug: string }[];
    expect(workspaces).toHaveLength(2);
    expect(workspaces.map((w) => w.path)).toEqual([
      normalizeWorkspacePath(dirA),
      normalizeWorkspacePath(dirB),
    ]);

    // The accumulated workspace is discoverable through the session index.
    const latest = getLatestSessionForWorkspace(homeDir, dirB);
    expect(latest).not.toBeNull();
    expect(latest!.sessionId).toBe(manager.sessionId);

    // A still matches too (the startup workspace is not lost).
    expect(getLatestSessionForWorkspace(homeDir, dirA)!.sessionId).toBe(manager.sessionId);
  });

  it('is idempotent: re-declaring B does not append a second entry', () => {
    const ref = refOf(dirB);
    engine.add(makeTask('t1', { workspace: ref }));
    engine.add(makeTask('t2', { workspace: ref }));
    engine.add(makeTask('t3', { workspace: ref }));

    const workspaces = readMeta().workspaces as { path: string }[];
    expect(workspaces).toHaveLength(2);
    expect(workspaces.filter((w) => w.path === normalizeWorkspacePath(dirB))).toHaveLength(1);
  });

  it('keeps the existing slug: a later declaration cannot rewrite it', () => {
    engine.add(makeTask('t1', { workspace: { path: normalizeWorkspacePath(dirB), slug: 'stable-b' } }));
    // A second declaration of the same canonical path with a different slug.
    engine.add(makeTask('t2', { workspace: { path: normalizeWorkspacePath(dirB), slug: 'changed-b' } }));

    const workspaces = readMeta().workspaces as { path: string; slug: string }[];
    const entry = workspaces.find((w) => w.path === normalizeWorkspacePath(dirB));
    expect(entry?.slug).toBe('stable-b');
    expect(workspaces).toHaveLength(2);
  });

  it('does not accumulate for a task without a workspace stamp', () => {
    // A legacy task runs in the process workspace (A), already recorded.
    engine.add(makeTask('legacy'));

    const workspaces = readMeta().workspaces as { path: string }[];
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].path).toBe(normalizeWorkspacePath(dirA));
  });

  it('does not accumulate a target workspace for a REJECTED (accept never happens)', async () => {
    // Stage 1: multi-stage worker born in A; complete it so it parks idle.
    engine.add(makeTask('t1', { multiStage: true, workspace: refOf(dirA) }));
    const worker = puppetWorkers[0];
    worker.resolveRun({ status: 'completed', summary: 'stage 1' });
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    const idleId = engine.getActiveWorkers()[0].workerId;
    expect(engine.getActiveWorkers()[0].status).toBe('idle');

    // Reuse is workspace-bound: assigning B to the A worker is refused, so the
    // task is never accepted and B must NOT be recorded.
    expect(engine.assignToExistingWorker(idleId, makeTask('t2', { workspace: refOf(dirB) }))).toBe(false);

    const workspaces = readMeta().workspaces as { path: string }[];
    expect(workspaces).toHaveLength(1);
    expect(workspaces.map((w) => w.path)).not.toContain(normalizeWorkspacePath(dirB));
  });
});
