/**
 * `permission` config-section helpers: the sensitive list, the two mode
 * switches, and the section's validation. The deprecated `deniedDirs` alias
 * is folded into `sensitiveDirs` by the host at its config entry (protocol
 * `normalizeConfig`) — core reads the current key only.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_APPROVAL_MEMORY,
  DEFAULT_SENSITIVE_MODE,
  resolveApprovalMemory,
  resolveSensitiveDirs,
  resolveSensitiveMode,
} from '@/infra/permission/permission-config';
import { validateConfig } from '@wayang-ai/protocol/types/config';
import type { WayangConfig } from '@wayang-ai/protocol/types/config';

describe('resolveSensitiveDirs', () => {
  it('reads sensitiveDirs and dedupes, keeping declaration order', () => {
    expect(resolveSensitiveDirs({ sensitiveDirs: ['vault'] })).toEqual(['vault']);
    expect(resolveSensitiveDirs({ sensitiveDirs: ['a', 'b', 'a'] })).toEqual(['a', 'b']);
  });

  it('drops empty/invalid entries and tolerates a missing section', () => {
    expect(resolveSensitiveDirs(undefined)).toEqual([]);
    expect(resolveSensitiveDirs({})).toEqual([]);
    expect(resolveSensitiveDirs({ sensitiveDirs: ['', 'vault'] })).toEqual(['vault']);
    expect(resolveSensitiveDirs({ sensitiveDirs: [] })).toEqual([]);
  });

  it("reads the current key only — the deprecated alias is the host entry's job", () => {
    // A config that still carries the alias never reaches core (the intake
    // refuses it); the helper itself does not look at it.
    expect(resolveSensitiveDirs({ deniedDirs: ['vault'] } as unknown as WayangConfig['permission'])).toEqual([]);
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

describe('resolveApprovalMemory', () => {
  it("defaults to 'task' and honours the explicit switch", () => {
    expect(DEFAULT_APPROVAL_MEMORY).toBe('task');
    expect(resolveApprovalMemory(undefined)).toBe('task');
    expect(resolveApprovalMemory({})).toBe('task');
    expect(resolveApprovalMemory({ approvalMemory: 'off' })).toBe('off');
    // Independent of the sensitive-list mode: the two switches do not couple.
    expect(resolveApprovalMemory({ sensitiveMode: 'deny' })).toBe('task');
  });
});

describe('validateConfig: permission section', () => {
  function baseConfig(permission: unknown): WayangConfig {
    return {
      providers: { default: { baseURL: 'http://x', apiKey: 'k' } },
      models: { default: { provider: 'default', name: 'm' } },
      controller: { model: 'default' },
      worker: { model: 'default', maxConcurrency: 1 },
      permission,
    } as WayangConfig;
  }

  it('accepts sensitiveDirs / sensitiveMode', () => {
    expect(validateConfig(baseConfig({ sensitiveDirs: ['vault'], sensitiveMode: 'deny' }))).toBeNull();
  });

  it('rejects a non-array sensitiveDirs', () => {
    expect(validateConfig(baseConfig({ sensitiveDirs: 'vault' }))).toContain('permission.sensitiveDirs');
  });

  it('rejects an unknown sensitiveMode', () => {
    expect(validateConfig(baseConfig({ sensitiveMode: 'hard' }))).toContain('permission.sensitiveMode');
  });

  it("accepts approvalMemory: 'task' | 'off'", () => {
    expect(validateConfig(baseConfig({ approvalMemory: 'task' }))).toBeNull();
    expect(validateConfig(baseConfig({ approvalMemory: 'off' }))).toBeNull();
  });

  it('rejects an unknown approvalMemory with a named error', () => {
    const error = validateConfig(baseConfig({ approvalMemory: 'session' }));
    expect(error).toContain('permission.approvalMemory');
    expect(error).toContain("'task' or 'off'");
    expect(error).toContain('session');
  });
});
