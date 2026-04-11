import { describe, it, expect } from 'vitest';
import { PUPPET_DEFAULTS, getWorkerMeta } from '@/services/agents/worker-defaults';
import type { WorkerConfig } from '@/types/config';

describe('PUPPET_DEFAULTS', () => {
  it('should have required fields', () => {
    expect(PUPPET_DEFAULTS.label).toBe('puppet');
    expect(PUPPET_DEFAULTS.emoji).toBeTruthy();
    expect(PUPPET_DEFAULTS.description).toBeTruthy();
    expect(PUPPET_DEFAULTS.capabilities.length).toBeGreaterThan(0);
  });
});

describe('getWorkerMeta', () => {
  it('should return puppet defaults for undefined workerType', () => {
    const meta = getWorkerMeta(undefined);
    expect(meta.label).toBe('puppet');
    expect(meta.emoji).toBe(PUPPET_DEFAULTS.emoji);
  });

  it('should return puppet defaults for explicit puppet type', () => {
    const meta = getWorkerMeta('puppet');
    expect(meta.label).toBe('puppet');
    expect(meta.emoji).toBe(PUPPET_DEFAULTS.emoji);
  });

  it('should return configured emoji for a known worker', () => {
    const configs: Record<string, WorkerConfig> = {
      'claude-code': {
        type: 'claude-code',
        emoji: '\u{1F9E0}',
        description: 'Coding assistant',
      },
    };

    const meta = getWorkerMeta('claude-code', configs);
    expect(meta.label).toBe('claude-code');
    expect(meta.emoji).toBe('\u{1F9E0}');
  });

  it('should return fallback emoji for worker without emoji config', () => {
    const configs: Record<string, WorkerConfig> = {
      'basic': {
        type: 'basic',
        description: 'Basic worker',
      },
    };

    const meta = getWorkerMeta('basic', configs);
    expect(meta.label).toBe('basic');
    expect(meta.emoji).toBe('\u{1F916}'); // 🤖 fallback
  });

  it('should return fallback emoji for unknown worker without configs', () => {
    const meta = getWorkerMeta('unknown');
    expect(meta.label).toBe('unknown');
    expect(meta.emoji).toBe('\u{1F916}');
  });
});
