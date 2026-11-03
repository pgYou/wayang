import { describe, it, expect } from 'vitest';
import {
  formatWorkspaceSlug,
  formatWorkspaceSummary,
  formatWorkspaceDetail,
} from '@/tui/utils/workspace-display';

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

describe('formatWorkspaceDetail', () => {
  it('renders slug and path together', () => {
    expect(formatWorkspaceDetail({ path: '/repo/wayang', slug: 'wayang' }))
      .toBe('wayang (/repo/wayang)');
  });

  it('falls back to whichever half is present', () => {
    expect(formatWorkspaceDetail({ path: '/repo/wayang' })).toBe('/repo/wayang');
    expect(formatWorkspaceDetail({ slug: 'wayang' })).toBe('wayang');
  });

  it('returns null when there is no identity', () => {
    expect(formatWorkspaceDetail(undefined)).toBeNull();
    expect(formatWorkspaceDetail(null)).toBeNull();
    expect(formatWorkspaceDetail({})).toBeNull();
  });
});
