/**
 * Provider thin-class tests (03 booklet): hook values, the codebuddy `cbc`
 * PATH fallback, user-config overrides, the shared session-new attribution,
 * the fail-fast wording for a missing CLI, and the opencode permission-gate
 * behaviors (#62): the injection-failure reason reaching the task result,
 * inherited-OPENCODE_CONFIG validation (reject unless gate-equivalent), and
 * the gate-file lifecycle (written at launch, removed at run end).
 *
 * Discipline (06 §1): provider-difference assertions live HERE, in each
 * provider's own block; the shared assertions carry no `if provider` fork.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskDetail, WorkerConfig } from '@/types/index';
import { SkillRegistry } from '@/services/skills/registry';
import { createMockCtx, makeTask } from '@/__tests__/helpers';
import { workerDir } from '@/services/agents/worker-state';

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

/** Task fixture for full run() assertions (the missing-CLI / gate-refusal shapes). */
function makeRunTask(id: string): TaskDetail & { workerId: string } {
  return { ...makeTask(`task-${id}`), workerId: `w-${id}` };
}

/** The worker-scoped gate file path of a given worker in a session dir. */
function gatePathOf(sessionDir: string, workerId: string): string {
  return join(workerDir(sessionDir, workerId), 'opencode-acp-gate.json');
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
    const worker = new ExposedCodebuddy(makeProviderConfig('codebuddy'), tempDir, tempDir, createMockCtx() as any, skills);
    expect(worker.launch(BASE_VIEW)).toMatchObject({ command: 'codebuddy', args: ['--acp'], cwd: '/tmp/ws' });
  });

  it('falls back to the `cbc` alias when only that is on PATH', () => {
    mockFind.mockImplementation((command) => (command === 'cbc' ? '/usr/local/bin/cbc' : undefined));
    const worker = new ExposedCodebuddy(makeProviderConfig('codebuddy'), tempDir, tempDir, createMockCtx() as any, skills);
    expect(worker.launch(BASE_VIEW).command).toBe('cbc');
    // The alias was chosen by probing BOTH names.
    expect(mockFind).toHaveBeenCalledWith('codebuddy');
    expect(mockFind).toHaveBeenCalledWith('cbc');
  });

  it('a user-configured command/args override always wins', () => {
    mockFind.mockReturnValue('/opt/custom/codebuddy');
    const worker = new ExposedCodebuddy(makeProviderConfig('codebuddy'), tempDir, tempDir, createMockCtx() as any, skills);
    expect(
      worker.launch({ ...BASE_VIEW, command: '/opt/custom/codebuddy', args: ['--acp', '--verbose'] }),
    ).toMatchObject({ command: '/opt/custom/codebuddy', args: ['--acp', '--verbose'] });
  });

  it('stopPolicy: 8000 / 2000 / trustUpdatesAfterCancel true (03 §2.3)', () => {
    const worker = new ExposedCodebuddy(makeProviderConfig('codebuddy'), tempDir, tempDir, createMockCtx() as any, skills);
    expect(worker.policy()).toEqual({ cancelGraceMs: 8_000, sigtermWaitMs: 2_000, trustUpdatesAfterCancel: true });
  });

  it('isReady attributes session/new failures to the login state (03 §2.2)', () => {
    const worker = new ExposedCodebuddy(makeProviderConfig('codebuddy'), tempDir, tempDir, createMockCtx() as any, skills);
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
    expect(timeout.message).toContain('codebuddy');
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
    const worker = new ExposedOpenCode(makeProviderConfig('opencode'), tempDir, tempDir, createMockCtx() as any, skills);
    expect(worker.launch(BASE_VIEW)).toMatchObject({ command: 'opencode', args: ['acp'] });
  });

  // --- Permission gate (measured #25: opencode 2.2.5 defaults are allow-all) ---

  /** Warn messages the mock session logger collected. */
  function warnMessages(ctx: ReturnType<typeof createMockCtx>): string[] {
    return (ctx.logger.warn as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[1] ?? ''));
  }

  it('injects the ask-all permission gate by default: OPENCODE_CONFIG → worker-scoped gate file (stale content overwritten)', () => {
    mockFind.mockReturnValue('/usr/local/bin/opencode');
    const worker = new ExposedOpenCode(makeProviderConfig('opencode'), tempDir, tempDir, createMockCtx() as any, skills);
    const gatePath = gatePathOf(tempDir, worker.id);
    // A stale gate file from an earlier launch must be replaced, not trusted.
    mkdirSync(workerDir(tempDir, worker.id), { recursive: true });
    writeFileSync(gatePath, '{"permissions":[]}', 'utf8');
    const launch = worker.launch(BASE_VIEW);
    expect(launch.env.OPENCODE_CONFIG).toBe(gatePath);
    expect(JSON.parse(readFileSync(gatePath, 'utf8'))).toEqual({
      permissions: [{ action: '*', resource: '*', effect: 'ask' }],
    });
  });

  it('protocol.gatePermissions=false skips the injection and warns once', () => {
    mockFind.mockReturnValue('/usr/local/bin/opencode');
    const ctx = createMockCtx();
    const worker = new ExposedOpenCode(
      makeProviderConfig('opencode', { protocol: { gatePermissions: false } }),
      tempDir,
      tempDir,
      ctx as any,
      skills,
    );
    const launch = worker.launch(BASE_VIEW);
    expect(launch.env.OPENCODE_CONFIG).toBeUndefined();
    expect(existsSync(gatePathOf(tempDir, worker.id))).toBe(false);
    const warns = warnMessages(ctx).filter((m) => m.includes('bypass the wayang permission gate'));
    expect(warns).toHaveLength(1);
  });

  it('keeps a VALIDATED (ask-all) inherited OPENCODE_CONFIG and warns once', () => {
    mockFind.mockReturnValue('/usr/local/bin/opencode');
    const ctx = createMockCtx();
    const worker = new ExposedOpenCode(makeProviderConfig('opencode'), tempDir, tempDir, ctx as any, skills);
    const userConfig = join(tempDir, 'user-ask-all.json');
    writeFileSync(userConfig, JSON.stringify({ permissions: [{ action: '*', resource: '*', effect: 'ask' }] }), 'utf8');
    const launch = worker.launch({ ...BASE_VIEW, env: { ...BASE_VIEW.env, OPENCODE_CONFIG: userConfig } });
    expect(launch.env.OPENCODE_CONFIG).toBe(userConfig);
    expect(existsSync(gatePathOf(tempDir, worker.id))).toBe(false);
    const warns = warnMessages(ctx).filter((m) => m.includes('OPENCODE_CONFIG already set'));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('validated as gate-equivalent');
  });

  it('permissionMode "agent" skips the gate (the agent owns its permissions)', () => {
    mockFind.mockReturnValue('/usr/local/bin/opencode');
    const ctx = createMockCtx();
    const worker = new ExposedOpenCode(
      makeProviderConfig('opencode', { permissionMode: 'agent' }),
      tempDir,
      tempDir,
      ctx as any,
      skills,
    );
    const launch = worker.launch(BASE_VIEW);
    expect(launch.env.OPENCODE_CONFIG).toBeUndefined();
    expect(existsSync(gatePathOf(tempDir, worker.id))).toBe(false);
    expect(warnMessages(ctx).some((m) => m.includes('permission gate not injected'))).toBe(true);
  });

  it('an unwritable gate file fails the run with the injection reason (#62 fail-closed)', async () => {
    mockFind.mockReturnValue('/usr/local/bin/opencode');
    const worker = new OpenCodeAcpWorker(
      makeProviderConfig('opencode'),
      tempDir,
      tempDir,
      createMockCtx({ sessionDir: tempDir, workspaceDir: tempDir } as any),
      skills,
    );
    // A DIRECTORY where the gate file should be → the write fails (EISDIR);
    // the subprocess must never start without its gate.
    mkdirSync(gatePathOf(tempDir, worker.id), { recursive: true });
    const result = await worker.run(makeRunTask('gate-write-fail'), {});
    expect(result.status).toBe('failed');
    expect(result.error).toContain('permission gate injection failed');
    expect(result.error).toContain('opencode-acp-gate.json');
  });

  it('an inherited OPENCODE_CONFIG without ask rules refuses to launch (#62 rejection path)', async () => {
    mockFind.mockReturnValue('/usr/local/bin/opencode');
    const inherited = join(tempDir, 'user-opencode.json');
    writeFileSync(inherited, JSON.stringify({ permissions: [{ action: '*', resource: '*', effect: 'allow' }] }), 'utf8');
    const worker = new OpenCodeAcpWorker(
      makeProviderConfig('opencode', { env: { OPENCODE_CONFIG: inherited } } as Partial<WorkerConfig>),
      tempDir,
      tempDir,
      createMockCtx({ sessionDir: tempDir, workspaceDir: tempDir } as any),
      skills,
    );
    const result = await worker.run(makeRunTask('gate-refuse'), {});
    expect(result.status).toBe('failed');
    expect(result.error).toContain('permission gate refused');
    expect(result.error).toContain('ask-all');
    // Ungated launch refused: no gate file, and the error names the inherited config.
    expect(existsSync(gatePathOf(tempDir, worker.id))).toBe(false);
  });

  it('removes the gate file when the run ends — including the failure path (#62 lifecycle)', async () => {
    mockFind.mockReturnValue(undefined); // preflight fails AFTER buildLaunch wrote the gate
    const worker = new OpenCodeAcpWorker(
      makeProviderConfig('opencode'),
      tempDir,
      tempDir,
      createMockCtx({ sessionDir: tempDir, workspaceDir: tempDir } as any),
      skills,
    );
    const gatePath = gatePathOf(tempDir, worker.id);
    const result = await worker.run(makeRunTask('gate-cleanup'), {});
    // The cli-missing wording proves buildLaunch ran first (the gate file was
    // written); by the time run() settles it must be gone.
    expect(result.status).toBe('failed');
    expect(result.error).toContain('无法启动');
    expect(existsSync(gatePath)).toBe(false);
  });

  it('stopPolicy: 5000 / 2000 / trustUpdatesAfterCancel FALSE (conservative drop)', () => {
    const worker = new ExposedOpenCode(makeProviderConfig('opencode'), tempDir, tempDir, createMockCtx() as any, skills);
    expect(worker.policy()).toEqual({ cancelGraceMs: 5_000, sigtermWaitMs: 2_000, trustUpdatesAfterCancel: false });
  });

  it('a missing CLI fails fast with the generic opencode hint (never silent degradation)', async () => {
    mockFind.mockReturnValue(undefined);
    const worker = new OpenCodeAcpWorker(
      makeProviderConfig('opencode'),
      tempDir,
      tempDir,
      createMockCtx({ sessionDir: tempDir, workspaceDir: tempDir } as any),
      skills,
    );
    const result = await worker.run(makeRunTask('opencode'), {});
    expect(result.status).toBe('failed');
    expect(result.error).toContain('opencode');
    expect(result.error).toContain('https://opencode.ai/docs/acp/');
  });
});
