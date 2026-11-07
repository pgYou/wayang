/**
 * C2 wiring tests — the engine seam for `*-acp` workers (issue #25).
 *
 * Dispatch (freeze §7 ①): `createWorker`'s switch returns the provider class
 * for both new types, constructed with the ClaudeCodeWorker signature
 * (config, sessionDir, workspaceDir, ctx, skills). Construction must not
 * spawn — a missing CLI fails fast in run() (C1 preflight), never here.
 *
 * Wiring (freeze §7 ②): ACP workers are driven by optional-member probes —
 * `setSignalContext` receives grants/approvalMemory (04 §3), no inquiry
 * channel is attached (02 §6 `inquiry: false`), and the worker's
 * `permissionHandler` lands in the engine's resolvers so respond_permission
 * reaches it unchanged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskExecuteEngine } from '@/services/task-execute-engine';
import { SignalQueue } from '@/services/signal/signal-queue';
import { createMockCtx, makeTask } from '@/__tests__/helpers';
import { SkillRegistry } from '@/services/skills/registry';
import { CodebuddyAcpWorker } from '@/services/agents/acp/codebuddy-acp-worker';
import { OpenCodeAcpWorker } from '@/services/agents/acp/opencode-acp-worker';
import { GenericAcpWorker } from '@/services/agents/acp/generic-acp-worker';
import type { WorkerConfig, WayangConfig } from '@/types/config';

let tempDir: string;

/** Minimal ACP rows — provider commands omitted on purpose: defaults apply; 'acp' declares its own. */
const acpWorkers: Record<string, WorkerConfig> = {
  codebuddy: { type: 'codebuddy', description: 'Tencent CodeBuddy (ACP)' },
  opencode: { type: 'opencode', description: 'OpenCode (ACP, experimental)' },
  mycli: { type: 'acp', command: 'my-cli', description: 'Generic ACP CLI' },
};

function makeEngine(workers: Record<string, WorkerConfig> = acpWorkers, permission?: WayangConfig['permission']) {
  const ctx = createMockCtx({
    sessionDir: tempDir,
    workspaceDir: tempDir,
    config: { providers: {}, controller: {}, worker: {}, workers, permission } as any,
  });
  const signalQueue = new SignalQueue(ctx);
  const engine = new TaskExecuteEngine(ctx, signalQueue, new SkillRegistry([]));
  return { engine, ctx, signalQueue };
}

describe('createWorker: *-acp dispatch (freeze §7 ①)', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wayang-acp-dispatch-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('constructs a CodebuddyAcpWorker for a codebuddy row (minimal config, mock ctx)', () => {
    const { engine } = makeEngine();
    const worker = (engine as any).createWorker('codebuddy', makeTask('t1'));

    expect(worker).toBeInstanceOf(CodebuddyAcpWorker);
    // ACP skeleton id prefix + the process workspace fallback (no task workspace).
    expect(worker.id).toMatch(/^aw/);
    expect(worker.workspaceDir).toBe(tempDir);
  });

  it('constructs an OpenCodeAcpWorker for an opencode row', () => {
    const { engine } = makeEngine();
    const worker = (engine as any).createWorker('opencode', makeTask('t2'));

    expect(worker).toBeInstanceOf(OpenCodeAcpWorker);
    expect(worker.id).toMatch(/^aw/);
  });

  it('constructs a GenericAcpWorker for an acp row', () => {
    const { engine } = makeEngine();
    const worker = (engine as any).createWorker('mycli', makeTask('t4'));

    expect(worker).toBeInstanceOf(GenericAcpWorker);
    expect(worker).not.toBeInstanceOf(CodebuddyAcpWorker);
    expect(worker.id).toMatch(/^aw/);
  });

  it('still throws for an unconfigured worker id', () => {
    const { engine } = makeEngine();
    expect(() => (engine as any).createWorker('nope', makeTask('t3'))).toThrow('Unknown worker type');
  });
});

describe('wireWorker: ACP capability probes (freeze §7 ②)', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wayang-acp-wiring-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('setSignalContext receives grants + approvalMemory; permissionHandler is registered', () => {
    const { engine, signalQueue } = makeEngine();
    const worker = (engine as any).createWorker('codebuddy', makeTask('w1')) as CodebuddyAcpWorker;
    const spy = vi.spyOn(worker, 'setSignalContext');

    (engine as any).wireWorker(worker, makeTask('w1'), 'eng-w1', 'codebuddy');

    expect(spy).toHaveBeenCalledTimes(1);
    const deps = spy.mock.calls[0][0];
    expect(deps.signalQueue).toBe(signalQueue);
    expect(deps.workerId).toBe('eng-w1');
    expect(deps.taskId).toBe('w1');
    // 04 §3: the engine's task-scoped approval store reaches the worker's
    // own permission path — same instance the puppet middleware gets.
    expect(deps.grants).toBe((engine as any).approvalGrants);
    expect(deps.approvalMemory).toBe('task'); // resolveApprovalMemory default
    // respond_permission reaches the worker's resolver, registered like CCW's.
    expect((engine as any).permissionResolvers.get('eng-w1')).toBe(worker.permissionHandler);
  });

  it('honours permission.approvalMemory: "off" in the wired deps', () => {
    const { engine } = makeEngine(acpWorkers, { approvalMemory: 'off' });
    const worker = (engine as any).createWorker('opencode', makeTask('w2')) as OpenCodeAcpWorker;
    const spy = vi.spyOn(worker, 'setSignalContext');

    (engine as any).wireWorker(worker, makeTask('w2'), 'eng-w2', 'opencode');

    expect(spy.mock.calls[0][0].approvalMemory).toBe('off');
  });

  it('attaches no inquiry channel — ACP workers have none (02 §6)', () => {
    const { engine } = makeEngine();
    const worker = (engine as any).createWorker('codebuddy', makeTask('w3')) as CodebuddyAcpWorker;

    // Precondition: the real skeleton exposes no inquiry member, so the probe
    // must skip it — and wireWorker must not throw trying to call one.
    expect((worker as any).setInquirySupport).toBeUndefined();
    expect(() => (engine as any).wireWorker(worker, makeTask('w3'), 'eng-w3', 'codebuddy')).not.toThrow();
  });

  it('positive control: an inquiry-capable worker still gets both probes', () => {
    const { engine } = makeEngine();
    // ClaudeCodeWorker-shaped stand-in: inquiry + signal context + resolver.
    const fake = {
      id: 'cw-fake',
      workspaceDir: tempDir,
      run: vi.fn(),
      abort: vi.fn(),
      getConversation: () => [],
      getState: () => null,
      acceptMessage: vi.fn(() => true),
      subscribe: () => () => {},
      setInquirySupport: vi.fn(),
      setSignalContext: vi.fn(),
      permissionHandler: { resolvePermission: vi.fn(), cleanup: vi.fn(), wrappedTools: {} },
    };

    (engine as any).wireWorker(fake, makeTask('w4'), 'eng-w4', 'claude-code');

    expect(fake.setInquirySupport).toHaveBeenCalledTimes(1);
    expect(fake.setSignalContext).toHaveBeenCalledTimes(1);
    expect(fake.setSignalContext).toHaveBeenCalledWith(
      expect.objectContaining({
        grants: (engine as any).approvalGrants,
        approvalMemory: 'task',
      }),
    );
    expect((engine as any).permissionResolvers.get('eng-w4')).toBe(fake.permissionHandler);
  });
});
