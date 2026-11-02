import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ClaudeCodeWorker } from '@/services/agents/claude-code-worker';
import type { WorkerConfig, TaskDetail } from '@/types/index';
import { SkillRegistry } from '@/services/skills/registry';
import { createMockCtx } from '@/__tests__/helpers';

// Empty registry — worker needs it for prompt building.
const skills = new SkillRegistry([]);

// Mock the Claude Agent SDK
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';

const mockQuery = vi.mocked(query);

// --- Helpers ---

const config: WorkerConfig = {
  type: 'claude-code',
  description: 'Test worker',
  maxTurns: 5,
};

const makeTask = (overrides?: Partial<TaskDetail>): TaskDetail & { workerId: string } => ({
  id: 't-1',
  title: 'Test',
  description: 'Write a hello world function',
  priority: 'normal',
  status: 'pending',
  createdAt: Date.now(),
  workerId: 'cw-test',
  ...overrides,
});

async function* asyncYield<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

// SDK message helpers
function makeAssistantMessage(text: string) {
  return {
    type: 'assistant' as const,
    message: {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text }],
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  };
}

function makeSuccessResult(result: string) {
  return {
    type: 'result' as const,
    subtype: 'success' as const,
    result,
    usage: { input_tokens: 200, output_tokens: 100 },
    total_cost_usd: 0.05,
    num_turns: 2,
    duration_ms: 3000,
    errors: [],
  };
}

function makeErrorResult(error: string) {
  return {
    type: 'result' as const,
    subtype: 'error' as const,
    result: '',
    usage: { input_tokens: 100, output_tokens: 20 },
    total_cost_usd: 0.01,
    num_turns: 1,
    duration_ms: 1000,
    errors: [error],
  };
}

// --- Tests ---

