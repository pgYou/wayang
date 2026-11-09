/** 120s idle fallback over the turn's joined text (fake timers, no sockets). */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { McpProgressTracker } from '../mcp-progress-fallback';
import { PROGRESS_FALLBACK_MS, PROGRESS_TAIL_CHARS } from '../mcp-schemas';

describe('MCP progress fallback tracker', () => {
  let allowed: boolean;
  let emitted: string[];
  let tracker: McpProgressTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    allowed = true;
    emitted = [];
    tracker = new McpProgressTracker({
      canFire: () => allowed,
      emit: (message) => { emitted.push(message); },
    });
  });

  afterEach(() => {
    tracker.stop();
    vi.useRealTimers();
  });

  it('fires exactly once after 120s with the sealed text, never repeating it', () => {
    tracker.start();
    tracker.noteMessageSealed('first reply', { turn: 1, chars: 11 });
    tracker.noteTurnEnd();
    vi.advanceTimersByTime(PROGRESS_FALLBACK_MS - 1);
    expect(emitted).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(emitted).toEqual(['first reply']);
    // Consumed → never repeated; the window keeps re-arming instead of spinning.
    vi.advanceTimersByTime(10 * 60_000);
    expect(emitted).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('a real update_progress at 119s resets the idle window and advances the watermark', () => {
    tracker.start();
    tracker.noteMessageSealed('reply', { turn: 1, chars: 5 });
    tracker.noteTurnEnd();
    vi.advanceTimersByTime(119_000);
    tracker.noteProgress({ turn: 1, chars: 5 });
    vi.advanceTimersByTime(1_000);
    expect(emitted).toHaveLength(0);
    tracker.noteMessageSealed('second reply', { turn: 1, chars: 17 });
    tracker.noteTurnEnd();
    vi.advanceTimersByTime(PROGRESS_FALLBACK_MS);
    expect(emitted).toEqual(['second reply']);
  });

  it('no new text after a real report → the expired window reports nothing', () => {
    tracker.start();
    tracker.noteMessageSealed('already reported by the agent', { turn: 1, chars: 30 });
    tracker.noteProgress({ turn: 1, chars: 30 }); // covered by update_progress
    tracker.noteTurnEnd();
    vi.advanceTimersByTime(10 * PROGRESS_FALLBACK_MS);
    expect(emitted).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('text produced AFTER a real report is announced when the window expires', () => {
    tracker.start();
    tracker.noteMessageSealed('old reply', { turn: 1, chars: 9 });
    tracker.noteProgress({ turn: 1, chars: 9 });
    tracker.noteMessageSealed('fresh reply', { turn: 2, chars: 60 });
    tracker.noteTurnEnd();
    vi.advanceTimersByTime(PROGRESS_FALLBACK_MS);
    expect(emitted).toEqual(['fresh reply']);
  });

  it('a half message (chunks without a seal) is never a candidate', () => {
    tracker.start();
    tracker.noteMessageSealed('old reply', { turn: 1, chars: 9 });
    tracker.noteProgress({ turn: 1, chars: 9 });
    // Chunks of the next message are still open — nothing sealed, nothing to say.
    tracker.noteNewMessage();
    vi.advanceTimersByTime(10 * PROGRESS_FALLBACK_MS);
    expect(emitted).toHaveLength(0);
  });

  it('a new prompt and a turn end both reset the timer without emitting', () => {
    tracker.start();
    tracker.noteMessageSealed('reply', { turn: 1, chars: 5 });
    vi.advanceTimersByTime(119_000);
    tracker.noteNewMessage(); // re-arms at t=119s
    tracker.noteMessageSealed('next', { turn: 2, chars: 4 });
    vi.advanceTimersByTime(119_000);
    expect(emitted).toHaveLength(0);
    tracker.noteTurnEnd(); // re-arms at t=238s
    vi.advanceTimersByTime(119_000);
    expect(emitted).toHaveLength(0);
    vi.advanceTimersByTime(1_000);
    expect(emitted).toEqual(['replynext']);
  });

  it('sealing alone never emits; a report is every sealed segment joined (knot renews messageId per chunk)', () => {
    tracker.start();
    // knot's measured shape: one reply carved into per-chunk segments. The
    // report must be the joined reply — not the last fragment (#64).
    tracker.noteMessageSealed('空字符', { turn: 1, chars: 3 });
    tracker.noteMessageSealed('串试试。', { turn: 1, chars: 7 });
    tracker.noteMessageSealed('接下来查 workspace。', { turn: 1, chars: 18 });
    expect(emitted).toHaveLength(0);
    vi.advanceTimersByTime(PROGRESS_FALLBACK_MS);
    expect(emitted).toEqual(['空字符串试试。接下来查 workspace。']);
  });

  it('stale segments are dropped, later ones still reported (one window, one real report)', () => {
    tracker.start();
    tracker.noteMessageSealed('covered text', { turn: 1, chars: 12 });
    tracker.noteProgress({ turn: 1, chars: 12 });
    tracker.noteMessageSealed('fresh tail', { turn: 1, chars: 22 });
    vi.advanceTimersByTime(PROGRESS_FALLBACK_MS);
    expect(emitted).toEqual(['fresh tail']);
  });

  it('no sealed segment → nothing is reported and the window re-arms', () => {
    tracker.start();
    vi.advanceTimersByTime(10 * 60_000);
    expect(emitted).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('long joined text keeps the newest PROGRESS_TAIL_CHARS, an ellipsis marking the cut', () => {
    tracker.start();
    const head = 'A'.repeat(PROGRESS_TAIL_CHARS);
    const tail = 'B'.repeat(500);
    tracker.noteMessageSealed(head + tail, { turn: 1, chars: 2_500 });
    tracker.noteTurnEnd();
    vi.advanceTimersByTime(PROGRESS_FALLBACK_MS);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toBe(`…${'A'.repeat(PROGRESS_TAIL_CHARS - 500)}${tail}`);
    expect(emitted[0].length).toBe(PROGRESS_TAIL_CHARS + 1);
  });

  it('never fires when the run guards are closed (turn end / cancel / abort / agent exit)', () => {
    tracker.start();
    tracker.noteMessageSealed('reply', { turn: 1, chars: 5 });
    tracker.noteTurnEnd();
    allowed = false;
    vi.advanceTimersByTime(10 * 60_000);
    expect(emitted).toHaveLength(0);
  });

  it('stop() (run finally / abort / loop exit) cancels the pending fire', () => {
    tracker.start();
    tracker.noteMessageSealed('reply', { turn: 1, chars: 5 });
    tracker.noteTurnEnd();
    tracker.stop();
    vi.advanceTimersByTime(10 * 60_000);
    expect(emitted).toHaveLength(0);
  });

  it('flush() reports the joined unreported text immediately, once (turn end, degraded)', () => {
    tracker.start();
    tracker.noteMessageSealed('you are ', { turn: 1, chars: 8 });
    tracker.noteMessageSealed('done', { turn: 1, chars: 12 });
    expect(tracker.flush()).toBe(true);
    expect(emitted).toEqual(['you are done']);
    // Consumed → a second flush is a no-op, the window restarts.
    expect(tracker.flush()).toBe(false);
    expect(emitted).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('flush() respects the watermark: text already covered by update_progress is not repeated', () => {
    tracker.start();
    tracker.noteMessageSealed('stale text', { turn: 1, chars: 10 });
    tracker.noteProgress({ turn: 1, chars: 10 });
    expect(tracker.flush()).toBe(false);
    expect(emitted).toHaveLength(0);
  });
});
