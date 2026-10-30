import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ClaudeCodeWorker } from '@/services/agents/claude-code-worker';
import type { WorkerConfig, TaskDetail } from '@/types/index';
import { SkillRegistry } from '@/services/skills/registry';
import { SignalQueue } from '@/services/signal/signal-queue';
import { createMockCtx } from '@/__tests__/helpers';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn(() => ({ type: 'instance' })),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
const mockQuery = vi.mocked(query);

const skills = new SkillRegistry([]);
const config: WorkerConfig = { type: 'claude-code', description: 'Test worker' };

const makeTask = (): TaskDetail & { workerId: string } => ({
  id: `t-cc-${Math.random().toString(36).slice(2, 6)}`,
  title: 'Test',
  description: 'Do the thing',
  priority: 'normal',
  status: 'pending',
  createdAt: Date.now(),
  workerId: 'cw-test',
});

function assistant(text: string) {
  return { type: 'assistant' as const, message: { role: 'assistant' as const, content: [{ type: 'text' as const, text }], usage: { input_tokens: 1, output_tokens: 1 } } };
}
function successResult(text: string) {
  return { type: 'result' as const, subtype: 'success' as const, result: text, usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0, num_turns: 1, duration_ms: 1, errors: [] as string[] };
}

/** SDK query mock: yields messages, then parks on a gate we control. */
function gatedStream(messages: unknown[], gateAfter: 'before-result' | 'never') {
  const interrupt = vi.fn(async () => {});
  let releaseGate: (() => void) | null = null;
  const gate = new Promise<void>((r) => { releaseGate = r; });
  const resultMessages = gateAfter === 'before-result'
    ? [...messages, successResult('done')]
    : [...messages];
  const stream = {
    interrupt,
    async *[Symbol.asyncIterator]() {
      for (const m of resultMessages) yield m as never;
      if (gateAfter === 'never') await gate;
    },
  };
  return { stream, interrupt, release: () => releaseGate?.() };
}

async function settle() {
  for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0));
}

let tempDir: string;

describe('ClaudeCodeWorker controller messaging', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(`${tmpdir()}/wayang-cc-`);
    mockQuery.mockReset();
  });
  afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

  function makeWorker(cfg: WorkerConfig = config): ClaudeCodeWorker {
    const ctx = createMockCtx({ sessionDir: tempDir, workspaceDir: tempDir });
    return new ClaudeCodeWorker(cfg, tempDir, tempDir, ctx, skills);
  }

  it('interrupts the active query immediately on acceptMessage (default policy)', async () => {
    const worker = makeWorker();
    const { stream, interrupt, release } = gatedStream([assistant('working')], 'never');
    mockQuery.mockReturnValueOnce(stream as never);
    const runP = worker.run(makeTask(), {});
    await settle();

    worker.acceptMessage('change of plans');
    expect(interrupt).toHaveBeenCalledTimes(1);

    worker.abort();
    release();
    await runP;
  });

  it('defers the interrupt while a permission is pending, then delivers it on resolve', async () => {
    const worker = makeWorker();
    const ctx = createMockCtx({ sessionDir: tempDir, workspaceDir: tempDir });
    const signalQueue = new SignalQueue(ctx);
    worker.setSignalContext({ signalQueue, workerId: 'cw-test', taskId: 't-1', taskTitle: 'Test' });

    const { stream, interrupt, release } = gatedStream([assistant('working')], 'never');
    mockQuery.mockImplementationOnce((({ options }: never) => {
      // fire the captured canUseTool so a permission hangs pending
      Promise.resolve().then(() => (options as any).canUseTool('Bash', { command: 'sudo rm -rf /tmp/x' }));
      return stream;
    }) as never);
    const runP = worker.run(makeTask(), {});
    await settle();

    // A dangerous Bash call is now parked in permissionHandler — a message
    // arriving now must NOT interrupt until the permission settles.
    worker.acceptMessage('hold on');
    expect(interrupt).not.toHaveBeenCalled();

    const signals = signalQueue.query({ type: 'permission_request' });
    expect(signals).toHaveLength(1);
    const requestId = (signals[0].payload as any).requestId;

    worker.permissionHandler.resolvePermission(requestId, true);
    expect(interrupt).toHaveBeenCalledTimes(1);

    worker.abort();
    release();
    await runP;
  });

  it('never interrupts with interruptOnMessage: turn-end', async () => {
    const worker = makeWorker({ ...config, interruptOnMessage: 'turn-end' });
    const { stream, interrupt, release } = gatedStream([assistant('working')], 'never');
    mockQuery.mockReturnValueOnce(stream as never);
    const runP = worker.run(makeTask(), {});
    await settle();

    worker.acceptMessage('patient message');
    expect(interrupt).not.toHaveBeenCalled();

    worker.abort();
    release();
    await runP;
  });

  it('keeps unread messages on completion instead of flushing (engine reports them)', async () => {
    const worker = makeWorker();
    const { stream, release } = gatedStream([assistant('working')], 'before-result');
    mockQuery.mockReturnValueOnce(stream as never);
    const runP = worker.run(makeTask(), {});

    await settle();
    worker.acceptMessage('arrived too late');
    release();
    const result = await runP;

    expect(result.status).toBe('completed');
    expect(worker.pendingMessages()).toEqual(['arrived too late']);
  });

  it('folds idle-period messages into the next stage\'s initial prompt', async () => {
    const worker = makeWorker();
    worker.acceptMessage('from idle period');

    let capturedPrompt: AsyncIterable<any> | null = null;
    const { stream, release } = gatedStream([assistant('working')], 'before-result');
    mockQuery.mockImplementationOnce((({ prompt }: never) => {
      capturedPrompt = prompt;
      return stream;
    }) as never);
    const runP = worker.run(makeTask(), {});

    const iterator = capturedPrompt![Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value.message.content).toContain('Do the thing');
    expect(first.value.message.content).toContain('[Controller message] from idle period');

    release();
    await runP;
  });

  it('passes a raised stream-close timeout so a blocking ask_controller survives', async () => {
    const worker = makeWorker();
    worker.setInquirySupport(async (q) => `[Controller] ${q}`);
    const { stream, release } = gatedStream([assistant('working')], 'before-result');
    let capturedOptions: Record<string, any> | null = null;
    mockQuery.mockImplementationOnce((({ options }: never) => {
      capturedOptions = options;
      return stream;
    }) as never);
    const runP = worker.run(makeTask(), {});

    await settle();
    expect(capturedOptions!.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT).toBe('360000');
    expect(capturedOptions!.mcpServers.wayang).toBeDefined();

    release();
    await runP;
  });
});
