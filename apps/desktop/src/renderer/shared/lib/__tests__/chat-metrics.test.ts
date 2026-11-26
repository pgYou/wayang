import { describe, it, expect } from 'vitest';
import type { ContextUsage } from '@wayang-ai/protocol';
import { buildTurnDots, contextPercent, formatDuration, formatTokens, shouldFold, TURN_DOT_WINDOW } from '../chat-metrics';

/**
 * 折叠阈值与导航窗口（≤20 圆点）行为符合参数。
 */

const usage = (used: number, window: number): ContextUsage =>
  ({ usedTokens: used, contextWindowTokens: window, contextWindow: 0 }) as unknown as ContextUsage;

describe('contextPercent (上下文圆环)', () => {
  it('computes and clamps the ring percentage', () => {
    expect(contextPercent(usage(25_000, 100_000))).toBe(25);
    expect(contextPercent(usage(0, 100_000))).toBe(0);
    expect(contextPercent(usage(150_000, 100_000))).toBe(100);
    expect(contextPercent(null)).toBeNull();
    expect(contextPercent(usage(10, 0))).toBeNull();
  });

  it('formats compact token labels', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(12_340)).toBe('12.3k');
  });
});

describe('shouldFold (长消息折叠 >300px)', () => {
  it('folds only when the rendered height exceeds the threshold and is not expanded', () => {
    expect(shouldFold(300, false)).toBe(false);
    expect(shouldFold(301, false)).toBe(true);
    expect(shouldFold(640, true)).toBe(false);
    expect(shouldFold(null, false)).toBe(false);
  });
});

describe('formatDuration (思考耗时标签)', () => {
  // 不足 1 分钟只显示秒；满 1 分钟显示 xm ys；非法值按 0 防御。
  it.each([
    [0, '0s'],
    [999, '0s'],
    [3_000, '3s'],
    [59_999, '59s'],
    [60_000, '1m 0s'],
    [65_000, '1m 5s'],
    [125_000, '2m 5s'],
    [3_600_000, '60m 0s'],
    [-5_000, '0s'],
    [Number.NaN, '0s'],
  ])('formats %d ms as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe('buildTurnDots (≤20 圆点滑动窗口)', () => {
  const items = Array.from({ length: 60 }, (_, i) => ({ id: `u-${i}`, preview: `msg ${i}` }));

  it('short histories show every dot', () => {
    const { dots, total } = buildTurnDots(items.slice(0, 12), 3);
    expect(total).toBe(12);
    expect(dots).toHaveLength(12);
    expect(dots[0]).toMatchObject({ id: 'u-0', index: 0 });
  });

  it('long histories cap at the window and slide with the active index', () => {
    const { dots, total } = buildTurnDots(items, 30);
    expect(total).toBe(60);
    expect(dots).toHaveLength(TURN_DOT_WINDOW);
    // Active index 30 with a 20-dot window centered: 21–40.
    expect(dots[0].index).toBe(21);
    expect(dots[dots.length - 1].index).toBe(40);
    // Sliding to the tail keeps the last window reachable.
    const tail = buildTurnDots(items, 59);
    expect(tail.dots[tail.dots.length - 1].index).toBe(59);
    expect(tail.dots[0].index).toBe(40);
    // Active at the head clamps to the first window.
    const head = buildTurnDots(items, 0);
    expect(head.dots[0].index).toBe(0);
  });

  it('null active (fresh load) anchors on the latest turn', () => {
    const { dots } = buildTurnDots(items, null);
    expect(dots[dots.length - 1].index).toBe(59);
  });

  it('empty input yields no dots', () => {
    expect(buildTurnDots([], 0)).toEqual({ dots: [], total: 0 });
  });
});
