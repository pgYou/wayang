import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { WorkerAgent } from '@/services/agents/worker-agent';
import { SkillRegistry } from '@/services/skills/registry';
import { mockProvider, createMockCtx } from '@/__tests__/helpers';
import { EEntryType } from '@/types/index';
import type { ModelMessage } from 'ai';

// Empty registry shared across tests — workers need it for prompt building.
const skills = new SkillRegistry([]);

// Mock model-factory to avoid real SDK calls
vi.mock('../model-factory.js', () => ({
  createModel: () => ({}),
}));

// Mock streamText
vi.mock('ai', () => ({
  streamText: vi.fn(),
  stepCountIs: vi.fn((n: number) => n),
  hasToolCall: vi.fn((name: string) => name),
  tool: vi.fn((def: any) => def),
}));

import { streamText } from 'ai';

function mockStreamResponse(text: string, toolResults?: any[]) {
  vi.mocked(streamText).mockReturnValue({
    textStream: (async function* () { yield text; })(),
    text: Promise.resolve(text),
    toolResults: Promise.resolve(toolResults ?? []),
    usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
  } as any);
}

describe('WorkerAgent', () => {
  beforeEach(() => {
    vi.mocked(streamText).mockReset();
  });

  it('should create worker with unique id', () => {
    const w1 = new WorkerAgent(mockProvider, createMockCtx(), skills);
    const w2 = new WorkerAgent(mockProvider, createMockCtx(), skills);
    expect(w1.id).not.toBe(w2.id);
  });

  it('should return completed result via complete() callback', () => {
    const worker = new WorkerAgent(mockProvider, createMockCtx(), skills);
    worker.complete('All done successfully');
    expect(worker['_terminalResult']).toEqual({ status: 'completed', summary: 'All done successfully' });
  });

  it('should return failed result via fail() callback', () => {
    const worker = new WorkerAgent(mockProvider, createMockCtx(), skills);
    worker.fail('Something went wrong');
    expect(worker['_terminalResult']).toEqual({ status: 'failed', error: 'Something went wrong' });
  });

  it('should return stream text when max steps reached without done/fail', async () => {
    mockStreamResponse('some text without calling done');

    const worker = new WorkerAgent(mockProvider, createMockCtx(), skills);
    const result = await worker.run(
      { id: 't-5', title: 'test', description: 'test', workerId: 'w-5', priority: 'normal', status: 'running', createdAt: Date.now() },
      {},
    );

    expect(result.status).toBe('completed');
    expect(result.summary).toBe('some text without calling done');
  });

  it('should default toolChoice to auto when not configured', async () => {
    mockStreamResponse('some text');

    const worker = new WorkerAgent(mockProvider, createMockCtx(), skills);
    await worker.run(
      { id: 't-tc1', title: 'test', description: 'test', workerId: 'w-tc1', priority: 'normal', status: 'running', createdAt: Date.now() },
      {},
    );

    // 'required' is rejected by thinking endpoints (DeepSeek/GLM) with HTTP 400,
    // so the safe default lets the model decide; done/fail is prompt-enforced
    expect(vi.mocked(streamText).mock.calls[0][0]).toMatchObject({ toolChoice: 'auto' });
  });

  it('should pass configured toolChoice through to the LLM call', async () => {
    mockStreamResponse('some text');

    const worker = new WorkerAgent(mockProvider, createMockCtx(), skills, 'auto');
    await worker.run(
      { id: 't-tc2', title: 'test', description: 'test', workerId: 'w-tc2', priority: 'normal', status: 'running', createdAt: Date.now() },
      {},
    );

    expect(vi.mocked(streamText).mock.calls[0][0]).toMatchObject({ toolChoice: 'auto' });
  });

  it('should return failed when abort signal is already set before run', async () => {
    mockStreamResponse('');

    const worker = new WorkerAgent(mockProvider, createMockCtx(), skills);
    worker.abort();

    const result = await worker.run(
      { id: 't-6', title: 'test', description: 'test', workerId: 'w-6', priority: 'normal', status: 'running', createdAt: Date.now() },
      {},
    );

    expect(result.status).toBe('failed');
    expect(result.error).toBe('Aborted');
  });

  it('should return terminal result when complete() called via done tool', async () => {
    const worker = new WorkerAgent(mockProvider, createMockCtx(), skills);

    // Simulate: LLM calls done tool → complete() is invoked during stream
    vi.mocked(streamText).mockImplementation(((opts: any) => {
      // Simulate the done tool callback being triggered during streaming
      worker.complete('Task finished');
      return {
        textStream: (async function* () {
          yield 'partial text';
        })(),
        text: Promise.resolve('partial text'),
        toolResults: Promise.resolve([]),
        usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
      };
    }) as any);

    const result = await worker.run(
      { id: 't-7', title: 'test', description: 'test', workerId: 'w-7', priority: 'normal', status: 'running', createdAt: Date.now() },
      {},
    );

    expect(result.status).toBe('completed');
    expect(result.summary).toBe('Task finished');
  });

  it('should write the session id (not the worker id) on conversation entries', async () => {
    // Fire onStepFinish so an assistant entry lands in the conversation
    vi.mocked(streamText).mockImplementation(((opts: any) => {
      opts.onStepFinish?.({
        text: 'step text',
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: 'stop',
      });
      return {
        textStream: (async function* () { yield 'final text'; })(),
        text: Promise.resolve('final text'),
        toolResults: Promise.resolve([]),
        usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
      };
    }) as any);

    const tempDir = mkdtempSync(join(tmpdir(), 'wayang-wa-sid-'));
    try {
      // Mock ctx sessionId is 'test-session' — every entry must carry it
      const ctx = createMockCtx({ sessionDir: tempDir });
      const worker = new WorkerAgent(mockProvider, ctx, skills);
      await worker.run(
        { id: 't-sid', title: 'test', description: 'test session id', workerId: 'w-sid', priority: 'normal', status: 'running', createdAt: Date.now() },
        {},
      );

      const conversation = worker.getConversation();
      expect(conversation.length).toBeGreaterThanOrEqual(2);
      const types = new Set(conversation.map((e) => e.type));
      expect(types.has(EEntryType.User)).toBe(true);
      expect(types.has(EEntryType.Assistant)).toBe(true);
      for (const entry of conversation) {
        expect(entry.sessionId).toBe('test-session');
        expect(entry.sessionId).not.toBe(worker.id);
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

/**
 * Controller-message injection through the real wiring (worker + prepareStep),
 * driven by a streamText fake that mirrors the SDK step loop:
 * step k's prepareStep sees [initialMessages, ...responseMessages of steps
 * 0..k-1] and an override applies to THAT request only — the loop re-derives
 * the base each step and never absorbs the override.
 */
describe('WorkerAgent controller-message injection', () => {
  beforeEach(() => {
    vi.mocked(streamText).mockReset();
  });

  /**
   * Install the fake step loop. `deliver(run, step)` runs right before the
   * given step's prepareStep — the message-arrival point. Records every
   * step's request messages plus each run's initial messages.
   */
  function mockStepLoop(opts: {
    replies: string[];
    deliver?: (run: number, step: number) => void;
  }) {
    const captured: {
      /** Initial messages of each streamText call (one per worker run). */
      initials: ModelMessage[][];
      /** Request messages of every step across runs, in order. */
      requests: ModelMessage[][];
      /** Whether prepareStep returned an override for each step. */
      overridden: boolean[];
    } = { initials: [], requests: [], overridden: [] };

    vi.mocked(streamText).mockImplementation(((streamOpts: any) => {
      captured.initials.push(streamOpts.messages);
      const responseMessages: ModelMessage[] = [];
      for (let step = 0; step < opts.replies.length; step++) {
        opts.deliver?.(captured.initials.length - 1, step);
        const stepInputMessages: ModelMessage[] = [...streamOpts.messages, ...responseMessages];
        const prepareResult = streamOpts.prepareStep?.({
          messages: stepInputMessages,
          steps: [],
          stepNumber: step,
          model: {},
          experimental_context: undefined,
        });
        captured.requests.push(prepareResult === undefined ? stepInputMessages : prepareResult.messages);
        captured.overridden.push(prepareResult !== undefined);
        // The step's reply lands in the conversation (like a real step) and
        // becomes a response message for the steps that follow.
        streamOpts.onStepFinish?.({
          text: opts.replies[step],
          usage: { inputTokens: 10, outputTokens: 5 },
          finishReason: 'stop',
        });
        responseMessages.push({ role: 'assistant', content: opts.replies[step] });
      }
      const last = opts.replies[opts.replies.length - 1] ?? '';
      return {
        textStream: (async function* () { yield last; })(),
        text: Promise.resolve(last),
        toolResults: Promise.resolve([]),
        usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
      } as any;
    }) as any);

    return captured;
  }

  const task = (id: string, description: string) => ({
    id, title: `Task ${id}`, description, workerId: `w-${id}`,
    priority: 'normal' as const, status: 'running' as const, createdAt: Date.now(),
  });

  const user = (text: string): ModelMessage => ({ role: 'user', content: text });
  const assistant = (text: string): ModelMessage => ({ role: 'assistant', content: text });

  /** User entries in the conversation that carry the given controller text. */
  function controllerEntries(worker: WorkerAgent, rawContent: string) {
    const text = `[Controller message] ${rawContent}`;
    return worker.getConversation().filter(
      (e) => e.type === EEntryType.User && (e as any).message?.content === text,
    );
  }

  it('delivers a mid-run message once, before the reply of the step it arrived in (entry written once)', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'wayang-inj-'));
    try {
      const ctx = createMockCtx({ sessionDir: tempDir });
      // Holder: the deliver callback must reference the worker before the
      // test can construct it.
      const w: { current?: WorkerAgent } = {};
      const captured = mockStepLoop({
        replies: ['r0', 'r1', 'r2', 'r3'],
        deliver: (run, step) => {
          if (run === 0 && step === 2) w.current!.acceptMessage('switch to plan B');
        },
      });

      w.current = new WorkerAgent(mockProvider, ctx, skills);
      await w.current.run(task('inj-1', 'do the thing'), {});
      const worker = w.current;

      const ctrl = user('[Controller message] switch to plan B');
      // Step 2 (arrival): tail of the conversation the model replies to.
      // Step 3: exactly once, before r2 — the reply of the arrival step.
      expect(captured.requests).toEqual([
        [user('do the thing')],
        [user('do the thing'), assistant('r0')],
        [user('do the thing'), assistant('r0'), assistant('r1'), ctrl],
        [user('do the thing'), assistant('r0'), assistant('r1'), ctrl, assistant('r2')],
      ]);
      expect(captured.overridden).toEqual([false, false, true, true]);

      // The conversation entry is written exactly once — re-merging the
      // message into later steps' requests never duplicates it.
      const entries = controllerEntries(worker, 'switch to plan B');
      expect(entries).toHaveLength(1);
      // And its position mirrors the prompt: between r1 and r2.
      const conversation = worker.getConversation();
      const contents = conversation.map((e) => (e as any).message.content as string);
      expect(contents).toEqual(['do the thing', 'r0', 'r1', '[Controller message] switch to plan B', 'r2', 'r3']);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rebuilds the message from the conversation on the next stage — present once, not re-injected', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'wayang-inj-2-'));
    try {
      const ctx = createMockCtx({ sessionDir: tempDir });
      const w: { current?: WorkerAgent } = {};
      const captured = mockStepLoop({
        replies: ['s0', 's1', 's2'],
        deliver: (run, step) => {
          if (run === 0 && step === 1) w.current!.acceptMessage('remember the constraint');
        },
      });

      w.current = new WorkerAgent(mockProvider, ctx, skills);
      await w.current.run(task('inj-2a', 'first stage'), {});
      // Second stage on the same worker (assignToExistingWorker path): the
      // conversation carries forward, the inbox is empty.
      await w.current.run(task('inj-2b', 'second stage'), {});

      const ctrl = user('[Controller message] remember the constraint');
      // Run 2 initial messages: rebuilt from the conversation — the message
      // is there exactly once, in its conversation position (after s0, the
      // reply it preceded in run 1), plus the new stage prompt.
      expect(captured.initials[1]).toEqual([
        user('first stage'),
        assistant('s0'),
        ctrl,
        assistant('s1'),
        assistant('s2'),
        user('second stage'),
      ]);

      // Run 2 steps: fast path — the injection hook never re-adds the message
      // (it lives in the initial messages now, not the inbox).
      const run2Requests = captured.requests.slice(3);
      expect(run2Requests[0]).toEqual([
        user('first stage'), assistant('s0'), ctrl, assistant('s1'), assistant('s2'), user('second stage'),
      ]);
      expect(run2Requests[1]).toEqual([
        user('first stage'), assistant('s0'), ctrl, assistant('s1'), assistant('s2'), user('second stage'), assistant('s0'),
      ]);
      expect(captured.overridden.slice(3)).toEqual([false, false, false]);

      // Still exactly one conversation entry for the message.
      expect(controllerEntries(w.current!, 'remember the constraint')).toHaveLength(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('sends byte-identical messages when no controller message ever arrives', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'wayang-inj-3-'));
    try {
      const ctx = createMockCtx({ sessionDir: tempDir });
      const captured = mockStepLoop({ replies: ['r0', 'r1', 'r2'] });

      const worker = new WorkerAgent(mockProvider, ctx, skills);
      await worker.run(task('inj-3', 'quiet task'), {});

      expect(captured.requests).toEqual([
        [user('quiet task')],
        [user('quiet task'), assistant('r0')],
        [user('quiet task'), assistant('r0'), assistant('r1')],
      ]);
      expect(captured.overridden).toEqual([false, false, false]);
      expect(controllerEntries(worker, 'irrelevant')).toHaveLength(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
