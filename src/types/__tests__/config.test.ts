import { describe, it, expect } from 'vitest';
import { validateConfig, type WayangConfig } from '@/types/config';

/** Fresh minimal valid config per call — no shared mutable fixture. */
function makeConfig(contextWindowTokens?: unknown): WayangConfig {
  return {
    providers: {
      p: {
        endpoint: 'http://localhost',
        apiKey: 'k',
        modelName: 'm',
        ...(contextWindowTokens !== undefined && { contextWindowTokens: contextWindowTokens as number }),
      },
    },
    controller: { provider: 'p' },
    worker: { provider: 'p', maxConcurrency: 1 },
  };
}

describe('validateConfig: contextWindowTokens', () => {
  it('accepts an omitted or positive integer window', () => {
    expect(validateConfig(makeConfig())).toBeNull();
    expect(validateConfig(makeConfig(128_000))).toBeNull();
  });

  it.each([0, -1, 1.5, Number.NaN, '128000'])('rejects %s', (bad) => {
    const err = validateConfig(makeConfig(bad));
    expect(err).toContain('providers.p.contextWindowTokens must be a positive integer');
  });
});
