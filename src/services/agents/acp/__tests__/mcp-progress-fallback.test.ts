/** 120s idle fallback over the latest complete reply (fake timers, no sockets). */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { McpProgressTracker } from '../mcp-progress-fallback';
import { MAX_PROGRESS_CHARS, PROGRESS_FALLBACK_MS } from '../mcp-schemas';

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

  it('fires exactly once after 120s with the latest complete reply, verbatim, never repeating it', () => {
    tracker.start();
    tracker.noteReplySealed('the latest complete reply', { turn: 1, chars: 25 });
    tracker.noteTurnEnd();
    vi.advanceTimersByTime(PROGRESS_FALLBACK_MS - 1);
    expect(emitted).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(emitted).toEqual(['the latest complete reply']);
    // Consumed → never repeated; the window keeps re-arming instead of spinning.
    vi.advanceTimersByTime(10 * 60_000);
    expect(emitted).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('a later complete entry replaces the earlier one — the report is the latest entry, never a join', () => {
    tracker.start();
    // knot's real shape: one reply arrives as several messages and the
    // transcript layer joins them into ONE entry; when tool calls split a
    // turn into several entries, the fallback candidate is the LATEST entry,
    // reported verbatim — never a join of the entries.
    tracker.noteReplySealed('first entry', { turn: 1, chars: 11 });
    tracker.noteReplySealed('second entry', { turn: 1, chars: 23 });
    vi.advanceTimersByTime(PROGRESS_FALLBACK_MS);
    expect(emitted).toEqual(['second entry']);
  });

  it('a real update_progress advances the watermark: the covered entry is not re-announced', () => {
    tracker.start();
    tracker.noteReplySealed('covered by update_progress', { turn: 1, chars: 26 });
    tracker.noteProgress({ turn: 1, chars: 26 });
    vi.advanceTimersByTime(10 * PROGRESS_FALLBACK_MS);
    expect(emitted).toHaveLength(0);
  });

  it('an entry produced AFTER a real report is announced when the window expires', () => {
    tracker.start();
    tracker.noteReplySealed('old reply', { turn: 1, chars: 9 });
    tracker.noteProgress({ turn: 1, chars: 9 });
    tracker.noteReplySealed('fresh reply', { turn: 2, chars: 60 });
    vi.advanceTimersByTime(PROGRESS_FALLBACK_MS);
    expect(emitted).toEqual(['fresh reply']);
  });

  it('a real update_progress one window-minus-1s in resets the idle window', () => {
    tracker.start();
    tracker.noteReplySealed('reply', { turn: 1, chars: 5 });
    vi.advanceTimersByTime(PROGRESS_FALLBACK_MS - 1_000);
    tracker.noteProgress({ turn: 1, chars: 5 });
    vi.advanceTimersByTime(1_000);
    expect(emitted).toHaveLength(0);
    tracker.noteReplySealed('second reply', { turn: 1, chars: 17 });
    vi.advanceTimersByTime(PROGRESS_FALLBACK_MS);
    expect(emitted).toEqual(['second reply']);
  });

  it('an open message (no complete entry yet) is never a candidate', () => {
    tracker.start();
    tracker.noteReplySealed('old reply', { turn: 1, chars: 9 });
    tracker.noteProgress({ turn: 1, chars: 9 });
    // Chunks of the next message are still open — the transcript layer has
    // not written an entry, so nothing is sealed, nothing to say.
    tracker.noteNewMessage();
    vi.advanceTimersByTime(10 * PROGRESS_FALLBACK_MS);
    expect(emitted).toHaveLength(0);
  });

  it('a new prompt and a turn end both reset the timer without emitting', () => {
    tracker.start();
    tracker.noteReplySealed('reply', { turn: 1, chars: 5 });
    const step = PROGRESS_FALLBACK_MS - 1_000;
    vi.advanceTimersByTime(step);
    tracker.noteNewMessage(); // re-arms one window-minus-1s in
    tracker.noteReplySealed('next', { turn: 2, chars: 4 });
    vi.advanceTimersByTime(step);
    expect(emitted).toHaveLength(0);
    tracker.noteTurnEnd(); // re-arms again
    vi.advanceTimersByTime(step);
    expect(emitted).toHaveLength(0);
    vi.advanceTimersByTime(1_000);
    expect(emitted).toEqual(['next']);
  });

  it('a fallback report advances the watermark: later windows report only later entries', () => {
    tracker.start();
    tracker.noteReplySealed('entry one', { turn: 1, chars: 9 });
    vi.advanceTimersByTime(PROGRESS_FALLBACK_MS);
    expect(emitted).toEqual(['entry one']);
    // A new turn, then a later entry — only the later entry is reported.
    tracker.noteNewMessage();
    tracker.noteReplySealed('entry two', { turn: 2, chars: 9 });
    vi.advanceTimersByTime(PROGRESS_FALLBACK_MS);
    expect(emitted).toEqual(['entry one', 'entry two']);
  });

  it('no complete entry → nothing is reported and the window re-arms', () => {
    tracker.start();
    vi.advanceTimersByTime(10 * 60_000);
    expect(emitted).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('long text is capped at MAX_PROGRESS_CHARS (cap only — never a summary)', () => {
    tracker.start();
    const long = 'A'.repeat(MAX_PROGRESS_CHARS + 500);
    tracker.noteReplySealed(long, { turn: 1, chars: long.length });
    vi.advanceTimersByTime(PROGRESS_FALLBACK_MS);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toBe(`${'A'.repeat(MAX_PROGRESS_CHARS)}\n…[truncated]`);
  });

  it('never fires when the run guards are closed (turn end / cancel / abort / agent exit)', () => {
    tracker.start();
    tracker.noteReplySealed('reply', { turn: 1, chars: 5 });
    tracker.noteTurnEnd();
    allowed = false;
    vi.advanceTimersByTime(10 * 60_000);
    expect(emitted).toHaveLength(0);
  });

  it('stop() (run finally / abort / loop exit) cancels the pending fire', () => {
    tracker.start();
    tracker.noteReplySealed('reply', { turn: 1, chars: 5 });
    tracker.noteTurnEnd();
    tracker.stop();
    vi.advanceTimersByTime(10 * 60_000);
    expect(emitted).toHaveLength(0);
  });

  it('flush() reports the latest unreported entry immediately, once (turn end, degraded)', () => {
    tracker.start();
    tracker.noteReplySealed('you are done', { turn: 1, chars: 12 });
    expect(tracker.flush()).toBe(true);
    expect(emitted).toEqual(['you are done']);
    // Consumed → a second flush is a no-op, the window restarts.
    expect(tracker.flush()).toBe(false);
    expect(emitted).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('flush() respects the watermark: text already covered by update_progress is not repeated', () => {
    tracker.start();
    tracker.noteReplySealed('stale text', { turn: 1, chars: 10 });
    tracker.noteProgress({ turn: 1, chars: 10 });
    expect(tracker.flush()).toBe(false);
    expect(emitted).toHaveLength(0);
  });
});
