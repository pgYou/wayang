/**
 * ESC key routing for the controller page input area.
 *
 * Priority when ESC is pressed with no selection and no suggestion panel:
 * an open overlay wins (its hint literally reads "(esc to dismiss)"), then a
 * busy controller is aborted (ESC stops the current thinking/streaming). ESC
 * never cancels worker tasks — that is /cancel and cancel_task territory.
 */

export type EscapeAction = 'dismiss-overlay' | 'abort' | 'none';

export function resolveEscapeAction(state: { overlayOpen: boolean; busy: boolean }): EscapeAction {
  if (state.overlayOpen) return 'dismiss-overlay';
  if (state.busy) return 'abort';
  return 'none';
}
