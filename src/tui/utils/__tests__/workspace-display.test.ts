import { describe, it, expect } from 'vitest';
import {
  PROJECT_LIST_MAX_WIDTH,
  collectProjectEntries,
  formatProjectList,
  formatTaskWorkspaceMark,
  formatWorkspaceSlug,
  formatWorkspaceSummary,
  isSameWorkspacePath,
  resolveDeclaredWorkspaceSlug,
  resolveWorkspaceSlug,
} from '@/tui/utils/workspace-display';
import { stringWidth } from '@/tui/utils/text-width';

describe('formatWorkspaceSlug', () => {
  it('returns the trimmed slug', () => {
    expect(formatWorkspaceSlug({ path: '/repo/wayang', slug: ' wayang ' })).toBe('wayang');
  });

  it('returns null for a missing, blank, or empty workspace', () => {
    expect(formatWorkspaceSlug(undefined)).toBeNull();
    expect(formatWorkspaceSlug(null)).toBeNull();
    expect(formatWorkspaceSlug({})).toBeNull();
    expect(formatWorkspaceSlug({ slug: '   ' })).toBeNull();
  });
});

describe('formatWorkspaceSummary — first + N', () => {
  it('returns null when there is no workspace to show', () => {
    expect(formatWorkspaceSummary(undefined)).toBeNull();
    expect(formatWorkspaceSummary(null)).toBeNull();
    expect(formatWorkspaceSummary([])).toBeNull();
    expect(formatWorkspaceSummary([{ slug: '  ' }])).toBeNull();
  });

  it('renders a single workspace as its slug', () => {
    expect(formatWorkspaceSummary([{ path: '/repo/a', slug: 'a' }])).toBe('a');
  });

  it('renders a multi-workspace session as the first slug plus the remaining count', () => {
    expect(formatWorkspaceSummary([
      { path: '/repo/a', slug: 'a' },
      { path: '/repo/b', slug: 'b' },
    ])).toBe('a +1');
    expect(formatWorkspaceSummary([
      { path: '/repo/a', slug: 'a' },
      { path: '/repo/b', slug: 'b' },
      { path: '/repo/c', slug: 'c' },
    ])).toBe('a +2');
  });

  it('skips blank slugs when counting the remainder', () => {
    expect(formatWorkspaceSummary([
      { path: '/repo/a', slug: 'a' },
      { path: '/repo/b', slug: '' },
      { path: '/repo/c', slug: 'c' },
    ])).toBe('a +1');
  });
});

describe('isSameWorkspacePath', () => {
  it('treats spelling variants of one directory as the same workspace', () => {
    expect(isSameWorkspacePath('/w/default/', '/w/default')).toBe(true);
    expect(isSameWorkspacePath('/w/sub/../default', '/w/default')).toBe(true);
  });

  it('never matches blank or missing paths', () => {
    expect(isSameWorkspacePath(undefined, '/w/default')).toBe(false);
    expect(isSameWorkspacePath('/w/default', '')).toBe(false);
    expect(isSameWorkspacePath('   ', '   ')).toBe(false);
    expect(isSameWorkspacePath('/w/a', '/w/b')).toBe(false);
  });
});

describe('resolveWorkspaceSlug', () => {
  it('prefers the registry slug', () => {
    expect(resolveWorkspaceSlug({ path: '/w/My Project', slug: 'my-project-2' })).toBe('my-project-2');
  });

  it('falls back to the registry rule applied to the last path segment', () => {
    expect(resolveWorkspaceSlug({ path: '/w/My Project' })).toBe('my-project');
    expect(resolveWorkspaceSlug({ path: '/w/wayang-tui-ws' })).toBe('wayang-tui-ws');
  });

  it('returns null without any identity', () => {
    expect(resolveWorkspaceSlug(undefined)).toBeNull();
    expect(resolveWorkspaceSlug({})).toBeNull();
  });
});

describe('formatTaskWorkspaceMark', () => {
  it('marks a task that left the default workspace', () => {
    expect(formatTaskWorkspaceMark({ path: '/w/other', slug: 'other' }, '/w/default')).toBe(' — other');
  });

  it('marks nothing for the default workspace', () => {
    expect(formatTaskWorkspaceMark({ path: '/w/default', slug: 'default' }, '/w/default')).toBe('');
    expect(formatTaskWorkspaceMark({ path: '/w/default/', slug: 'default' }, '/w/default')).toBe('');
  });

  it('marks nothing without a workspace identity', () => {
    expect(formatTaskWorkspaceMark(undefined, '/w/default')).toBe('');
    expect(formatTaskWorkspaceMark({}, '/w/default')).toBe('');
  });

  it('keeps attribution when the default workspace is unknown', () => {
    expect(formatTaskWorkspaceMark({ path: '/w/impl', slug: 'impl' })).toBe(' — impl');
  });
});

