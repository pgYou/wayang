import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ClaudeCodeWorker } from '@/services/agents/claude-code-worker';
import type { WorkerConfig, TaskDetail } from '@/types/index';
import { SkillRegistry } from '@/services/skills/registry';
import { readWorkerTranscript, summarizeTranscript } from '@/services/worker-transcript';
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

/** Assistant message with text and/or tool_use blocks (content-block array). */
function makeToolUseMessage(opts: {
  text?: string;
  calls: Array<{ id: string; name: string; input?: unknown }>;
}) {
  const content: Array<Record<string, unknown>> = [];
  if (opts.text !== undefined) content.push({ type: 'text', text: opts.text });
  for (const call of opts.calls) {
    content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input ?? {} });
  }
  return {
    type: 'assistant' as const,
    message: {
      role: 'assistant' as const,
      content,
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  };
}

/** SDK user message carrying tool_result blocks for earlier tool_use ids. */
function makeToolResultUserMessage(
  results: Array<{ toolUseId: string; content?: string | Array<unknown>; isError?: boolean }>,
) {
  return {
    type: 'user' as const,
    message: {
      role: 'user' as const,
      content: results.map((r) => ({
        type: 'tool_result' as const,
        tool_use_id: r.toolUseId,
        ...(r.content !== undefined && { content: r.content }),
        ...(r.isError !== undefined && { is_error: r.isError }),
      })),
    },
    parent_tool_use_id: null,
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

  it('stamps workspaceSlug from the task workspace on conversation entries', async () => {
    mockQuery.mockReturnValue(asyncYield([makeSuccessResult('done')]) as any);

    const worker = createWorker();
    await worker.run(makeTask({ workspace: { path: tempDir, slug: 'cc-task-ws' } }), {});

    const conversation = worker.getConversation();
    expect(conversation.length).toBeGreaterThan(0);
    for (const entry of conversation) {
      expect(entry.workspaceSlug).toBe('cc-task-ws');
    }
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

  it('should not emit a deferred progress after abort', async () => {
    const onProgress = vi.fn();
    let releaseStream!: () => void;
    const streamClosed = new Promise<void>((resolve) => { releaseStream = resolve; });
    async function* parkedStream() {
      yield makeAssistantMessage('Working...');
      // Park until the test aborts — the SDK stream does not end on its own.
      await streamClosed;
    }
    mockQuery.mockReturnValue(parkedStream() as any);

    const worker = createWorker();
    const runPromise = worker.run(makeTask(), {}, onProgress);

    // Let the first message land: it arms the 500ms progress debounce.
    await vi.advanceTimersByTimeAsync(0);
    expect((worker as any)._progressTimer).not.toBeNull();

    worker.abort();
    releaseStream();
    const result = await runPromise;

    // The debounce would have fired by now — the abort must have dropped it.
    await vi.advanceTimersByTimeAsync(600);

    expect(onProgress).not.toHaveBeenCalled();
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

  it('resolves maxTurns like the puppet worker: unset = no SDK cap, valid = value, invalid = unlimited + one warn', async () => {
    const capture = (): { options: Record<string, any> | undefined; ctx: ReturnType<typeof createMockCtx> } => {
      const holder: { options: Record<string, any> | undefined; ctx: ReturnType<typeof createMockCtx> } = {
        options: undefined,
        ctx: createMockCtx({ sessionDir: tempDir, workspaceDir: tempDir } as any),
      };
      mockQuery.mockImplementation(((args: any) => {
        holder.options = args.options;
        return asyncYield([makeSuccessResult('ok')]);
      }) as any);
      return holder;
    };

    // Unset → the SDK option is omitted entirely (the old `?? 1000`
    // fallback is gone — unlimited means no cap is armed).
    const unset = capture();
    await new ClaudeCodeWorker({ type: 'claude-code', description: 'x' }, tempDir, tempDir, unset.ctx, skills).run(makeTask(), {});
    expect(unset.options?.maxTurns).toBeUndefined();

    // Valid positive integer → passed through as-is.
    const valid = capture();
    await new ClaudeCodeWorker({ type: 'claude-code', description: 'x', maxTurns: 5 }, tempDir, tempDir, valid.ctx, skills).run(makeTask(), {});
    expect(valid.options?.maxTurns).toBe(5);

    // Invalid (0) → unlimited (option omitted) with exactly one warn.
    const invalid = capture();
    await new ClaudeCodeWorker({ type: 'claude-code', description: 'x', maxTurns: 0 }, tempDir, tempDir, invalid.ctx, skills).run(makeTask(), {});
    expect(invalid.options?.maxTurns).toBeUndefined();
    expect(vi.mocked(invalid.ctx.logger.warn)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(invalid.ctx.logger.warn).mock.calls[0][1])).toContain('Invalid maxTurns');
  });

  // --- tool call / result recording into the worker conversation ---

  describe('tool call and result recording', () => {
    /** Read the worker conversation from state. */
    function conversationOf(worker: ClaudeCodeWorker): any[] {
      return worker.getState().get<any[]>('conversation');
    }

    it('records text and the tool call (with its result) on a single entry', async () => {
      mockQuery.mockReturnValue(asyncYield([
        makeToolUseMessage({
          text: 'Running the build',
          calls: [{ id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }],
        }),
        makeToolResultUserMessage([{ toolUseId: 'toolu_1', content: 'all tests passed' }]),
        makeAssistantMessage('Done'),
        makeSuccessResult('Done'),
      ]) as any);

      const worker = createWorker();
      await worker.run(makeTask(), {});

      const conversation = conversationOf(worker);
      const step = conversation.find((e: any) => e.type === 'assistant' && e.toolCalls?.length);
      expect(step).toBeDefined();
      // Text block → message.content (unchanged behavior)
      expect(step.message.content).toBe('Running the build');
      // tool_use block → toolCalls, puppet-shaped
      expect(step.toolCalls).toHaveLength(1);
      expect(step.toolCalls[0].toolCallId).toBe('toolu_1');
      expect(step.toolCalls[0].toolName).toBe('Bash');
      expect(step.toolCalls[0].arguments).toBe('{"command":"npm test"}');
      expect(step.toolCalls[0].status).toBe('succeeded');
      // tool_result block → toolResults on the SAME entry, matched by id
      expect(step.toolResults).toHaveLength(1);
      expect(step.toolResults[0].toolCallId).toBe('toolu_1');
      expect(step.toolResults[0].toolName).toBe('Bash');
      expect(step.toolResults[0].output).toEqual({ type: 'text', value: 'all tests passed' });
      expect(step.toolResults[0].isError).toBeUndefined();
      expect(step.toolResults[0].status).toBe('succeeded');
      // Exactly one entry carries this call — no duplicate step entries.
      expect(conversation.filter(
        (e: any) => e.toolCalls?.some((tc: any) => tc.toolCallId === 'toolu_1'),
      )).toHaveLength(1);
      expect(conversation.filter(
        (e: any) => e.toolResults?.some((tr: any) => tr.toolCallId === 'toolu_1'),
      )).toHaveLength(1);
    });

    it('records every tool call of a multi-tool message, in order, results matched by id', async () => {
      mockQuery.mockReturnValue(asyncYield([
        makeToolUseMessage({
          calls: [
            { id: 't1', name: 'Read', input: { file_path: '/a.txt' } },
            { id: 't2', name: 'Bash', input: { command: 'ls' } },
            { id: 't3', name: 'Grep', input: { pattern: 'foo' } },
          ],
        }),
        // Results arrive in a different order — matching must be by id, not position.
        makeToolResultUserMessage([
          { toolUseId: 't3', content: 'a.txt:1:foo' },
          { toolUseId: 't1', content: 'file body' },
          { toolUseId: 't2', content: 'a.txt' },
        ]),
        makeSuccessResult('Done'),
      ]) as any);

      const worker = createWorker();
      await worker.run(makeTask(), {});

      const step = conversationOf(worker).find((e: any) => e.type === 'assistant' && e.toolCalls?.length);
      expect(step.toolCalls.map((tc: any) => tc.toolCallId)).toEqual(['t1', 't2', 't3']);
      expect(step.toolCalls.map((tc: any) => tc.toolName)).toEqual(['Read', 'Bash', 'Grep']);
      // Results keep their arrival order but attach to the right call ids.
      expect(step.toolResults.map((tr: any) => tr.toolCallId)).toEqual(['t3', 't1', 't2']);
      expect(step.toolResults.find((tr: any) => tr.toolCallId === 't1').output.value).toBe('file body');
      expect(step.toolResults.find((tr: any) => tr.toolCallId === 't2').toolName).toBe('Bash');
      expect(step.toolCalls.every((tc: any) => tc.status === 'succeeded')).toBe(true);
    });

    it('preserves the error flag on failed tool results', async () => {
      mockQuery.mockReturnValue(asyncYield([
        makeToolUseMessage({ calls: [{ id: 't1', name: 'Bash', input: { command: 'npm test' } }] }),
        makeToolResultUserMessage([{ toolUseId: 't1', content: 'npm ERR! missing script', isError: true }]),
        makeSuccessResult('Recovered'),
      ]) as any);

      const worker = createWorker();
      await worker.run(makeTask(), {});

      const step = conversationOf(worker).find((e: any) => e.type === 'assistant' && e.toolCalls?.length);
      expect(step.toolResults).toHaveLength(1);
      expect(step.toolResults[0].isError).toBe(true);
      expect(step.toolResults[0].status).toBe('failed');
      expect(step.toolResults[0].errorType).toBe('ToolError');
      expect(step.toolResults[0].output.value).toBe('npm ERR! missing script');
      // The call record is closed as failed too.
      expect(step.toolCalls[0].status).toBe('failed');
    });

    it('truncates oversized tool results and inputs with an explicit size marker', async () => {
      const longOutput = 'A'.repeat(5000);
      const longInputJson = JSON.stringify({ command: 'x'.repeat(9000) });
      mockQuery.mockReturnValue(asyncYield([
        makeToolUseMessage({ calls: [{ id: 't1', name: 'Bash', input: { command: 'x'.repeat(9000) } }] }),
        makeToolResultUserMessage([{ toolUseId: 't1', content: longOutput }]),
        makeSuccessResult('Done'),
      ]) as any);

      const worker = createWorker();
      await worker.run(makeTask(), {});

      const step = conversationOf(worker).find((e: any) => e.type === 'assistant' && e.toolCalls?.length);
      // Result: 2000-char head + marker with the original total.
      expect(step.toolResults[0].output.value).toBe(
        'A'.repeat(2000) + '... [truncated, 5000 chars]',
      );
      // Input: kept complete when short, truncated at the larger input cap.
      expect(step.toolCalls[0].arguments).toBe(
        longInputJson.slice(0, 8000) + `... [truncated, ${longInputJson.length} chars]`,
      );
    });

    it('records a pure tool_use message (no text) instead of dropping it', async () => {
      mockQuery.mockReturnValue(asyncYield([
        makeToolUseMessage({ calls: [{ id: 't1', name: 'Read', input: { file_path: '/a' } }] }),
        makeToolResultUserMessage([{ toolUseId: 't1', content: 'body' }]),
        makeSuccessResult('Done'),
      ]) as any);

      const worker = createWorker();
      await worker.run(makeTask(), {});

      // Regression: a text-less assistant message used to be dropped entirely.
      const step = conversationOf(worker).find((e: any) => e.type === 'assistant' && e.toolCalls?.length);
      expect(step).toBeDefined();
      expect(step.message.content).toBe('');
      expect(step.toolCalls).toHaveLength(1);
      expect(step.toolResults).toHaveLength(1);
    });

    it('still flushes a buffered tool step when the stream ends without results, marking calls cancelled', async () => {
      // No user tool_result message — the stream just ends after the result.
      mockQuery.mockReturnValue(asyncYield([
        makeToolUseMessage({ text: 'starting', calls: [{ id: 't1', name: 'Bash', input: { command: 'sleep 100' } }] }),
        makeSuccessResult('interrupted'),
      ]) as any);

      const worker = createWorker();
      await worker.run(makeTask(), {});

      const step = conversationOf(worker).find((e: any) => e.type === 'assistant' && e.toolCalls?.length);
      expect(step).toBeDefined();
      expect(step.message.content).toBe('starting');
      expect(step.toolCalls[0].status).toBe('cancelled');
      expect(step.toolResults).toBeUndefined();
    });

    it('flattens tool_result content delivered as a block array', async () => {
      mockQuery.mockReturnValue(asyncYield([
        makeToolUseMessage({ calls: [{ id: 't1', name: 'Read', input: { file_path: '/a' } }] }),
        makeToolResultUserMessage([{
          toolUseId: 't1',
          content: [
            { type: 'text', text: 'first 10 lines' },
            { type: 'image', source: { type: 'base64' } },
            { type: 'text', text: 'trailing note' },
          ],
        }]),
        makeSuccessResult('Done'),
      ]) as any);

      const worker = createWorker();
      await worker.run(makeTask(), {});

      const step = conversationOf(worker).find((e: any) => e.type === 'assistant' && e.toolCalls?.length);
      expect(step.toolResults[0].output.value).toBe('first 10 lines\n[image block]\ntrailing note');
    });

    it('makes the current tool visible to transcript readers (issue #16)', async () => {
      mockQuery.mockReturnValue(asyncYield([
        makeToolUseMessage({ text: 'checking', calls: [{ id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }] }),
        makeToolResultUserMessage([{ toolUseId: 'toolu_1', content: 'ok' }]),
        makeAssistantMessage('All checks passed'),
        makeSuccessResult('Done'),
      ]) as any);

      const worker = createWorker();
      await worker.run(makeTask(), {});

      // Read the real on-disk transcript (what the controller's tools see).
      const transcript = readWorkerTranscript(tempDir, worker.id);
      expect(transcript).not.toBeNull();
      const summary = summarizeTranscript(transcript!);
      expect(summary.currentTool).toBe('Bash');
      expect(summary.hasTerminalEntry).toBe(true);
    });
  });
});
