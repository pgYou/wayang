/**
 * Worker run wall-time limit (#76) — priority resolution, watchdog, the
 * structured timeout report, and the run-loop integration (a few-hundred-ms
 * budget drives the real terminate path; no 60-minute waits anywhere).
 */

import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskDetail, WorkerConfig } from '@/types/index';
import type { WayangConfig } from '@/types/config';
import { SkillRegistry } from '@/services/skills/registry';
import { createMockCtx } from '@/__tests__/helpers';
import { TURN_LIMITS } from '@/services/agents/acp/turn-attribution';
import { AcpWorkerRun } from '@/services/agents/acp/acp-worker-run';
import type { AcpWorkerEnvView } from '@/services/agents/acp/base-acp-worker';
import type { IWorkerInstance } from '@/types/worker';
import { FakeAgentTransport } from './fake-agent-transport';
import type { AcpTransport } from '@/services/acp/transport';
import type { AcpLaunchConfig } from '@/services/acp/config';
import {
  type GitRunner,
  type VcsSnapshot,
  RunWallWatchdog,
  WALL_WARN_REMAINING_MS,
  buildWallTimeoutReport,
  collectVcsSnapshot,
  formatDuration,
  resolveRunWallLimitMs,
} from '@/services/agents/acp/acp-run-wall';

function makeTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return { id: 't', title: 'T', description: 'D', priority: 'normal', status: 'pending', createdAt: 0, ...overrides };
}

function makeConfig(overrides: Partial<WayangConfig> = {}): WayangConfig {
  return { providers: {}, controller: { provider: 'p' }, worker: { provider: 'p', maxConcurrency: 1 }, ...overrides } as WayangConfig;
}

describe('resolveRunWallLimitMs (#76 priority chain)', () => {
  it('defaults to the 60-minute budget when neither task nor config declares one', () => {
    expect(resolveRunWallLimitMs(makeTask(), makeConfig())).toBe(TURN_LIMITS.MAX_RUN_WALL_MS);
    expect(TURN_LIMITS.MAX_RUN_WALL_MS).toBe(3_600_000);
  });

  it('global workerRunTimeoutMs overrides the default', () => {
    expect(resolveRunWallLimitMs(makeTask(), makeConfig({ workerRunTimeoutMs: 1_800_000 }))).toBe(1_800_000);
  });

  it('the task runTimeoutMs overrides the global config', () => {
    expect(
      resolveRunWallLimitMs(makeTask({ runTimeoutMs: 600_000 }), makeConfig({ workerRunTimeoutMs: 1_800_000 })),
    ).toBe(600_000);
  });

  it('the task runTimeoutMs also wins when only it is set', () => {
    expect(resolveRunWallLimitMs(makeTask({ runTimeoutMs: 600_000 }), makeConfig())).toBe(600_000);
  });
});

describe('formatDuration', () => {
  it('renders seconds, minutes and hours compactly', () => {
    expect(formatDuration(12_000)).toBe('12s');
    expect(formatDuration(65_000)).toBe('1m 5s');
    expect(formatDuration(3_600_000)).toBe('1h 0m');
    expect(formatDuration(5_400_000)).toBe('1h 30m');
  });
});

