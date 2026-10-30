import { describe, it, expect } from 'vitest';
import { formatContextReport, formatTokenCount, formatFullTokens, CONTEXT_REPORT_MAX_WIDTH } from '@/tui/utils/context-report';
import type { ContextUsage } from '@/types/index';

/** Display width: CJK / full-width code points take two columns. */
function charWidth(cp: number): number {
  if (cp >= 0x1100 && cp <= 0x115f) return 2;
  if (cp >= 0x2e80 && cp <= 0xa4cf) return 2;
  if (cp >= 0xac00 && cp <= 0xd7a3) return 2;
  if (cp >= 0xf900 && cp <= 0xfaff) return 2;
  if (cp >= 0xfe30 && cp <= 0xfe6f) return 2;
  if (cp >= 0xff00 && cp <= 0xff60) return 2;
  if (cp >= 0xffe0 && cp <= 0xffe6) return 2;
  return 1;
}

function stringWidth(s: string): number {
  let width = 0;
  for (const ch of s) width += charWidth(ch.codePointAt(0) ?? 0);
  return width;
}

const makeUsage = (overrides: Partial<ContextUsage> = {}): ContextUsage => ({
  usedTokens: 12_300,
  maxTokens: 100_000,
  ratio: 0.123,
  source: 'usage',
  lastUsage: { inputTokens: 12_100, outputTokens: 340, cachedInputTokens: 8_000 },
  breakdown: {
    systemPrompt: 1_200,
    user: 300,
    assistant: 900,
    toolCalls: 2_400,
    toolResults: 7_500,
    compactSummary: 0,
    total: 12_300,
  },
  ...overrides,
});

describe('formatTokenCount', () => {
  it('should render raw counts, thousands and millions', () => {
    expect(formatTokenCount(340)).toBe('340');
    expect(formatTokenCount(8_000)).toBe('8k');
    expect(formatTokenCount(12_100)).toBe('12.1k');
    expect(formatTokenCount(1_200_000)).toBe('1.2M');
  });
});

describe('formatFullTokens', () => {
  it('should group digits', () => {
    expect(formatFullTokens(100_000)).toBe('100,000');
    expect(formatFullTokens(1_250_000)).toBe('1,250,000');
  });
});

describe('formatContextReport', () => {
  it('should render header, last usage, model limit and the breakdown', () => {
    const lines = formatContextReport(makeUsage());

    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe('Context · 12.3k / 100k (12%) · source=usage');
    expect(lines[1]).toBe('Last step · in 12.1k · out 340 · cached 8k');
    expect(lines[2]).toBe('Model limit · 100,000 tokens');
    expect(lines[3]).toBe('Breakdown');
    expect(lines[4]).toMatch(/^ {2}system prompt +1\.2k +1\.2%$/);
    expect(lines[5]).toMatch(/^ {2}user +300 +0\.3%$/);
    expect(lines[6]).toMatch(/^ {2}assistant +900 +0\.9%$/);
    expect(lines[7]).toMatch(/^ {2}tool calls +2\.4k +2\.4%$/);
    expect(lines[8]).toMatch(/^ {2}tool results +7\.5k +7\.5%$/);
    expect(lines[9]).toMatch(/^ {2}total +12\.3k +12\.3%$/);
  });

  it('should print "no usage yet" and mark the estimate source when usage is absent', () => {
    const lines = formatContextReport(makeUsage({ lastUsage: undefined, source: 'estimate' }));

    expect(lines[0]).toContain('source=estimate');
    expect(lines[1]).toBe('Last step · no usage yet');
    expect(lines.some(line => line.includes('in 12.1k'))).toBe(false);
  });

  it('should list every non-empty group including the compact summary', () => {
    const lines = formatContextReport(makeUsage({
      breakdown: {
        systemPrompt: 1_200,
        user: 300,
        assistant: 900,
        toolCalls: 0,
        toolResults: 0,
        compactSummary: 500,
        total: 2_900,
      },
    }));

    const rows = lines.slice(4);
    expect(rows.some(line => line.includes('tool calls'))).toBe(false);
    expect(rows.some(line => line.includes('tool results'))).toBe(false);
    expect(rows.some(line => line.includes('compact summary'))).toBe(true);
    expect(rows[rows.length - 1]).toMatch(/^ {2}total /);
  });

  it('should omit the breakdown section when the snapshot carries none', () => {
    const usage = makeUsage();
    delete usage.breakdown;

    const lines = formatContextReport(usage);

    expect(lines).toHaveLength(3);
    expect(lines.some(line => line.includes('Breakdown'))).toBe(false);
  });

  it('should handle a missing snapshot', () => {
    expect(formatContextReport(null)).toEqual(['Context · no data yet']);
    expect(formatContextReport(undefined)).toEqual(['Context · no data yet']);
  });

  it('should keep every line within 80 columns, even at large token counts', () => {
    const cases: ContextUsage[] = [
      makeUsage(),
      makeUsage({
        usedTokens: 1_250_000,
        maxTokens: 2_000_000,
        source: 'estimate',
        lastUsage: { inputTokens: 1_249_000, outputTokens: 12_345, cachedInputTokens: 1_000_000 },
        breakdown: {
          systemPrompt: 12_000,
          user: 345_000,
          assistant: 111_000,
          toolCalls: 222_000,
          toolResults: 560_000,
          compactSummary: 100_000,
          total: 1_350_000,
        },
      }),
    ];

    for (const usage of cases) {
      for (const line of formatContextReport(usage)) {
        expect(stringWidth(line)).toBeLessThanOrEqual(CONTEXT_REPORT_MAX_WIDTH);
      }
    }
  });

  it('should never emit undefined/NaN placeholders', () => {
    const lines = formatContextReport(makeUsage({ maxTokens: 0, usedTokens: 0, breakdown: undefined }));
    for (const line of lines) {
      expect(line).not.toMatch(/undefined|NaN/);
    }
  });
});
