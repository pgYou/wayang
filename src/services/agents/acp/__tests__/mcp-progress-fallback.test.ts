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

  it('fires exactly once after 120s with the latest complete reply, deduped by reply id', () => {
    tracker.start();
    tracker.addAgentText('first reply', 'm1');
    tracker.noteTurnEnd();
    vi.advanceTimersByTime(PROGRESS_FALLBACK_MS - 1);
    expect(emitted).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(emitted).toEqual(['first reply']);
    vi.advanceTimersByTime(10 * 60_000);
    expect(emitted).toHaveLength(1);
  });

  it('a real update_progress at 119s resets the idle window', () => {
    tracker.start();
    tracker.addAgentText('reply', 'm1');
    tracker.noteTurnEnd();
    vi.advanceTimersByTime(119_000);
    tracker.noteProgress('mcp');
    vi.advanceTimersByTime(1_000);
    expect(emitted).toHaveLength(0);
    tracker.addAgentText('second reply', 'm2');
    tracker.noteTurnEnd();
    vi.advanceTimersByTime(PROGRESS_FALLBACK_MS);
    expect(emitted).toEqual(['second reply']);
  });

  it('a new message and a turn end both reset the timer', () => {
    tracker.start();
    tracker.addAgentText('reply', 'm1');
    vi.advanceTimersByTime(119_000);
    tracker.noteNewMessage(); // seals 'reply', re-arms at t=119s
    tracker.addAgentText('next', 'm2');
    vi.advanceTimersByTime(119_000);
    expect(emitted).toHaveLength(0);
    tracker.noteTurnEnd(); // seals 'next', re-arms at t=238s
    vi.advanceTimersByTime(119_000);
    expect(emitted).toHaveLength(0);
    vi.advanceTimersByTime(1_000);
    expect(emitted).toEqual(['next']);
  });

  it('tool_call seals the reply; chunks after it form a NEW reply', () => {
    tracker.start();
    tracker.addAgentText('part one', 'm1');
    tracker.noteToolCall(); // does not stop the clock
    tracker.addAgentText('part two', 'm1');
    tracker.noteTurnEnd();
    vi.advanceTimersByTime(PROGRESS_FALLBACK_MS);
    expect(emitted).toEqual(['part two']);
  });

  it('caps the reply at 20000 characters with a marker, never a summary', () => {
    tracker.start();
    tracker.addAgentText('z'.repeat(25_000), 'm1');
    tracker.noteTurnEnd();
    vi.advanceTimersByTime(PROGRESS_FALLBACK_MS);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain('…[truncated]');
    expect(emitted[0].startsWith('z'.repeat(MAX_PROGRESS_CHARS))).toBe(true);
    expect(emitted[0].length).toBeLessThan(MAX_PROGRESS_CHARS + 20);
  });

  it('never fires when the run guards are closed (turn end / cancel / abort / agent exit)', () => {
    tracker.start();
    tracker.addAgentText('reply', 'm1');
    tracker.noteTurnEnd();
    allowed = false;
    vi.advanceTimersByTime(10 * 60_000);
    expect(emitted).toHaveLength(0);
  });

  it('stop() (run finally / abort / loop exit) cancels the pending fire', () => {
    tracker.start();
    tracker.addAgentText('reply', 'm1');
    tracker.noteTurnEnd();
    tracker.stop();
    vi.advanceTimersByTime(10 * 60_000);
    expect(emitted).toHaveLength(0);
  });

  it('no complete reply → no report (idle spin)', () => {
    tracker.start();
    vi.advanceTimersByTime(10 * 60_000);
    expect(emitted).toHaveLength(0);
  });
});
