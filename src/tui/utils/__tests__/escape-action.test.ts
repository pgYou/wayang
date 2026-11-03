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
});
