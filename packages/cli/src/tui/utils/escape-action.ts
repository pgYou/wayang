/**
 * ESC key routing for the controller page input area.
 *
 * Priority when ESC is pressed with no selection and no suggestion panel:
 * an open overlay wins (its hint literally reads "(esc to dismiss)"), then a
 * busy controller is aborted (ESC stops the current thinking/streaming). ESC
 * never cancels worker tasks — that is /cancel and cancel_task territory.
 *
 * A compaction is explicitly NOT cancellable: it runs outside a turn, and
 * aborting the summarizer would leave the loop re-triggering the compaction
 * on the next wake (the unread signals resolve waitForSignal immediately).
 * While compacting ESC is a no-op and the status bar says so.
 */

export type EscapeAction = 'dismiss-overlay' | 'abort' | 'none';

export function resolveEscapeAction(state: {
  overlayOpen: boolean;
  busy: boolean;
  /** True while the controller is compacting its context. */
  compacting?: boolean;
}): EscapeAction {
  if (state.overlayOpen) return 'dismiss-overlay';
  if (state.compacting) return 'none';
  if (state.busy) return 'abort';
  return 'none';
}