describe('RunWallWatchdog (#76 warning + expiry)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('warns exactly once when 5 minutes remain, with elapsed and remaining in the text', () => {
    vi.useFakeTimers();
    const onWarn = vi.fn();
    const onExpiry = vi.fn();
    const wd = new RunWallWatchdog({ limitMs: 10 * 60_000, startedAt: Date.now(), onWarn, onExpiry });
    wd.arm();

    vi.advanceTimersByTime(WALL_WARN_REMAINING_MS);
    expect(onWarn).toHaveBeenCalledTimes(1);
    const message = onWarn.mock.calls[0][0] as string;
    expect(message).toContain('running 5m 0s');
    expect(message).toContain('5m 0s remains of its 10m 0s wall-time limit');
    expect(wd.didWarn).toBe(true);

    // Not again later, and no expiry before the limit.
    vi.advanceTimersByTime(60_000);
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onExpiry).not.toHaveBeenCalled();
  });

  it('fires expiry once at the limit and reports isExpired', () => {
    vi.useFakeTimers();
    const onWarn = vi.fn();
    const onExpiry = vi.fn();
    const startedAt = Date.now();
    const wd = new RunWallWatchdog({ limitMs: 120_000, startedAt, onWarn, onExpiry });
    wd.arm();

    expect(wd.isExpired(startedAt + 120_000)).toBe(false); // boundary: at-limit is not past it
    vi.advanceTimersByTime(120_000);
    expect(onExpiry).toHaveBeenCalledTimes(1);
    expect(onWarn).not.toHaveBeenCalled(); // 2-min limit never reaches a 5-min warning
    expect(wd.isExpired()).toBe(true);
  });

  it('never warns when the limit is 5 minutes or less (remaining starts at/below the line)', () => {
    vi.useFakeTimers();
    const onWarn = vi.fn();
    const onExpiry = vi.fn();
    const wd = new RunWallWatchdog({ limitMs: WALL_WARN_REMAINING_MS, startedAt: Date.now(), onWarn, onExpiry });
    wd.arm();
    vi.advanceTimersByTime(WALL_WARN_REMAINING_MS);
    expect(onWarn).not.toHaveBeenCalled();
    expect(onExpiry).toHaveBeenCalledTimes(1);
  });

  it('clear() drops both timers; the direct clock check still works', () => {
    vi.useFakeTimers();
    const onWarn = vi.fn();
    const onExpiry = vi.fn();
    const startedAt = Date.now();
    const wd = new RunWallWatchdog({ limitMs: 60_000, startedAt, onWarn, onExpiry });
    wd.arm();
    wd.clear();
    vi.advanceTimersByTime(120_000);
    expect(onWarn).not.toHaveBeenCalled();
    expect(onExpiry).not.toHaveBeenCalled();
    // Belt and braces: past the limit the loop-side check must still say expired.
    expect(wd.isExpired(startedAt + 60_001)).toBe(true);
  });
});

describe('collectVcsSnapshot (report facts, #76 req 4)', () => {
  it('collects branch/head/uncommitted/unpushed through the runner', async () => {
    const runGit: GitRunner = async (args, cwd) => {
      expect(cwd).toBe('/ws');
      switch (args.join(' ')) {
        case 'rev-parse --is-inside-work-tree': return 'true\n';
        case 'rev-parse --abbrev-ref HEAD': return 'main\n';
        case 'rev-parse --short HEAD': return 'deadbeef\n';
        case 'status --porcelain': return 'M  src/a.ts\n?? notes.txt\n';
        case 'rev-list --count @{upstream}..HEAD': return '2\n';
        default: throw new Error(`unexpected git call: ${args.join(' ')}`);
      }
    };
    await expect(collectVcsSnapshot('/ws', runGit)).resolves.toEqual({
      isRepo: true, branch: 'main', head: 'deadbeef', uncommittedCount: 2, unpushedCount: 2,
    });
  });

  it('marks the workspace non-repo when the work-tree probe fails or says no', async () => {
    const failing: GitRunner = async () => { throw new Error('not a git repository'); };
    await expect(collectVcsSnapshot('/ws', failing)).resolves.toEqual({ isRepo: false });
    const outside: GitRunner = async (args) => (args[1] === '--is-inside-work-tree' ? 'false\n' : 'x');
    await expect(collectVcsSnapshot('/ws', outside)).resolves.toEqual({ isRepo: false });
  });

  it('degrades per-field: empty branch → unknown, failed rev-list → no-upstream', async () => {
    const runGit: GitRunner = async (args) => {
      switch (args.join(' ')) {
        case 'rev-parse --is-inside-work-tree': return 'true\n';
        case 'rev-parse --abbrev-ref HEAD': return '\n';
        case 'rev-parse --short HEAD': return 'deadbeef\n';
        case 'status --porcelain': return '';
        case 'rev-list --count @{upstream}..HEAD': throw new Error('no upstream configured');
        default: throw new Error(`unexpected git call: ${args.join(' ')}`);
      }
    };
    await expect(collectVcsSnapshot('/ws', runGit)).resolves.toEqual({
      isRepo: true, branch: 'unknown', head: 'deadbeef', uncommittedCount: 0, unpushedCount: 'no-upstream',
    });
  });
});

