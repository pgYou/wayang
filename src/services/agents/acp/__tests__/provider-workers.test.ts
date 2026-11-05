/**
 * Provider thin-class tests (03 booklet): hook values, the codebuddy `cbc`
 * PATH fallback, user-config overrides, the shared session-new attribution,
 * and the fail-fast wording for a missing CLI.
 *
 * Discipline (06 §1): provider-difference assertions live HERE, in each
 * provider's own block; the shared assertions carry no `if provider` fork.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskDetail, WorkerConfig } from '@/types/index';
import { SkillRegistry } from '@/services/skills/registry';
import { createMockCtx } from '@/__tests__/helpers';

// findExecutableOnPath reads the real process PATH — mock it so the cbc
// fallback and the fail-fast wording are deterministic on any machine.
vi.mock('@/services/agents/acp/base-acp-worker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/agents/acp/base-acp-worker')>();
  return { ...actual, findExecutableOnPath: vi.fn() };
});

import { findExecutableOnPath, type AcpReadyContext, type AcpWorkerEnvView } from '@/services/agents/acp/base-acp-worker';
import { CodebuddyAcpWorker } from '@/services/agents/acp/codebuddy-acp-worker';
import { OpenCodeAcpWorker } from '@/services/agents/acp/opencode-acp-worker';
import type { AcpLaunchConfig } from '@/services/acp/config';
import type { AcpHandshake } from '@/services/acp/types';
import { AcpError } from '@/services/acp/errors';

const mockFind = vi.mocked(findExecutableOnPath);
const skills = new SkillRegistry([]);

/** Expose the protected hooks for direct assertion. */
class ExposedCodebuddy extends CodebuddyAcpWorker {
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

class ExposedOpenCode extends OpenCodeAcpWorker {
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
    cancelGraceMs: 8_000,
    sigtermWaitMs: 2_000,
  },
  cwd: '/tmp/ws',
};

const HANDSHAKE: AcpHandshake = {
  protocolVersion: 1,
  agentCapabilities: { loadSession: false, raw: {} },
  authMethods: [{ id: 'iOA', name: 'Login with iOA' }],
};

function makeProviderConfig(type: string, extra: Partial<WorkerConfig> = {}): WorkerConfig {
  return { type, description: 'provider test', ...extra } as WorkerConfig;
}

