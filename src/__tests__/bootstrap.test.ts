/**
 * bootstrap — session resolution + server spawn wiring.
 *
 * Regression focus: the `--home-dir` flag has ROOT semantics (usually $HOME);
 * bootstrap must join `.wayang` itself for client-side session lookups and
 * forward the ROOT to the server spawn. Forwarding the pre-joined dir made
 * the server double-join (`~/.wayang/.wayang`) and resume always failed with
 * "Session not found".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';

vi.mock('@/client/connect');
vi.mock('@/tui/render');
vi.mock('@/onboard');
vi.mock('@/session-select');

import { bootstrap } from '@/bootstrap';
import { connectRemoteServer } from '@/client/connect';
import { selectSessionInteractive } from '@/session-select';
import type { SessionMeta } from '@/infra/session-helpers';

// --- Helpers ---

let root: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

/** Write a session into `<root>/.wayang/sessions/<id>/meta.json`. */
function writeSessionMeta(sessionId: string, meta: Partial<SessionMeta> & { workspace: string; createdAt: number }) {
  const dir = join(root, '.wayang', 'sessions', sessionId);
  mkdirSync(dir, { recursive: true });
  const full: SessionMeta = {
    sessionId,
    workspace: meta.workspace,
    firstInput: meta.firstInput ?? null,
    createdAt: meta.createdAt,
    lastActiveAt: meta.lastActiveAt ?? meta.createdAt,
    ...(meta.workspaces ? { workspaces: meta.workspaces } : {}),
  };
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(full));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wayang-bootstrap-test-'));
  vi.mocked(connectRemoteServer).mockReset();
  vi.mocked(connectRemoteServer).mockResolvedValue({ remote: {} as never, stop: vi.fn() });
  vi.mocked(selectSessionInteractive).mockReset();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit called');
  }) as never);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  logSpy.mockRestore();
  errorSpy.mockRestore();
  exitSpy.mockRestore();
  vi.mocked(connectRemoteServer).mockRestore();
});

function connectCall(index = 0): Record<string, unknown> {
  const call = vi.mocked(connectRemoteServer).mock.calls[index];
  expect(call).toBeDefined();
  return call![0] as unknown as Record<string, unknown>;
}

// --- Tests ---