describe('resolveDeclaredWorkspaceSlug', () => {
  it('returns null when the call declared no workspace', () => {
    expect(resolveDeclaredWorkspaceSlug(undefined, { defaultWorkspacePath: '/w/default' })).toBeNull();
    expect(resolveDeclaredWorkspaceSlug('   ', { defaultWorkspacePath: '/w/default' })).toBeNull();
  });

  it('returns null when the declared path is the default workspace', () => {
    expect(resolveDeclaredWorkspaceSlug('/w/default/', { defaultWorkspacePath: '/w/default' })).toBeNull();
  });

  it('resolves the registry slug of a known workspace', () => {
    expect(resolveDeclaredWorkspaceSlug('/w/other', {
      defaultWorkspacePath: '/w/default',
      workspaces: [{ path: '/w/other', slug: 'other-2' }],
    })).toBe('other-2');
  });

  it('falls back to the last path segment when no identity is known', () => {
    expect(resolveDeclaredWorkspaceSlug('/w/Unregistered Project', {
      defaultWorkspacePath: '/w/default',
      workspaces: [],
    })).toBe('unregistered-project');
  });
});

describe('collectProjectEntries', () => {
  it('lists session workspaces with the default first', () => {
    const entries = collectProjectEntries({
      workspaces: [
        { path: '/w/alpha', slug: 'alpha' },
        { path: '/w/default', slug: 'default' },
      ],
      defaultWorkspacePath: '/w/default',
    });

    expect(entries.map(entry => [entry.slug, entry.path, entry.isDefault])).toEqual([
      ['default', '/w/default', true],
      ['alpha', '/w/alpha', false],
    ]);
  });

  it('picks up a workspace the session only knows from its tasks', () => {
    // ctx.workspaces is a bootstrap snapshot: a workspace first used
    // mid-session shows up only on the task it was stamped onto.
    const entries = collectProjectEntries({
      workspaces: [{ path: '/w/default', slug: 'default' }],
      taskWorkspaces: [{ path: '/w/late', slug: 'late' }],
      defaultWorkspacePath: '/w/default',
    });

    expect(entries.map(entry => entry.slug)).toEqual(['default', 'late']);
  });

  it('dedupes the same directory across sources and spelling variants', () => {
    const entries = collectProjectEntries({
      workspaces: [{ path: '/w/default', slug: 'default' }],
      taskWorkspaces: [{ path: '/w/default/', slug: 'default-2' }, { path: '/w/other', slug: 'other' }],
      defaultWorkspacePath: '/w/default',
    });

    expect(entries.map(entry => entry.slug)).toEqual(['default', 'other']);
  });

  it('includes the default workspace even when nothing recorded it', () => {
    const entries = collectProjectEntries({ defaultWorkspacePath: '/w/wayang' });

    expect(entries).toEqual([{ slug: 'wayang', path: '/w/wayang', isDefault: true }]);
  });

  it('returns no entries without any data', () => {
    expect(collectProjectEntries({})).toEqual([]);
  });
});

describe('formatProjectList', () => {
  it('prints "<slug>  <path>" per row, with the default marked', () => {
    const out = formatProjectList({
      workspaces: [
        { path: '/w/alpha', slug: 'alpha' },
        { path: '/w/default', slug: 'default' },
      ],
      defaultWorkspacePath: '/w/default',
    });

    expect(out.split('\n')).toEqual([
      'default  /w/default  *',
      'alpha  /w/alpha',
      '* = default workspace',
    ]);
  });

  it('prints "No projects" when the session knows nothing', () => {
    expect(formatProjectList({})).toBe('No projects');
    expect(formatProjectList({ workspaces: [], taskWorkspaces: [] })).toBe('No projects');
  });

  it('middle-truncates a long path to the column budget, keeping both ends', () => {
    const longPath = '/data/home/lukegypeng/code/very/deeply/nested/projects/wayang-tui-ws';
    const out = formatProjectList({
      workspaces: [{ path: longPath, slug: 'wayang-tui-ws' }],
      defaultWorkspacePath: longPath,
    });
    const row = out.split('\n')[0];

    expect(stringWidth(row)).toBeLessThanOrEqual(PROJECT_LIST_MAX_WIDTH);
    expect(row).toContain('…');
    expect(row.startsWith('wayang-tui-ws  /data/')).toBe(true);
    expect(row.endsWith('wayang-tui-ws  *')).toBe(true);
  });

  it('keeps every row inside the budget for CJK paths at 80 columns', () => {
    const out = formatProjectList({
      workspaces: [
        { path: '/数据/用户/代码/多智能体编排平台/工作区/alpha', slug: 'alpha' },
        { path: '/数据/用户/代码/多智能体编排平台/工作区/beta', slug: 'beta' },
      ],
      defaultWorkspacePath: '/数据/用户/代码/多智能体编排平台/工作区/alpha',
    });

    for (const row of out.split('\n')) {
      expect(stringWidth(row)).toBeLessThanOrEqual(PROJECT_LIST_MAX_WIDTH);
    }
    expect(out.split('\n')[0]).toContain('alpha');
  });
});
