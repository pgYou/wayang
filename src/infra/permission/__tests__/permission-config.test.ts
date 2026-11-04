/**
 * `permission` config-key compatibility: `sensitiveDirs` is the current key,
 * `deniedDirs` is its deprecated alias. The alias must keep protecting exactly
 * what it declares (a config on disk has no migration path, so ignoring the old
 * key would silently drop a user's own protection) — and warn once, not on
 * every permission check.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DEFAULT_SENSITIVE_MODE,
  mergeSensitiveDirs,
  resetDeprecatedPermissionKeysWarning,
  resolveSensitiveMode,
  warnDeprecatedPermissionKeys,
} from '@/infra/permission/permission-config';
import { validateConfig } from '@/types/config';
import type { WayangConfig } from '@/types/config';

beforeEach(() => {
  resetDeprecatedPermissionKeysWarning();
});

describe('mergeSensitiveDirs', () => {
  it('reads sensitiveDirs alone', () => {
    expect(mergeSensitiveDirs({ sensitiveDirs: ['vault'] })).toEqual(['vault']);
  });

  it('reads the deprecated deniedDirs alias alone', () => {
    expect(mergeSensitiveDirs({ deniedDirs: ['vault'] })).toEqual(['vault']);
  });

  it('merges both keys and dedupes, keeping declaration order', () => {
    const merged = mergeSensitiveDirs({ sensitiveDirs: ['a', 'b'], deniedDirs: ['b', 'c', 'a'] });
    expect(merged).toEqual(['a', 'b', 'c']);
  });

  it('drops empty/invalid entries and tolerates a missing section', () => {
    expect(mergeSensitiveDirs(undefined)).toEqual([]);
    expect(mergeSensitiveDirs({})).toEqual([]);
    expect(mergeSensitiveDirs({ sensitiveDirs: ['', 'vault'] })).toEqual(['vault']);
    expect(mergeSensitiveDirs({ deniedDirs: [] })).toEqual([]);
  });
});

describe('resolveSensitiveMode', () => {
  it("defaults to 'ask' and honours the explicit switch", () => {
    expect(DEFAULT_SENSITIVE_MODE).toBe('ask');
    expect(resolveSensitiveMode(undefined)).toBe('ask');
    expect(resolveSensitiveMode({})).toBe('ask');
    expect(resolveSensitiveMode({ sensitiveMode: 'deny' })).toBe('deny');
  });
});

describe('warnDeprecatedPermissionKeys', () => {
  it('does not warn when the legacy key is absent or empty', () => {
    const warn = vi.fn();
    warnDeprecatedPermissionKeys(undefined, warn);
    warnDeprecatedPermissionKeys({ sensitiveDirs: ['vault'] }, warn);
    warnDeprecatedPermissionKeys({ deniedDirs: [] }, warn);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns ONCE per process when deniedDirs is populated, and points at the new key', () => {
    const warn = vi.fn();
    warnDeprecatedPermissionKeys({ deniedDirs: ['vault'] }, warn);
    warnDeprecatedPermissionKeys({ deniedDirs: ['vault'] }, warn);
    warnDeprecatedPermissionKeys({ deniedDirs: ['other'], sensitiveDirs: ['vault'] }, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('deniedDirs');
    expect(warn.mock.calls[0][0]).toContain('sensitiveDirs');
    expect(warn.mock.calls[0][0]).toContain('deprecated');
  });
});

describe('validateConfig: permission section', () => {
  function baseConfig(permission: unknown): WayangConfig {
    return {
      providers: { default: { endpoint: 'http://x', apiKey: 'k', modelName: 'm' } },
      controller: { provider: 'default' },
      worker: { provider: 'default', maxConcurrency: 1 },
      permission,
    } as WayangConfig;
  }

  it('accepts sensitiveDirs / deniedDirs / sensitiveMode', () => {
    expect(
      validateConfig(baseConfig({ sensitiveDirs: ['vault'], deniedDirs: ['legacy'], sensitiveMode: 'deny' })),
    ).toBeNull();
  });

  it('rejects a non-array sensitiveDirs', () => {
    expect(validateConfig(baseConfig({ sensitiveDirs: 'vault' }))).toContain('permission.sensitiveDirs');
  });

  it('rejects a non-array deniedDirs (the alias is validated identically)', () => {
    expect(validateConfig(baseConfig({ deniedDirs: [1] }))).toContain('permission.deniedDirs');
  });

  it('rejects an unknown sensitiveMode', () => {
    expect(validateConfig(baseConfig({ sensitiveMode: 'hard' }))).toContain('permission.sensitiveMode');
  });
});
