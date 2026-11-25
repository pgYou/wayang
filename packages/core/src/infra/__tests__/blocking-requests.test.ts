import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BlockingRequestMap } from '@/infra/blocking-requests';

type Resolution = { kind: 'answer'; answer: string } | { kind: 'timeout' } | { kind: 'aborted' };

describe('BlockingRequestMap', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves a wait when answered', async () => {
    const map = new BlockingRequestMap<Resolution>();
    const p = map.wait('inq-1', 60_000, () => ({ kind: 'timeout' }));
    expect(map.size).toBe(1);

    const ok = map.resolve('inq-1', { kind: 'answer', answer: 'yes' });
    expect(ok).toBe(true);
    expect(map.size).toBe(0);
    await expect(p).resolves.toEqual({ kind: 'answer', answer: 'yes' });
  });

  it('resolves with the timeout value (and side effects) after the timeout', async () => {
    const map = new BlockingRequestMap<Resolution>();
    const onTimeout = vi.fn(() => ({ kind: 'timeout' as const }));
    const p = map.wait('inq-2', 5_000, onTimeout);

    vi.advanceTimersByTime(5_000);
    await expect(p).resolves.toEqual({ kind: 'timeout' });
    expect(onTimeout).toHaveBeenCalledTimes(1);
    // Settled: a late resolve must not find it.
    expect(map.resolve('inq-2', { kind: 'answer', answer: 'late' })).toBe(false);
  });

  it('cleanupAll settles every pending request (worker abort)', async () => {
    const map = new BlockingRequestMap<Resolution>();
    const p1 = map.wait('a', 60_000, () => ({ kind: 'timeout' }));
    const p2 = map.wait('b', 60_000, () => ({ kind: 'timeout' }));

    map.cleanupAll(() => ({ kind: 'aborted' }));

    await expect(p1).resolves.toEqual({ kind: 'aborted' });
    await expect(p2).resolves.toEqual({ kind: 'aborted' });
    expect(map.size).toBe(0);
  });

  it('resolve returns false for unknown ids', () => {
    const map = new BlockingRequestMap<Resolution>();
    expect(map.resolve('missing', { kind: 'answer', answer: 'x' })).toBe(false);
  });

  it('rejects a duplicate wait id instead of crossing the map entries', () => {
    const map = new BlockingRequestMap<Resolution>();
    map.wait('dup', 60_000, () => ({ kind: 'timeout' }));
    expect(() => map.wait('dup', 60_000, () => ({ kind: 'timeout' }))).toThrow(/duplicate wait id "dup"/);
  });

  it('removes the entry BEFORE the timeout factory runs (factory sees it gone)', () => {
    const map = new BlockingRequestMap<Resolution>();
    const sizesSeen: number[] = [];
    map.wait('other', 60_000, () => ({ kind: 'timeout' }));
    const p = map.wait('timed', 5_000, () => {
      sizesSeen.push(map.size);
      return { kind: 'timeout' as const };
    });

    vi.advanceTimersByTime(5_000);
    // 'timed' deleted first, 'other' still pending.
    expect(sizesSeen).toEqual([1]);
    return expect(p).resolves.toEqual({ kind: 'timeout' });
  });
});