describe('CodebuddyAcpWorker (main path, measured)', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'acp-prov-test-'));
    mockFind.mockReset();
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('defaults to `codebuddy --acp` when the CLI is on PATH', () => {
    mockFind.mockImplementation((command) => (command === 'codebuddy' ? '/usr/local/bin/codebuddy' : undefined));
    const worker = new ExposedCodebuddy(makeProviderConfig('codebuddy-acp'), tempDir, tempDir, createMockCtx() as any, skills);
    expect(worker.launch(BASE_VIEW)).toMatchObject({ command: 'codebuddy', args: ['--acp'], cwd: '/tmp/ws' });
  });

  it('falls back to the `cbc` alias when only that is on PATH', () => {
    mockFind.mockImplementation((command) => (command === 'cbc' ? '/usr/local/bin/cbc' : undefined));
    const worker = new ExposedCodebuddy(makeProviderConfig('codebuddy-acp'), tempDir, tempDir, createMockCtx() as any, skills);
    expect(worker.launch(BASE_VIEW).command).toBe('cbc');
    // The alias was chosen by probing BOTH names.
    expect(mockFind).toHaveBeenCalledWith('codebuddy');
    expect(mockFind).toHaveBeenCalledWith('cbc');
  });

  it('a user-configured command/args override always wins', () => {
    mockFind.mockReturnValue('/opt/custom/codebuddy');
    const worker = new ExposedCodebuddy(makeProviderConfig('codebuddy-acp'), tempDir, tempDir, createMockCtx() as any, skills);
    expect(
      worker.launch({ ...BASE_VIEW, command: '/opt/custom/codebuddy', args: ['--acp', '--verbose'] }),
    ).toMatchObject({ command: '/opt/custom/codebuddy', args: ['--acp', '--verbose'] });
  });

  it('stopPolicy: 8000 / 2000 / trustUpdatesAfterCancel true (03 §2.3)', () => {
    const worker = new ExposedCodebuddy(makeProviderConfig('codebuddy-acp'), tempDir, tempDir, createMockCtx() as any, skills);
    expect(worker.policy()).toEqual({ cancelGraceMs: 8_000, sigtermWaitMs: 2_000, trustUpdatesAfterCancel: true });
  });

  it('isReady attributes session/new failures to the login state (03 §2.2)', () => {
    const worker = new ExposedCodebuddy(makeProviderConfig('codebuddy-acp'), tempDir, tempDir, createMockCtx() as any, skills);
    // Handshake phase: protocolVersion 1 is enough.
    expect(worker.readiness({ handshake: HANDSHAKE, phase: 'handshake', stderrTail: [] })).toEqual({ ready: true });
    // session/new timeout with declared authMethods → auth-required (the
    // protocol layer already classifies this; the hook shapes the message).
    const timeout = worker.readiness({
      handshake: HANDSHAKE,
      phase: 'session-new',
      error: new AcpError('auth-required', 'session/new: no response within 30000ms'),
      stderrTail: [],
    });
    expect(timeout.ready).toBe(false);
    expect(timeout.kind).toBe('auth-required');
    expect(timeout.message).toContain('codebuddy-acp');
    expect(timeout.message).toContain('未登录');
    expect(timeout.message).toContain('Login with iOA');
    // stderr keyword short-circuit: judge on the hit, no timeout wait.
    const stderrHit = worker.readiness({
      handshake: HANDSHAKE,
      phase: 'session-new',
      error: new AcpError('transport-closed', 'closed'),
      stderrTail: ['Error: 401 unauthorized, token expired'],
    });
    expect(stderrHit.kind).toBe('auth-required');
    // Any other failure stays on its original path.
    expect(
      worker.readiness({ handshake: HANDSHAKE, phase: 'session-new', error: new AcpError('agent-error', 'x'), stderrTail: [] }),
    ).toEqual({ ready: true });
  });
});

describe('OpenCodeAcpWorker (experimental, unmeasured)', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'acp-prov-test-'));
    mockFind.mockReset();
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('defaults to `opencode acp` (docs-only, unmeasured)', () => {
    mockFind.mockReturnValue('/usr/local/bin/opencode');
    const worker = new ExposedOpenCode(makeProviderConfig('opencode-acp'), tempDir, tempDir, createMockCtx() as any, skills);
    expect(worker.launch(BASE_VIEW)).toMatchObject({ command: 'opencode', args: ['acp'] });
  });

  it('stopPolicy: 5000 / 2000 / trustUpdatesAfterCancel FALSE (conservative drop)', () => {
    const worker = new ExposedOpenCode(makeProviderConfig('opencode-acp'), tempDir, tempDir, createMockCtx() as any, skills);
    expect(worker.policy()).toEqual({ cancelGraceMs: 5_000, sigtermWaitMs: 2_000, trustUpdatesAfterCancel: false });
  });

  it('a missing CLI fails fast with the generic opencode hint (never silent degradation)', async () => {
    mockFind.mockReturnValue(undefined);
    const worker = new OpenCodeAcpWorker(
      makeProviderConfig('opencode-acp'),
      tempDir,
      tempDir,
      createMockCtx({ sessionDir: tempDir, workspaceDir: tempDir } as any),
      skills,
    );
    const task: TaskDetail & { workerId: string } = {
      id: 'task-opencode',
      title: 'T',
      description: 'do something',
      priority: 'normal',
      status: 'pending',
      createdAt: Date.now(),
      workerId: 'w-opencode',
    };
    const result = await worker.run(task, {});
    expect(result.status).toBe('failed');
    expect(result.error).toContain('opencode');
    expect(result.error).toContain('https://opencode.ai/docs/acp/');
  });
});
