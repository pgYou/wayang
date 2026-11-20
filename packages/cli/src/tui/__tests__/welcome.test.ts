import { describe, it, expect } from 'vitest';
import { formatSessionWorkspaceLabel } from '@/tui/welcome';

const workspace = '/repo/wayang';

describe('formatSessionWorkspaceLabel (session banner)', () => {
  it('keeps the full path for a single-workspace session', () => {
    expect(formatSessionWorkspaceLabel(workspace)).toBe(workspace);
    expect(formatSessionWorkspaceLabel(workspace, [{ path: workspace, slug: 'wayang' }]))
      .toBe(workspace);
  });

  it('uses the shared "first + N" expression for a multi-workspace session', () => {
    expect(formatSessionWorkspaceLabel(workspace, [
      { path: workspace, slug: 'wayang' },
      { path: '/repo/other', slug: 'other' },
      { path: '/repo/third', slug: 'third' },
    ])).toBe('wayang +2');
  });

  it('falls back to the path when the workspace list carries no slug', () => {
    expect(formatSessionWorkspaceLabel(workspace, [
      { path: '/repo/a' },
      { path: '/repo/b' },
    ])).toBe(workspace);
  });
});
