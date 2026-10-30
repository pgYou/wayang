import { describe, it, expect } from 'vitest';
import {
  formatContextUsage,
  contextUsageColor,
  buildStatusSegments,
  CONTEXT_SEGMENT_MAX_WIDTH,
} from '@/tui/components/status-bar';
import { theme } from '@/tui/theme';
import type { ContextUsage } from '@/types/index';

const makeUsage = (usedTokens: number, maxTokens = 100_000): ContextUsage => ({
  usedTokens,
  maxTokens,
  ratio: maxTokens > 0 ? usedTokens / maxTokens : 0,
  source: 'usage',
});

describe('formatContextUsage', () => {
  it('should keep raw values below 1k', () => {
    expect(formatContextUsage(999, 100_000)).toBe('ctx 999/100k (1%)');
    expect(formatContextUsage(0, 100_000)).toBe('ctx 0/100k (0%)');
  });

  it('should abbreviate with k (1 decimal) below 1M', () => {
    expect(formatContextUsage(12_300, 100_000)).toBe('ctx 12.3k/100k (12%)');
    expect(formatContextUsage(1_230, 100_000)).toBe('ctx 1.2k/100k (1%)');
  });

  it('should strip a trailing .0 from the abbreviation', () => {
    expect(formatContextUsage(100_000, 100_000)).toBe('ctx 100k/100k (100%)');
  });

  it('should abbreviate with M at 1M and above', () => {
    expect(formatContextUsage(1_234_567, 2_000_000)).toBe('ctx 1.2M/2M (62%)');
  });

  it('should round the percent to integer without clamping to 100', () => {
    expect(formatContextUsage(125_000, 100_000)).toBe('ctx 125k/100k (125%)');
    expect(formatContextUsage(12_300, 100_000)).toBe('ctx 12.3k/100k (12%)');
  });

  it('should cap the segment at CONTEXT_SEGMENT_MAX_WIDTH', () => {
    const samples: Array<[number, number]> = [
      [999, 100_000],
      [12_345, 100_000],
      [999_999, 999_999],
      [105_400, 100_000],
      [12_345_678, 999_999],
      [0, 0],
    ];
    for (const [used, max] of samples) {
      expect(formatContextUsage(used, max).length)
        .toBeLessThanOrEqual(CONTEXT_SEGMENT_MAX_WIDTH);
    }
  });
});

describe('contextUsageColor', () => {
  it('should use error at ratio >= 0.9', () => {
    expect(contextUsageColor(0.9)).toBe(theme.baseToken.color.error);
    expect(contextUsageColor(1.25)).toBe(theme.baseToken.color.error);
  });

  it('should use warning at 0.7 <= ratio < 0.9', () => {
    expect(contextUsageColor(0.7)).toBe(theme.baseToken.color.warning);
    expect(contextUsageColor(0.89)).toBe(theme.baseToken.color.warning);
  });

  it('should stay default below 0.7', () => {
    expect(contextUsageColor(0.69)).toBeUndefined();
    expect(contextUsageColor(0)).toBeUndefined();
  });
});

describe('buildStatusSegments', () => {
  it('should render idle plus the context segment when there are no tasks', () => {
    const seg = buildStatusSegments({
      pendingCount: 0,
      activeCount: 0,
      workerLabels: [],
      contextUsage: makeUsage(12_300),
    });
    expect(seg.countsText).toBe('idle');
    expect(seg.contextText).toBe('ctx 12.3k/100k (12%)');
    expect(seg.workerTexts).toEqual([]);
  });

  it('should always produce a counts segment even without context data', () => {
    const seg = buildStatusSegments({
      pendingCount: 0,
      activeCount: 0,
      workerLabels: [],
      contextUsage: null,
    });
    expect(seg.countsText).toBe('idle');
    expect(seg.contextText).toBe('');
  });

  it('should keep the pending/active labels when tasks exist', () => {
    const seg = buildStatusSegments({
      pendingCount: 2,
      activeCount: 1,
      workerLabels: [],
      contextUsage: null,
    });
    expect(seg.countsText).toBe('pending tasks:2 │ active workers:1');
    expect(seg.contextText).toBe('');
  });

  it('should keep the context segment complete and truncate workers on narrow terminals', () => {
    const seg = buildStatusSegments({
      pendingCount: 1,
      activeCount: 2,
      workerLabels: [
        { label: 'a'.repeat(20), elapsed: 123 },
        { label: 'b'.repeat(20), elapsed: 45 },
      ],
      contextUsage: makeUsage(95_000),
      terminalCols: 60,
    });
    expect(seg.contextText).toBe('ctx 95k/100k (95%)');
    expect(seg.contextColor).toBe(theme.baseToken.color.error);
    // Whole line fits: padding(2) + ' counts ' + workers + ' │ context'
    const total = 4 + seg.countsText.length
      + seg.workerTexts.join(' · ').length
      + (seg.contextText.length + 3);
    expect(total).toBeLessThanOrEqual(60);
    // The overflowing worker row is hard-truncated, the rest dropped
    expect(seg.workerTexts).toHaveLength(1);
  });

  it('should keep whole worker rows when the terminal is wide enough', () => {
    const seg = buildStatusSegments({
      pendingCount: 0,
      activeCount: 1,
      workerLabels: [{ label: 'build project', elapsed: 7 }],
      contextUsage: makeUsage(12_300),
      terminalCols: 120,
    });
    expect(seg.workerTexts).toEqual(['build project (7s)']);
    expect(seg.contextText).toBe('ctx 12.3k/100k (12%)');
  });
});
