/**
 * session-select — picker row formatting + workspace mismatch detection.
 *
 * Regression focus: rows describe how many workspaces a session covers
 * ("repo-a (+2)"), and the mismatch warning compares canonical paths across
 * ALL of a session's workspaces. The previous raw
 * `meta.workspace !== workspaceDir` comparison both ignored extra workspaces
 * and warned falsely when the same directory was entered through a symlink.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('prompts', () => ({ default: vi.fn() }));

import prompts from 'prompts';
import {
  formatSessionChoice,
  formatSessionWorkspaces,
  formatRelativeLastActive,
  isWorkspaceMismatch,
  selectSessionInteractive,
} from '@/session-select';
import type { SessionMeta } from '@/infra/session-helpers';

const NOW = 1_780_000_000_000;

/** Base meta with time-independent values; callers override what they assert. */
function makeMeta(partial: Partial<SessionMeta> & { workspace: string }): SessionMeta {
  return {
    sessionId: '20260101-000000',
    firstInput: 'fix the bug',
    createdAt: NOW - 3_600_000,
    lastActiveAt: NOW - 300_000,
    ...partial,
  };
}

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  vi.mocked(prompts).mockReset();
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('formatSessionWorkspaces', () => {
  it('shows the single workspace slug for a legacy single-workspace session', () => {
    expect(formatSessionWorkspaces(makeMeta({ workspace: '/work/repo-a' }))).toBe('repo-a');
  });

  it('shows "first (+N)" for a multi-workspace session', () => {
    const meta = makeMeta({
      workspace: '/work/repo-a',
      workspaces: [
        { path: '/work/repo-a', slug: 'repo-a' },
        { path: '/work/repo-b', slug: 'repo-b' },
        { path: '/work/repo-c', slug: 'repo-c' },
      ],
    });
    expect(formatSessionWorkspaces(meta)).toBe('repo-a (+2)');
  });

  it('derives a slug for legacy meta that has no registry slug', () => {
    expect(formatSessionWorkspaces(makeMeta({ workspace: '/work/Repo_D' }))).toBe('repo-d');
  });

  it('reports a session with no workspace identity', () => {
    expect(formatSessionWorkspaces(makeMeta({ workspace: '', workspaces: [] }))).toBe('(no workspace)');
  });
});

describe('formatRelativeLastActive', () => {
  it.each([
    [NOW - 10_000, 'just now'],
    [NOW - 5 * 60_000, '5m ago'],
    [NOW - 3 * 3_600_000, '3h ago'],
    [NOW - 2 * 86_400_000, '2d ago'],
    [NOW - 45 * 86_400_000, '1mo ago'],
  ])('describes %i → %s', (lastActiveAt, expected) => {
    expect(formatRelativeLastActive(lastActiveAt, NOW)).toBe(expected);
  });
});

describe('formatSessionChoice', () => {
  it('renders a single-workspace session row with workspace and last-active fragments', () => {
    const row = formatSessionChoice(makeMeta({ workspace: '/work/repo-a' }), NOW);
    expect(row).toContain('20260101-000000');
    expect(row).toContain('"fix the bug"');
    expect(row).toContain('[repo-a]');
    expect(row).toContain('active 5m ago');
    expect(row).not.toContain('(+');
  });

  it('renders "+N" for a multi-workspace session row', () => {
    const meta = makeMeta({
      workspace: '/work/repo-a',
      workspaces: [
        { path: '/work/repo-a', slug: 'repo-a' },
        { path: '/work/repo-b', slug: 'repo-b' },
        { path: '/work/repo-c', slug: 'repo-c' },
      ],
    });
    expect(formatSessionChoice(meta, NOW)).toContain('[repo-a (+2)]');
  });
});

describe('isWorkspaceMismatch', () => {
  it('accepts a symlinked spelling of the session workspace', () => {
    const root = tempDir('wayang-select-symlink-');
    const real = join(root, 'repo-a');
    mkdirSync(real);
    const link = join(root, 'repo-a-link');
    symlinkSync(real, link);

    // Both directions: meta stored via the link, cwd real — and vice versa.
    expect(isWorkspaceMismatch(makeMeta({ workspace: link }), real)).toBe(false);
    expect(isWorkspaceMismatch(makeMeta({ workspace: real }), link)).toBe(false);
  });

  it('accepts a target that matches any of the session workspaces', () => {
    const meta = makeMeta({
      workspace: '/work/repo-a',
      workspaces: [
        { path: '/work/repo-a', slug: 'repo-a' },
        { path: '/work/repo-b', slug: 'repo-b' },
      ],
    });
    expect(isWorkspaceMismatch(meta, '/work/repo-b')).toBe(false);
    expect(isWorkspaceMismatch(meta, '/work/repo-c')).toBe(true);
  });
});

describe('selectSessionInteractive', () => {
  function writeSession(homeDir: string, sessionId: string, meta: Partial<SessionMeta> & { workspace: string }) {
    const sessionDir = join(homeDir, 'sessions', sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, 'meta.json'),
      JSON.stringify({
        sessionId,
        firstInput: null,
        createdAt: 1000,
        lastActiveAt: 2000,
        ...meta,
      }),
    );
  }

  it('does not ask to switch when the cwd matches a non-startup workspace', async () => {
    const root = tempDir('wayang-select-pick-');
    writeSession(root, 's1', {
      workspace: '/work/repo-a',
      workspaces: [
        { path: '/work/repo-a', slug: 'repo-a' },
        { path: '/work/repo-b', slug: 'repo-b' },
      ],
    });
    vi.mocked(prompts).mockResolvedValue({ selected: 's1' });

    const result = await selectSessionInteractive(root, '/work/repo-b', false);

    expect(result.sessionId).toBe('s1');
    // Selection only: the mismatch confirmation must not fire.
    expect(vi.mocked(prompts)).toHaveBeenCalledTimes(1);
  });

  it('asks to switch when the cwd matches none of the session workspaces', async () => {
    const root = tempDir('wayang-select-mismatch-');
    writeSession(root, 's1', {
      workspace: '/work/repo-a',
      workspaces: [
        { path: '/work/repo-a', slug: 'repo-a' },
        { path: '/work/repo-b', slug: 'repo-b' },
      ],
    });
    vi.mocked(prompts)
      .mockResolvedValueOnce({ selected: 's1' })
      .mockResolvedValueOnce({ confirm: true });

    await selectSessionInteractive(root, '/work/repo-z', true);

    expect(vi.mocked(prompts)).toHaveBeenCalledTimes(2);
    const confirmCall = vi.mocked(prompts).mock.calls[1][0] as { message: string };
    expect(confirmCall.message).toContain('repo-a (+1)');
  });
});
