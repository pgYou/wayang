import { describe, it, expect } from 'vitest';
import { stringWidth, truncateMiddleToWidth, truncateToWidth } from '@/tui/utils/text-width';

describe('truncateMiddleToWidth', () => {
  it('returns the string untouched when it already fits', () => {
    expect(truncateMiddleToWidth('/data/home/me/code/wayang', 40)).toBe('/data/home/me/code/wayang');
  });

  it('keeps the head and the tail, replacing the middle with one ellipsis', () => {
    const out = truncateMiddleToWidth('/data/home/lukegypeng/code/wayang-tui-ws', 20);

    expect(out).toContain('…');
    expect(out.startsWith('/data/')).toBe(true);
    expect(out.endsWith('tui-ws')).toBe(true);
    expect(out.match(/…/g)).toHaveLength(1);
  });

  it('never exceeds the column budget for ASCII paths', () => {
    const path = '/data/home/lukegypeng/code/some/deeply/nested/project-directory';

    for (let width = 1; width <= stringWidth(path) + 2; width += 1) {
      expect(stringWidth(truncateMiddleToWidth(path, width))).toBeLessThanOrEqual(width);
    }
  });

  it('never exceeds the column budget for CJK paths', () => {
    // Every character is two columns wide, so byte/char counting would overflow.
    const path = '/数据/用户/代码/多智能体编排平台/工作区/wayang';

    for (let width = 1; width <= 60; width += 1) {
      expect(stringWidth(truncateMiddleToWidth(path, width))).toBeLessThanOrEqual(width);
    }
  });

  it('degrades to a bare ellipsis at width 1 and to nothing at width 0', () => {
    expect(truncateMiddleToWidth('/data/home/wayang', 1)).toBe('…');
    expect(truncateMiddleToWidth('/data/home/wayang', 0)).toBe('');
    expect(truncateMiddleToWidth('/data/home/wayang', -3)).toBe('');
  });

  it('stays in one piece when the tail alone would overflow', () => {
    // Head and tail each get half the budget, so neither can eat the other.
    const out = truncateMiddleToWidth('abcdefghij', 5);

    expect(out).toBe('ab…ij');
    expect(stringWidth(out)).toBeLessThanOrEqual(5);
  });

  it('splits the budget evenly for one unbroken token', () => {
    expect(truncateMiddleToWidth('abcdef', 4)).toBe('ab…f');
    expect(truncateMiddleToWidth('abcdef', 5)).toBe('ab…ef');
    expect(stringWidth(truncateMiddleToWidth('abcdef', 5))).toBeLessThanOrEqual(5);
  });

  it('keeps the trailing segment even when the head is a wider CJK run', () => {
    const path = '/数据/用户/代码/wayang-tui-ws';
    const out = truncateMiddleToWidth(path, 16);

    expect(out.endsWith('tui-ws')).toBe(true);
    expect(stringWidth(out)).toBeLessThanOrEqual(16);
    // Sanity check against the forward-only truncation it complements.
    expect(stringWidth(truncateToWidth(path, 16))).toBeLessThanOrEqual(16);
  });
});
