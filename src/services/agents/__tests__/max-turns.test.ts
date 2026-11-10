import { describe, it, expect, vi } from 'vitest';
import { resolveMaxTurns, MAX_SAFE_TURNS } from '@/services/agents/max-turns';
import { createMockLogger } from '@/__tests__/helpers';

describe('resolveMaxTurns (v0.9.7 unified maxTurns semantics)', () => {
  it('unset (undefined / null) → Infinity, no warn', () => {
    const logger = createMockLogger();
    expect(resolveMaxTurns(undefined, logger)).toBe(Infinity);
    expect(resolveMaxTurns(null, logger)).toBe(Infinity);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('a positive integer within the safe bound → the value itself, no warn', () => {
    const logger = createMockLogger();
    expect(resolveMaxTurns(1, logger)).toBe(1);
    expect(resolveMaxTurns(7, logger)).toBe(7);
    expect(resolveMaxTurns(MAX_SAFE_TURNS, logger)).toBe(MAX_SAFE_TURNS);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('invalid values (non-positive, non-integer, NaN, wrong type) → Infinity with exactly one warn', () => {
    for (const value of [0, -3, 2.5, Number.NaN, '5', {}]) {
      const logger = createMockLogger();
      expect(resolveMaxTurns(value, logger)).toBe(Infinity);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(String(vi.mocked(logger.warn).mock.calls[0][1])).toContain('Invalid maxTurns');
    }
  });

  it('beyond the safe bound → Infinity with one warn (treated as a typo, not a limit)', () => {
    const logger = createMockLogger();
    expect(resolveMaxTurns(MAX_SAFE_TURNS + 1, logger)).toBe(Infinity);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('stays silent when no logger is given', () => {
    expect(resolveMaxTurns(-1)).toBe(Infinity);
    expect(resolveMaxTurns(5)).toBe(5);
  });
});
