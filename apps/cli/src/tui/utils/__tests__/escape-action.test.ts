import { describe, it, expect } from 'vitest';
import { resolveEscapeAction } from '@/tui/utils/escape-action';

describe('resolveEscapeAction', () => {
  it('dismisses an open overlay first — its hint reads "(esc to dismiss)"', () => {
    expect(resolveEscapeAction({ overlayOpen: true, busy: false })).toBe('dismiss-overlay');
  });

  it('dismisses the overlay even while the controller is busy', () => {
    expect(resolveEscapeAction({ overlayOpen: true, busy: true })).toBe('dismiss-overlay');
  });

  it('aborts the controller when busy and no overlay is open', () => {
    expect(resolveEscapeAction({ overlayOpen: false, busy: true })).toBe('abort');
  });

  it('does nothing when idle and no overlay is open', () => {
    expect(resolveEscapeAction({ overlayOpen: false, busy: false })).toBe('none');
  });

  it('does nothing while the controller is compacting — compaction is not cancellable', () => {
    expect(resolveEscapeAction({ overlayOpen: false, busy: false, compacting: true })).toBe('none');
  });

  it('does not abort a busy controller while it is compacting either', () => {
    expect(resolveEscapeAction({ overlayOpen: false, busy: true, compacting: true })).toBe('none');
  });

  it('still dismisses an overlay while compacting', () => {
    expect(resolveEscapeAction({ overlayOpen: true, busy: true, compacting: true })).toBe('dismiss-overlay');
  });
});