describe('bootstrap — homeDir root semantics', () => {
  it('sessionless resume: finds sessions under <root>/.wayang and passes the ROOT to the server', async () => {
    writeSessionMeta('20260101-000000', { workspace: '/repo-a', createdAt: 1000 });

    await bootstrap({
      configPath: join(root, 'wayang.config.json'),
      homeDir: root,
      workspaceDir: '/repo-a',
    });

    // The regression: connectRemoteServer must receive the ROOT, not the
    // pre-joined <root>/.wayang — the server joins `.wayang` itself.
    const call = connectCall();
    expect(call.homeDir).toBe(root);
    expect(call.homeDir).not.toBe(join(root, '.wayang'));
    expect(call.session).toEqual({ resume: '20260101-000000' });
    expect(call.injectPreviousTasks).toBe(true);
    expect(call.workspaceDir).toBe('/repo-a');
    expect(call.configPath).toBe(join(root, 'wayang.config.json'));
  });

  it('sessionless with no prior sessions: starts a new session', async () => {
    await bootstrap({
      configPath: join(root, 'wayang.config.json'),
      homeDir: root,
      workspaceDir: '/repo-a',
    });

    const call = connectCall();
    expect(call.homeDir).toBe(root);
    expect(call.session).toBe('new');
    expect(call.injectPreviousTasks).toBe(false);
  });

  it('--fresh: ignores an existing latest session', async () => {
    writeSessionMeta('20260101-000000', { workspace: '/repo-a', createdAt: 1000 });

    await bootstrap({
      configPath: join(root, 'wayang.config.json'),
      homeDir: root,
      workspaceDir: '/repo-a',
      fresh: true,
    });

    expect(connectCall().session).toBe('new');
  });

  it('--resume <id>: resolves the session under <root>/.wayang and uses its workspace', async () => {
    writeSessionMeta('20260102-000000', { workspace: '/repo-b', createdAt: 2000 });

    await bootstrap({
      configPath: join(root, 'wayang.config.json'),
      homeDir: root,
      workspaceDir: '/repo-a',
      resume: '20260102-000000',
    });

    const call = connectCall();
    expect(call.session).toEqual({ resume: '20260102-000000' });
    expect(call.workspaceDir).toBe('/repo-b');
    // Explicit resume does not surface unfinished tasks as a signal.
    expect(call.injectPreviousTasks).toBe(false);
  });

  it('--resume <id>: uses the startup workspace, not the first workspaces entry', async () => {
    // The session was started in /repo-b, then touched /repo-a. The startup
    // workspace is the entry matching meta.workspace (/repo-b), even though
    // the array's first element is /repo-a.
    writeSessionMeta('20260102-100000', {
      workspace: '/repo-b',
      createdAt: 2500,
      workspaces: [
        { path: '/repo-a', slug: 'repo-a' },
        { path: '/repo-b', slug: 'repo-b' },
      ],
    });

    await bootstrap({
      configPath: join(root, 'wayang.config.json'),
      homeDir: root,
      workspaceDir: '/repo-c',
      resume: '20260102-100000',
    });

    expect(connectCall().workspaceDir).toBe('/repo-b');
  });

  it('--resume <id>: falls back to the CLI workspace when the session records none', async () => {
    writeSessionMeta('20260102-110000', { workspace: '', createdAt: 2600 });

    await bootstrap({
      configPath: join(root, 'wayang.config.json'),
      homeDir: root,
      workspaceDir: '/repo-c',
      resume: '20260102-110000',
    });

    expect(connectCall().workspaceDir).toBe('/repo-c');
  });

  it('--resume (interactive): resolves the picked session startup workspace', async () => {
    const sessionId = '20260102-120000';
    writeSessionMeta(sessionId, {
      workspace: '/repo-b',
      createdAt: 2700,
      workspaces: [
        { path: '/repo-a', slug: 'repo-a' },
        { path: '/repo-b', slug: 'repo-b' },
      ],
    });
    vi.mocked(selectSessionInteractive).mockResolvedValue({
      sessionId,
      sessionDir: join(root, '.wayang', 'sessions', sessionId),
      meta: {
        sessionId,
        workspace: '/repo-b',
        firstInput: null,
        createdAt: 2700,
        lastActiveAt: 2700,
        workspaces: [
          { path: '/repo-a', slug: 'repo-a' },
          { path: '/repo-b', slug: 'repo-b' },
        ],
      },
    });

    await bootstrap({
      configPath: join(root, 'wayang.config.json'),
      homeDir: root,
      workspaceDir: '/repo-c',
      resume: '',
    });

    const call = connectCall();
    expect(call.session).toEqual({ resume: sessionId });
    expect(call.workspaceDir).toBe('/repo-b');
  });

  it('--resume <unknown-id>: dies with exit code 1', async () => {
    await expect(bootstrap({
      configPath: join(root, 'wayang.config.json'),
      homeDir: root,
      workspaceDir: '/repo-a',
      resume: 'missing-session',
    })).rejects.toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Session "missing-session" not found.'));
    expect(connectRemoteServer).not.toHaveBeenCalled();
  });

  it('canonicalizes the forwarded workspace (symlinked spelling → realpath)', async () => {
    const realDir = join(root, 'real-repo');
    mkdirSync(realDir, { recursive: true });
    const linkDir = join(root, 'repo-link');
    symlinkSync(realDir, linkDir, 'dir');
    writeSessionMeta('20260103-000000', { workspace: linkDir, createdAt: 3000 });

    await bootstrap({
      configPath: join(root, 'wayang.config.json'),
      homeDir: root,
      workspaceDir: '/repo-a',
      resume: '20260103-000000',
    });

    // The session's recorded workspace is a symlink; the process workspace is
    // forwarded canonicalized, matching how add_task stamps task workspaces
    // (and therefore how the permission gate compares roots).
    const call = connectCall();
    expect(call.workspaceDir).toBe(realpathSync(realDir));
    expect(call.workspaceDir).not.toBe(linkDir);
  });

  it('normalizes and de-duplicates session workspaces forwarded to the display layer', async () => {
    const realA = join(root, 'ws-a');
    const realB = join(root, 'ws-b');
    mkdirSync(realA, { recursive: true });
    mkdirSync(realB, { recursive: true });
    const linkA = join(root, 'ws-a-link');
    symlinkSync(realA, linkA, 'dir');

    const sessionId = '20260104-000000';
    const dir = join(root, '.wayang', 'sessions', sessionId);
    mkdirSync(dir, { recursive: true });
    // `workspaces` carries a symlink spelling of ws-a and a duplicate ws-b;
    // the display layer must see one entry per distinct canonical path.
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({
      sessionId,
      workspace: realA,
      firstInput: null,
      createdAt: 4000,
      lastActiveAt: 4000,
      workspaces: [
        { path: realA, slug: 'ws-a' },
        { path: linkA, slug: 'ws-a' },
        { path: realB, slug: 'ws-b' },
        { path: realB, slug: 'ws-b' },
      ],
    }));

    await bootstrap({
      configPath: join(root, 'wayang.config.json'),
      homeDir: root,
      workspaceDir: '/repo-a',
      resume: sessionId,
    });

    const workspaces = connectCall().workspaces as Array<{ path: string; slug: string }>;
    expect(workspaces.map((w) => w.path)).toEqual([realpathSync(realA), realpathSync(realB)]);
    expect(workspaces.map((w) => w.slug)).toEqual(['ws-a', 'ws-b']);
  });

  it('forwards logLevel to the server spawn', async () => {
    await bootstrap({
      configPath: join(root, 'wayang.config.json'),
      homeDir: root,
      workspaceDir: '/repo-a',
      logLevel: 'debug',
    });

    expect(connectCall().logLevel).toBe('debug');
  });
});
