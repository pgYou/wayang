import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { WorkerFactory } from '@/services/worker-factory';
import { ClaudeCodeWorker } from '@/services/agents/claude-code-worker';
import { WorkerAgent } from '@/services/agents/worker-agent';
import type { ProviderConfig, WorkerConfig } from '@/types/index';

// --- Helpers ---

const providerConfig: ProviderConfig = {
  endpoint: 'http://localhost:1234/v1',
  apiKey: 'test-key',
  modelName: 'test-model',
};

const claudeCodeConfig: WorkerConfig = {
  type: 'claude-code',
  description: 'Test claude code worker',
};

function makeDeps(overrides?: { workerConfigs?: Record<string, WorkerConfig> }) {
  const tempDir = mkdtempSync(join(tmpdir(), 'wayang-wf-test-'));
  return {
    workerProvider: providerConfig,
    sessionDir: tempDir,
    workspaceDir: tempDir,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) } as any,
    workerConfigs: overrides?.workerConfigs,
    _tempDir: tempDir,
  };
}

// --- Tests ---

describe('WorkerFactory', () => {
  let factory: WorkerFactory;
  const tempDirs: string[] = [];

  beforeEach(() => {
    factory = new WorkerFactory();
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  function makeAndTrackDeps(overrides?: { workerConfigs?: Record<string, WorkerConfig> }) {
    const deps = makeDeps(overrides);
    tempDirs.push(deps._tempDir);
    return deps;
  }

  describe('create', () => {
    it('should create puppet WorkerAgent for undefined type', () => {
      const deps = makeAndTrackDeps();
      const worker = factory.create(undefined, deps);
      expect(worker).toBeInstanceOf(WorkerAgent);
    });

    it('should create puppet WorkerAgent for "puppet" type', () => {
      const deps = makeAndTrackDeps();
      const worker = factory.create('puppet', deps);
      expect(worker).toBeInstanceOf(WorkerAgent);
    });

    it('should create ClaudeCodeWorker for configured claude-code type', () => {
      const deps = makeAndTrackDeps({
        workerConfigs: { 'claude-code': claudeCodeConfig },
      });
      const worker = factory.create('claude-code', deps);
      expect(worker).toBeInstanceOf(ClaudeCodeWorker);
    });

    it('should throw for unknown worker type', () => {
      const deps = makeAndTrackDeps();
      expect(() => factory.create('unknown', deps)).toThrow('Unknown worker type');
    });

    it('should throw for disabled worker type', () => {
      const deps = makeAndTrackDeps({
        workerConfigs: { 'disabled-worker': { ...claudeCodeConfig, enable: false } },
      });
      expect(() => factory.create('disabled-worker', deps)).toThrow('disabled');
    });

    it('should throw for unsupported config type', () => {
      const deps = makeAndTrackDeps({
        workerConfigs: { 'unsupported': { type: 'http-api', description: 'test' } },
      });
      expect(() => factory.create('unsupported', deps)).toThrow('Unsupported worker type');
    });
  });

  describe('isKnownType', () => {
    it('should return true for puppet', () => {
      expect(factory.isKnownType('puppet')).toBe(true);
    });

    it('should return true for undefined', () => {
      expect(factory.isKnownType(undefined)).toBe(true);
    });

    it('should return true for configured worker', () => {
      expect(factory.isKnownType('claude-code', { 'claude-code': claudeCodeConfig })).toBe(true);
    });

    it('should return false for unknown worker', () => {
      expect(factory.isKnownType('unknown')).toBe(false);
    });
  });
});