describe('buildWallTimeoutReport (#76 structured fields)', () => {
  const base = {
    startedAt: 1_000_000,
    reportedAt: 1_000_000 + 3_610_000,
    limitMs: 3_600_000,
    workspaceDir: '/ws/project',
  };

  it('contains duration/limit, workspace, branch+HEAD, uncommitted, unpushed, last progress, preservation note', () => {
    const report = buildWallTimeoutReport({
      ...base,
      snapshot: { isRepo: true, branch: 'main', head: 'deadbeef', uncommittedCount: 3, unpushedCount: 0 },
      lastProgress: 'refactoring the parser, tests still red',
    });
    const lines = report.split('\n');
    expect(lines[0]).toBe('Worker run terminated: wall-time limit exceeded.');
    expect(lines).toContain('- Run duration: 1h 0m (limit 1h 0m)');
    expect(lines).toContain('- Workspace: /ws/project');
    expect(lines).toContain('- Branch: main | HEAD: deadbeef');
    expect(lines).toContain('- Uncommitted changes: yes (3)');
    expect(lines).toContain('- Unpushed commits: no');
    expect(lines).toContain('- Unfinished work (last worker progress): refactoring the parser, tests still red');
    expect(lines).toContain('- Note: committed and pushed work is preserved; only the in-flight run was stopped.');
  });

  it('states the no-upstream case instead of a bare boolean', () => {
    const report = buildWallTimeoutReport({
      ...base, snapshot: { isRepo: true, branch: 'main', head: 'deadbeef', unpushedCount: 'no-upstream' }, lastProgress: null,
    });
    expect(report).toContain('- Unpushed commits: unknown (no upstream branch configured)');
    expect(report).toContain('- Unfinished work (last worker progress): (no progress recorded)');
  });

  it('handles a non-repo or unavailable snapshot without dropping the other fields', () => {
    for (const snapshot of [null, { isRepo: false } as VcsSnapshot]) {
      const report = buildWallTimeoutReport({ ...base, snapshot, lastProgress: null });
      expect(report).toContain('wall-time limit exceeded');
      expect(report).toContain('- Branch/HEAD: not a git repository (uncommitted/unpushed state unknown)');
      expect(report).toContain('- Workspace: /ws/project');
    }
  });
});

// --- Run-loop integration: a few-hundred-ms budget drives the real path ---

const skills = new SkillRegistry([]);

class RecordingSignalQueue {
  readonly signals: Array<Record<string, any>> = [];
  enqueue(sig: Record<string, any>): void { this.signals.push(sig); }
}

class TestAcpWorker extends AcpWorkerRun implements IWorkerInstance {
  readonly transport = new FakeAgentTransport();
  private readonly snapshot: VcsSnapshot;

  constructor(snapshot: VcsSnapshot, sessionDir: string, workspaceDir: string) {
    super(
      { type: 'codebuddy', description: 'test acp worker', mcp: { enabled: false, fallbackMs: 40 } } as WorkerConfig,
      sessionDir,
      workspaceDir,
      createMockCtx({ sessionDir, workspaceDir } as any),
      skills,
    );
    this.snapshot = snapshot;
  }

  protected buildLaunch(view: AcpWorkerEnvView): AcpLaunchConfig {
    return { command: view.command ?? 'node', args: view.args ?? [], env: view.env, cwd: view.cwd, timeouts: view.timeouts };
  }
  protected createTransport(_config: AcpLaunchConfig): AcpTransport { return this.transport; }
  /** Deterministic report facts — the real git path is covered by the unit tests above. */
  protected collectReportSnapshot(_workspaceDir: string): Promise<VcsSnapshot | null> {
    return Promise.resolve(this.snapshot);
  }
}

