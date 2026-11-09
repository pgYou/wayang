/** 120s idle fallback over complete replies (fake timers, no sockets). */

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

  it('fires exactly once after 120s with the latest closed message, deduped by key', () => {
    tracker.start();
    tracker.noteMessageSealed('m1', 'first reply', { turn: 1, chars: 11 });
    tracker.noteTurnEnd();
    vi.advanceTimersByTime(PROGRESS_FALLBACK_MS - 1);
    expect(emitted).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(emitted).toEqual(['first reply']);
    // Same key → never repeated; the window keeps re-arming instead of spinning.
    vi.advanceTimersByTime(10 * 60_000);
    expect(emitted).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('a real update_progress at 119s resets the idle window and advances the watermark', () => {
    tracker.start();
    tracker.noteMessageSealed('m1', 'reply', { turn: 1, chars: 5 });
    tracker.noteTurnEnd();
    vi.advanceTimersByTime(119_000);
    tracker.noteProgress({ turn: 1, chars: 5 });
    vi.advanceTimersByTime(1_000);
    expect(emitted).toHaveLength(0);
    tracker.noteMessageSealed('m2', 'second reply', { turn: 1, chars: 17 });
    tracker.noteTurnEnd();
    vi.advanceTimersByTime(PROGRESS_FALLBACK_MS);
    expect(emitted).toEqual(['second reply']);
  });

  it('no new message after a real report → the expired window reports nothing', () => {
    tracker.start();
    tracker.noteMessageSealed('m1', 'already reported by the agent', { turn: 1, chars: 30 });
    tracker.noteProgress({ turn: 1, chars: 30 }); // covered by update_progress
    tracker.noteTurnEnd();
    vi.advanceTimersByTime(10 * PROGRESS_FALLBACK_MS);
    expect(emitted).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('a message produced AFTER a real report is announced when the window expires', () => {
    tracker.start();
    tracker.noteMessageSealed('m1', 'old reply', { turn: 1, chars: 9 });
    tracker.noteProgress({ turn: 1, chars: 9 });
    tracker.noteMessageSealed('m2', 'fresh reply', { turn: 2, chars: 60 });
    tracker.noteTurnEnd();
    vi.advanceTimersByTime(PROGRESS_FALLBACK_MS);
    expect(emitted).toEqual(['fresh reply']);
  });

  it('a half message (chunks without a seal) is never a candidate', () => {
    tracker.start();
    tracker.noteMessageSealed('m1', 'old reply', { turn: 1, chars: 9 });
    tracker.noteProgress({ turn: 1, chars: 9 });
    // Chunks of the next message are still open — nothing sealed, nothing to say.
    tracker.noteNewMessage();
    vi.advanceTimersByTime(10 * PROGRESS_FALLBACK_MS);
    expect(emitted).toHaveLength(0);
  });

  it('a new prompt and a turn end both reset the timer without emitting', () => {
    tracker.start();
    tracker.noteMessageSealed('m1', 'reply', { turn: 1, chars: 5 });
    vi.advanceTimersByTime(119_000);
    tracker.noteNewMessage(); // re-arms at t=119s
    tracker.noteMessageSealed('m2', 'next', { turn: 2, chars: 4 });
    vi.advanceTimersByTime(119_000);
    expect(emitted).toHaveLength(0);
    tracker.noteTurnEnd(); // re-arms at t=238s
    vi.advanceTimersByTime(119_000);
    expect(emitted).toHaveLength(0);
    vi.advanceTimersByTime(1_000);
    expect(emitted).toEqual(['next']);
  });

  it('sealing alone never emits; the latest closed message wins', () => {
    tracker.start();
    tracker.noteMessageSealed('m1', 'part one', { turn: 1, chars: 8 });
    tracker.noteMessageSealed('m2', 'part two', { turn: 1, chars: 16 });
    expect(emitted).toHaveLength(0);
    vi.advanceTimersByTime(PROGRESS_FALLBACK_MS);
    expect(emitted).toEqual(['part two']);
  });

  it('no closed message → nothing is reported and the window re-arms', () => {
    tracker.start();
    vi.advanceTimersByTime(10 * 60_000);
    expect(emitted).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('caps the message at 20000 characters with a marker, never a summary', () => {
    tracker.start();
    tracker.noteMessageSealed('m1', 'z'.repeat(25_000), { turn: 1, chars: 25_000 });
    tracker.noteTurnEnd();
    vi.advanceTimersByTime(PROGRESS_FALLBACK_MS);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain('…[truncated]');
    expect(emitted[0].startsWith('z'.repeat(MAX_PROGRESS_CHARS))).toBe(true);
    expect(emitted[0].length).toBeLessThan(MAX_PROGRESS_CHARS + 20);
  });

  it('never fires when the run guards are closed (turn end / cancel / abort / agent exit)', () => {
    tracker.start();
    tracker.noteMessageSealed('m1', 'reply', { turn: 1, chars: 5 });
    tracker.noteTurnEnd();
    allowed = false;
    vi.advanceTimersByTime(10 * 60_000);
    expect(emitted).toHaveLength(0);
  });

  it('stop() (run finally / abort / loop exit) cancels the pending fire', () => {
    tracker.start();
    tracker.noteMessageSealed('m1', 'reply', { turn: 1, chars: 5 });
    tracker.noteTurnEnd();
    tracker.stop();
    vi.advanceTimersByTime(10 * 60_000);
    expect(emitted).toHaveLength(0);
  });

  it('flush() reports a closed unreported message immediately, once (turn end, degraded)', () => {
    tracker.start();
    tracker.noteMessageSealed('m1', 'you are done', { turn: 1, chars: 12 });
    expect(tracker.flush()).toBe(true);
    expect(emitted).toEqual(['you are done']);
    // Same key and position → a second flush is a no-op, the window restarts.
    expect(tracker.flush()).toBe(false);
    expect(emitted).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('flush() respects the watermark: a message already covered by update_progress is not repeated', () => {
    tracker.start();
    tracker.noteMessageSealed('m1', 'stale text', { turn: 1, chars: 10 });
    tracker.noteProgress({ turn: 1, chars: 10 });
    expect(tracker.flush()).toBe(false);
    expect(emitted).toHaveLength(0);
  });
});
