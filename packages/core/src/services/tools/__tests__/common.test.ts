import { describe, it, expect } from 'vitest';
import { truncate, safeExecute } from '@/services/tools/common';

describe('truncate', () => {
  it('should not truncate short strings', () => {
    expect(truncate('hello')).toBe('hello');
  });

  it('should truncate at 8000 chars', () => {
    const long = 'a'.repeat(9000);
    const result = truncate(long);
    expect(result.length).toBeLessThan(8100);
    expect(result).toContain('...(truncated)');
    expect(result.slice(0, 8000)).toBe('a'.repeat(8000));
  });

  it('should preserve exactly 8000 char strings', () => {
    const exact = 'a'.repeat(8000);
    expect(truncate(exact)).toBe(exact);
  });
});

describe('safeExecute', () => {
  it('should return result from inner function', async () => {
    const fn = safeExecute('test', async ({ x }: { x: number }) => `got ${x}`);
    const result = await fn({ x: 42 });
    expect(result).toBe('got 42');
  });

  it('should catch errors and return [ERROR]', async () => {
    const fn = safeExecute('test', async () => {
      throw new Error('boom');
    });
    const result = await fn({});
    expect(result).toBe('[ERROR] test: boom');
  });

  it('should truncate long results', async () => {
    const fn = safeExecute('test', async () => 'x'.repeat(9000));
    const result = await fn({});
    expect(result).toContain('...(truncated)');
  });

  it('should handle non-Error throws', async () => {
    const fn = safeExecute('test', async () => {
      throw 'string error';
    });
    const result = await fn({});
    expect(result).toContain('[ERROR]');
  });
});