const HANDSHAKE_RESULT = { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] as Array<{ id: string; name: string }> };
const TASK: TaskDetail & { workerId: string } = {
  id: 'task-wall', title: 'Wall limit', description: 'Run until the wall budget ends', priority: 'normal', status: 'pending',
  createdAt: Date.now(), workerId: 'w-wall', executionTurnId: 'turn-wall-1',
};

function respondTo(transport: FakeAgentTransport, index: number, result: unknown): void {
  const request = transport.clientMessages[index] as { id: number | string };
  transport.agentMessage({ jsonrpc: '2.0', id: request.id, result });
}

async function waitForMethod(transport: FakeAgentTransport, method: string, afterCount = 0): Promise<void> {
  for (;;) {
    const found = transport.clientMessages.filter((m) => (m as { method?: string }).method === method).length;
    if (found > afterCount) return;
    await transport.waitForClientOutput(transport.clientOutput.length + 1);
  }
}

async function openFakeSession(worker: TestAcpWorker): Promise<void> {
  const transport = worker.transport;
  await transport.waitForClientOutput(1);
  respondTo(transport, 0, HANDSHAKE_RESULT);
  await transport.waitForClientOutput(2);
  respondTo(transport, 1, { sessionId: 's-1' });
  await transport.waitForClientOutput(3);
}

describe('AcpWorkerRun wall-time integration (#76: short budget, real terminate path)', () => {
  let tempDir: string;
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'acp-run-wall-test-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('terminates at the limit with a structured report and cancels the session', async () => {
    const worker = new TestAcpWorker(
      { isRepo: true, branch: 'main', head: 'deadbeef', uncommittedCount: 2, unpushedCount: 0 },
      tempDir,
      tempDir,
    );
    worker.setSignalContext({
      signalQueue: new RecordingSignalQueue() as any,
      workerId: 'w-wall', taskId: TASK.id, taskTitle: TASK.title,
    });
    const progressMsgs: string[] = [];
    const runPromise = worker.run({ ...TASK, runTimeoutMs: 400 }, {}, (msg) => progressMsgs.push(msg));
    await openFakeSession(worker);

    // One complete text entry → the idle fallback (40ms) reports it once; the
    // run layer's wrapper captures it as the last progress text. A same-id
    // tool_call resend surfaces the call (the first snapshot is held back by
    // the accumulator), which flushes the open text segment as a complete entry.
    worker.transport.agentMessage({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'halfway through the refactor' }, messageId: 'm-1' } } });
    const toolCall = { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Bash', kind: 'other', status: 'in_progress', rawInput: {} };
    worker.transport.agentMessage({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's-1', update: toolCall } });
    worker.transport.agentMessage({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's-1', update: toolCall } });

    // The wall expiry (400ms) must tear the session down via session/cancel.
    await waitForMethod(worker.transport, 'session/cancel');
    const promptIndex = worker.transport.clientMessages.findIndex((m) => (m as { method?: string }).method === 'session/prompt');
    respondTo(worker.transport, promptIndex, { stopReason: 'cancelled' });

    const result = await runPromise;
    expect(result.status).toBe('failed');
    expect(result.error).toContain('wall-time limit exceeded');
    expect(result.error).toContain('- Run duration: ');
    expect(result.error).toContain('(limit 0s)');
    expect(result.error).toContain(`- Workspace: ${tempDir}`);
    expect(result.error).toContain('- Branch: main | HEAD: deadbeef');
    expect(result.error).toContain('- Uncommitted changes: yes (2)');
    expect(result.error).toContain('- Unpushed commits: no');
    expect(result.error).toContain('halfway through the refactor');
    // The pre-expiry progress really went out through the progress channel.
    expect(progressMsgs.some((m) => m.includes('halfway through the refactor'))).toBe(true);
  });
});
