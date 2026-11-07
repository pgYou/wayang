/**
 * GenericAcpWorker (type 'acp') tests: the launch is a pure pass-through of
 * the workers.<id> row, a missing command fails fast with an explicit error,
 * and stopPolicy is driven by trustUpdatesAfterCancel (default false).
 * Readiness keeps the skeleton default (protocolVersion === 1) — no
 * CLI-specific probing, so it is asserted here to lock that in.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkerConfig } from '@/types/index';
import { SkillRegistry } from '@/services/skills/registry';
import { createMockCtx } from '@/__tests__/helpers';
import { GenericAcpWorker } from '@/services/agents/acp/generic-acp-worker';
import { type AcpReadyContext, type AcpWorkerEnvView } from '@/services/agents/acp/base-acp-worker';
import type { AcpLaunchConfig } from '@/services/acp/config';
import type { AcpHandshake } from '@/services/acp/types';

const skills = new SkillRegistry([]);

/** Expose the protected hooks for direct assertion (same pattern as provider-workers.test.ts). */
class ExposedGeneric extends GenericAcpWorker {
  launch(view: AcpWorkerEnvView): AcpLaunchConfig {
    return this.buildLaunch(view);
  }
  policy() {
    return this.stopPolicy();
  }
  readiness(ctx: AcpReadyContext) {
    return this.isReady(ctx);
  }
}

const BASE_VIEW: AcpWorkerEnvView = {
  env: { PATH: '/usr/bin' },
  timeouts: {
    handshakeMs: 15_000,
    sessionNewMs: 30_000,
    promptMs: 0,
    permissionMs: 300_000,
    cancelGraceMs: 5_000,
    sigtermWaitMs: 2_000,
  },
  cwd: '/tmp/ws',
};

const HANDSHAKE: AcpHandshake = {
  protocolVersion: 1,
  agentCapabilities: { loadSession: false, raw: {} },
  authMethods: [],
};

function makeConfig(extra: Partial<WorkerConfig> = {}): WorkerConfig {
  return { type: 'acp', command: 'my-cli', description: 'generic test', ...extra } as WorkerConfig;
}

describe('GenericAcpWorker (type "acp", config-driven)', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'acp-generic-test-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('buildLaunch passes the configured command/args through, env and cwd untouched', () => {
    const worker = new ExposedGeneric(makeConfig(), tempDir, tempDir, createMockCtx() as any, skills);
    const launch = worker.launch({ ...BASE_VIEW, command: 'my-cli', args: ['acp', '--verbose'] });
    expect(launch).toMatchObject({ command: 'my-cli', args: ['acp', '--verbose'], env: BASE_VIEW.env, cwd: '/tmp/ws' });
    expect(launch.timeouts).toEqual(BASE_VIEW.timeouts);
  });

  it('buildLaunch defaults args to [] when the row declares none', () => {
    const worker = new ExposedGeneric(makeConfig(), tempDir, tempDir, createMockCtx() as any, skills);
    expect(worker.launch({ ...BASE_VIEW, command: 'my-cli', args: undefined }).args).toEqual([]);
  });

  it('buildLaunch fails fast with an explicit error when command is missing', () => {
    const worker = new ExposedGeneric(makeConfig(), tempDir, tempDir, createMockCtx() as any, skills);
    expect(() => worker.launch({ ...BASE_VIEW, command: undefined })).toThrow(/workers\.<id>\.command is required/);
  });

  it('stopPolicy defaults trustUpdatesAfterCancel to false with the neutral grace ladder', () => {
    const worker = new ExposedGeneric(makeConfig(), tempDir, tempDir, createMockCtx() as any, skills);
    expect(worker.policy()).toEqual({ cancelGraceMs: 5_000, sigtermWaitMs: 2_000, trustUpdatesAfterCancel: false });
  });

  it('stopPolicy honors trustUpdatesAfterCancel: true from the config', () => {
    const worker = new ExposedGeneric(makeConfig({ trustUpdatesAfterCancel: true }), tempDir, tempDir, createMockCtx() as any, skills);
    expect(worker.policy()).toEqual({ cancelGraceMs: 5_000, sigtermWaitMs: 2_000, trustUpdatesAfterCancel: true });
  });

  it('isReady keeps the skeleton default: protocolVersion 1 is ready, others are not', () => {
    const worker = new ExposedGeneric(makeConfig(), tempDir, tempDir, createMockCtx() as any, skills);
    expect(worker.readiness({ handshake: HANDSHAKE, phase: 'handshake', stderrTail: [] }).ready).toBe(true);
    expect(
      worker.readiness({ handshake: { ...HANDSHAKE, protocolVersion: 2 }, phase: 'handshake', stderrTail: [] }).ready,
    ).toBe(false);
  });
});
