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

/** Same minimal valid config, plus a deliberately loosely-typed permission section. */
function makeConfigWithPermission(permission: unknown): WayangConfig {
  return { ...makeConfig(), permission: permission as WayangConfig['permission'] };
}

describe('validateConfig: permission', () => {
  it('accepts an omitted permission section (existing configs unaffected)', () => {
    expect(validateConfig(makeConfig())).toBeNull();
  });

  it('accepts each field as an array of strings', () => {
    expect(
      validateConfig(
        makeConfigWithPermission({
          allowedDirs: ['/data/shared'],
          autoAllowRoots: ['/tmp'],
          sensitiveDirs: ['/data/keys'],
          // Deprecated alias of sensitiveDirs — still accepted and validated.
          deniedDirs: ['/data/secrets'],
          sensitiveMode: 'deny',
        }),
      ),
    ).toBeNull();
    expect(validateConfig(makeConfigWithPermission({}))).toBeNull();
  });

  it.each([
    ['allowedDirs', '/data/shared'],
    ['autoAllowRoots', 42],
    ['sensitiveDirs', { path: '/data/keys' }],
    ['deniedDirs', { path: '/data/secrets' }],
  ])('rejects %s when it is not an array', (key, value) => {
    const err = validateConfig(makeConfigWithPermission({ [key]: value }));
    expect(err).toContain(`permission.${key} must be an array of strings`);
  });

  it.each(['allowedDirs', 'autoAllowRoots', 'sensitiveDirs', 'deniedDirs'])('rejects %s containing a non-string', (key) => {
    const err = validateConfig(makeConfigWithPermission({ [key]: ['/data/shared', 7] }));
    expect(err).toContain(`permission.${key} must be an array of strings`);
    expect(err).toContain('7');
  });
});