describe('ClaudeCodeWorker', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wayang-ccw-test-'));
    mockQuery.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createWorker(cfg: WorkerConfig = config) {
    return new ClaudeCodeWorker(cfg, tempDir, tempDir, createMockCtx({ sessionDir: tempDir, workspaceDir: tempDir } as any), skills);
  }

  it('should have a valid id', () => {
    const worker = createWorker();
    expect(worker.id).toMatch(/^cw-/);
  });

  it('should return state from getState', () => {
    const worker = createWorker();
    expect(worker.getState()).toBeDefined();
  });

  it('should return completed result on success', async () => {
    const messages = [
      makeAssistantMessage('Working on it...'),
      makeSuccessResult('Done! Created hello.py'),
    ];
    mockQuery.mockReturnValue(asyncYield(messages) as any);

    const worker = createWorker();
    const result = await worker.run(makeTask(), {});

    expect(result.status).toBe('completed');
    expect(result.summary).toBe('Done! Created hello.py');
  });

  it('should return failed result on error result', async () => {
    const messages = [makeErrorResult('Command not found')];
    mockQuery.mockReturnValue(asyncYield(messages) as any);

    const worker = createWorker();
    const result = await worker.run(makeTask(), {});

    expect(result.status).toBe('failed');
    expect(result.error).toContain('Command not found');
  });

  it('should return failed when no result received', async () => {
    mockQuery.mockReturnValue(asyncYield([]) as any);

    const worker = createWorker();
    const result = await worker.run(makeTask(), {});

    expect(result.status).toBe('failed');
    expect(result.error).toContain('No result received');
  });

  it('should return failed on query error', async () => {
    mockQuery.mockImplementation(() => {
      throw new Error('SDK connection failed');
    });

    const worker = createWorker();
    const result = await worker.run(makeTask(), {});

    expect(result.status).toBe('failed');
    expect(result.error).toContain('SDK connection failed');
  });

  it('should set up progress debounce mechanism', async () => {
    const onProgress = vi.fn();
    // Result arrives immediately after assistant message — timer is cancelled
    const messages = [
      makeAssistantMessage('Working...'),
      makeSuccessResult('Done'),
    ];
    mockQuery.mockReturnValue(asyncYield(messages) as any);

    const worker = createWorker();
    const result = await worker.run(makeTask(), {}, onProgress);

    // Progress should NOT be called — result cleared the debounce timer
    expect(onProgress).not.toHaveBeenCalled();
    expect(result.status).toBe('completed');
  });

  it('should cancel pending progress when result arrives', async () => {
    const onProgress = vi.fn();
    const messages = [
      makeAssistantMessage('Working...'),
      makeSuccessResult('Done'),
    ];
    mockQuery.mockReturnValue(asyncYield(messages) as any);

    const worker = createWorker();
    // Run but don't advance debounce timer — result arrives first
    const runPromise = worker.run(makeTask(), {}, onProgress);
    const result = await runPromise;

    // Advance timer to confirm progress was NOT called
    await vi.advanceTimersByTimeAsync(600);

    expect(onProgress).not.toHaveBeenCalled();
    expect(result.status).toBe('completed');
  });

  it('should return aborted result when aborted', async () => {
    // Create an async generator that yields slowly
    async function* slowStream() {
      yield makeAssistantMessage('Starting...');
      // Never yields result — simulates long-running
    }
    mockQuery.mockReturnValue(slowStream() as any);

    const worker = createWorker();
    const runPromise = worker.run(makeTask(), {});

    // Abort mid-stream
    worker.abort();
    const result = await runPromise;

    expect(result.status).toBe('failed');
    expect(result.error).toContain('Aborted');
  });

  it('should record usage in state on result', async () => {
    const messages = [makeSuccessResult('Done')];
    mockQuery.mockReturnValue(asyncYield(messages) as any);

    const worker = createWorker();
    await worker.run(makeTask(), {});

    const state = worker.getState();
    const runtime = state.get<any>('runtimeState');
    expect(runtime.usage).toBeDefined();
    expect(runtime.usage.costUsd).toBe(0.05);
    expect(runtime.usage.turns).toBe(2);
  });

  it('should write conversation entries', async () => {
    const messages = [
      makeAssistantMessage('Working...'),
      makeSuccessResult('Done'),
    ];
    mockQuery.mockReturnValue(asyncYield(messages) as any);

    const worker = createWorker();
    await worker.run(makeTask(), {});

    const state = worker.getState();
    const conversation = state.get<any[]>('conversation');
    // user entry + assistant entry + system result entry
    expect(conversation.length).toBeGreaterThanOrEqual(2);
  });

  it('should write the session id (not the worker id) on all conversation entries', async () => {
    const messages = [
      makeAssistantMessage('Working...'),
      makeSuccessResult('Done'),
    ];
    mockQuery.mockReturnValue(asyncYield(messages) as any);

    const worker = createWorker();
    await worker.run(makeTask(), {});

    const conversation = worker.getState().get<any[]>('conversation');
    // user entry + assistant entry + system result entry
    expect(conversation.length).toBeGreaterThanOrEqual(3);
    const types = new Set(conversation.map((e: any) => e.type));
    expect(types.has('user')).toBe(true);
    expect(types.has('assistant')).toBe(true);
    expect(types.has('system')).toBe(true);
    // Mock ctx sessionId is 'test-session' — every entry must carry it
    for (const entry of conversation) {
      expect(entry.sessionId).toBe('test-session');
      expect(entry.sessionId).not.toBe(worker.id);
    }
  });

  it('should record the terminal result with task_result/error subtype, never compact', async () => {
    // Success → task_result
    mockQuery.mockReturnValue(asyncYield([
      makeAssistantMessage('Working...'),
      makeSuccessResult('All done'),
    ]) as any);
    const okWorker = createWorker();
    await okWorker.run(makeTask(), {});
    const okConversation = okWorker.getState().get<any[]>('conversation');
    const okRecord = okConversation.find((e: any) => e.type === 'system');
    expect(okRecord.subtype).toBe('task_result');
    expect(okRecord.content).toBe('All done');
    expect(okRecord.compactMeta).toBeUndefined();

    // Failure → error
    mockQuery.mockReturnValue(asyncYield([makeErrorResult('Boom')]) as any);
    const failWorker = createWorker();
    await failWorker.run(makeTask(), {});
    const failConversation = failWorker.getState().get<any[]>('conversation');
    const failRecord = failConversation.find((e: any) => e.type === 'system');
    expect(failRecord.subtype).toBe('error');
    expect(failRecord.content).toBe('Boom');
  });

  // --- issue #15: hang after result with an AsyncIterable prompt ---

  /** Reject if `promise` does not settle within `ms` (real timers). */
  async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  it('resolves after result even when the SDK stream stays open until prompt done (issue #15)', async () => {
    // The interlock only shows up on real time — the hang is an unresolved promise.
    vi.useRealTimers();

    let pendingPromptNext: Promise<IteratorResult<unknown>> | null = null;

    mockQuery.mockImplementation(((args: any) => {
      const prompt = args.prompt as AsyncIterable<unknown>;
      const iterator = prompt[Symbol.asyncIterator]();

      // Models the real CLI/SDK: the stream yields the turn's messages, then
      // (isSingleUserTurn=false) keeps waiting on stdin for another user
      // message. stdin closes only once the prompt iterable reports done.
      async function* sdkStream() {
        const initial = await iterator.next();
        expect(initial.done).toBe(false);
        // Pull the next user message concurrently, as streamInput does — this
        // parks inside the worker's prompt iterator while the queue is empty.
        pendingPromptNext = iterator.next();
        yield makeAssistantMessage('Working...');
        yield makeSuccessResult('Done! Created hello.ts');
        // Only reachable if the loop consumes past the result message.
        const next = await (pendingPromptNext as Promise<IteratorResult<unknown>>);
        if (!next.done) {
          throw new Error('unexpected extra prompt message');
        }
      }

      return sdkStream();
    }) as any);

    const worker = createWorker();
    const result = await withTimeout(worker.run(makeTask(), {}), 2000, 'run()');

    expect(result.status).toBe('completed');
    expect(result.summary).toBe('Done! Created hello.ts');

    const conversation = worker.getState().get<any[]>('conversation');
    const resultEntry = conversation.find(
      (e: any) => e.type === 'system' && e.subtype === 'task_result',
    );
    expect(resultEntry).toBeDefined();
    expect(resultEntry.content).toBe('Done! Created hello.ts');

    // The parked pull must also have been woken and report done — this is what
    // lets the SDK end input and close the child's stdin.
    const settled = await withTimeout(
      pendingPromptNext as unknown as Promise<IteratorResult<unknown>>,
      1000,
      'parked prompt next()',
    );
    expect(settled.done).toBe(true);
  });

  it('delivers a message that raced in before the result was processed, then ends input once nothing is queued', async () => {
    const worker = createWorker();
    const iterator = (worker as any)
      .buildPromptIterable('do the thing')[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value.message.content).toContain('do the thing');

    // A controller message is still pending when a result lands — the race
    // window just before input closes. It must still get its own turn
    // (issue #15 only forbids parking AFTER the result with nothing queued).
    (worker as any)._messageQueue.push('raced controller message');
    (worker as any)._terminalResult = { status: 'completed', summary: 'done' };

    const second = await withTimeout<IteratorResult<unknown>>(
      iterator.next() as Promise<IteratorResult<unknown>>,
      1000,
      'prompt iterator next()',
    );
    expect(second.done).toBe(false);
    expect(second.value.message.content).toBe('[Controller message] raced controller message');

    // Next pull: result still stands, queue empty → done (closes the stream,
    // issue #15).
    const third = await withTimeout<IteratorResult<unknown>>(
      iterator.next() as Promise<IteratorResult<unknown>>,
      1000,
      'prompt iterator next() after delivery',
    );
    expect(third.done).toBe(true);
  });

  it('handleResultMessage wakes a prompt iterator parked on the message queue', async () => {
    const worker = createWorker();
    const iterator = (worker as any)
      .buildPromptIterable('go')[Symbol.asyncIterator]();

    await iterator.next(); // initial prompt
    const parked = iterator.next(); // queue empty → parks in _messageResolve

    (worker as any).handleResultMessage(makeSuccessResult('finished'));

    const settled = await withTimeout<IteratorResult<unknown>>(
      parked as Promise<IteratorResult<unknown>>,
      1000,
      'parked prompt next()',
    );
    expect(settled.done).toBe(true);
  });

  it('wires SDK stderr into the logger for diagnostics', async () => {
    let capturedOptions: Record<string, any> | undefined;
    mockQuery.mockImplementation(((args: any) => {
      capturedOptions = args.options;
      return asyncYield([makeSuccessResult('ok')]);
    }) as any);

    const ctx = createMockCtx({ sessionDir: tempDir, workspaceDir: tempDir } as any);
    const worker = new ClaudeCodeWorker(config, tempDir, tempDir, ctx, skills);
    await worker.run(makeTask(), {});

    expect(typeof capturedOptions?.stderr).toBe('function');

    const debug = vi.mocked((ctx.logger as any).debug);
    debug.mockClear();

    capturedOptions!.stderr('  cli exploded \n');
    expect(debug).toHaveBeenCalledTimes(1);
    expect(String(debug.mock.calls[0][1])).toContain('[claude stderr]');
    expect(String(debug.mock.calls[0][1])).toContain('cli exploded');

    // Blank chunks are dropped so the log cannot be flooded.
    capturedOptions!.stderr('   \n');
    expect(debug).toHaveBeenCalledTimes(1);
  });
});
