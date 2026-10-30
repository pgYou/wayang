import { EEntryType } from '@/types/index';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ControllerAgent } from '@/services/agents/controller-agent';
import type { ControllerAgentState } from '@/services/agents/controller-state';
import type { ControllerSignal } from '@/types/index';
import { SkillRegistry } from '@/services/skills/registry';
import { mockProvider, createMockCtx } from '@/__tests__/helpers';

// Empty registry — controller needs it for prompt building.
const skills = new SkillRegistry([]);

// Mock model-factory to avoid real SDK calls
vi.mock('../model-factory.js', () => ({
  createModel: () => ({}),
}));

// Mock streamText to avoid real LLM calls
vi.mock('ai', () => ({
  streamText: vi.fn(),
  generateText: vi.fn(),
  stepCountIs: vi.fn((n: number) => n),
  hasToolCall: vi.fn((name: string) => name),
}));

import { streamText, generateText } from 'ai';

function createMockState(): any {
  const data: Record<string, any> = {
    conversation: [],
  };
  return {
    get: vi.fn((path: string) => data[path] ?? null),
    set: vi.fn((path: string, value: any) => { data[path] = value; }),
    append: vi.fn((path: string, entry: any) => {
      data[path] = data[path] ?? [];
      data[path].push(entry);
    }),
    restore: vi.fn(async () => {}),
  };
}

function mockStreamResponse(text: string) {
  // streamText returns synchronously — an object with textStream, text (Promise), etc.
  vi.mocked(streamText).mockReturnValue({
    textStream: (async function* () { yield text; })(),
    text: Promise.resolve(text),
    toolResults: Promise.resolve([]),
    usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
  } as any);
}

describe('ControllerAgent', () => {
  let state: any;
  let agent: ControllerAgent;

  beforeEach(() => {
    state = createMockState();
    vi.mocked(streamText).mockReset();
    vi.mocked(generateText).mockReset();
    agent = new ControllerAgent(
      createMockCtx(),
      state as ControllerAgentState,
      mockProvider,
      {}, // tools
      skills,
    );
  });

  it('should run messages and append to conversation', async () => {
    mockStreamResponse('mock response');

    const signals: ControllerSignal[] = [
      {
        id: 'sig-1',
        source: 'user',
        type: 'input',
        payload: { text: 'hello' },
        timestamp: Date.now(),
        status: 'unread',
      },
    ];

    const result = await agent.run(signals);

    expect(result.text).toBe('mock response');
    expect(state.append).toHaveBeenCalled();
  });

  it('should extract text from payload variants', async () => {
    mockStreamResponse('ok');

    const signals: ControllerSignal[] = [
      {
        id: 'sig-2',
        source: 'worker',
        type: 'completed',
        payload: { summary: 'task done', taskId: 't-1', workerId: 'w-1', taskTitle: 'Test task' },
        timestamp: Date.now(),
        status: 'unread',
      },
    ];

    await agent.run(signals);

    const sigCall = state.append.mock.calls.find(
      (call: any[]) => call[1]?.type === 'signal',
    );
    expect(sigCall[1].content).toBe('task done');
    expect(sigCall[1].subtype).toBe('worker_completed');
  });

  it('should pass workerType, emoji, and taskTitle in completed signal entry', async () => {
    mockStreamResponse('ok');

    const signals: ControllerSignal[] = [
      {
        id: 'sig-comp',
        source: 'worker',
        type: 'completed',
        payload: {
          taskId: 't-10',
          workerId: 'w-10',
          workerType: 'claude-code',
          emoji: '\u{1F9E0}',
          taskTitle: 'Refactor module',
          summary: 'Refactored successfully',
        },
        timestamp: Date.now(),
        status: 'unread',
      },
    ];

    await agent.run(signals);

    const sigCall = state.append.mock.calls.find(
      (call: any[]) => call[1]?.type === 'signal',
    );
    const entry = sigCall[1];
    expect(entry.workerType).toBe('claude-code');
    expect(entry.emoji).toBe('\u{1F9E0}');
    expect(entry.taskTitle).toBe('Refactor module');
    expect(entry.workerId).toBe('w-10');
    expect(entry.taskId).toBe('t-10');
    expect(entry.subtype).toBe('worker_completed');
  });

  it('should pass workerType, emoji, and taskTitle in failed signal entry', async () => {
    mockStreamResponse('ok');

    const signals: ControllerSignal[] = [
      {
        id: 'sig-fail',
        source: 'worker',
        type: 'failed',
        payload: {
          taskId: 't-11',
          workerId: 'w-11',
          workerType: 'puppet',
          emoji: '\u{1F9F8}',
          taskTitle: 'Write tests',
          error: 'Timeout',
        },
        timestamp: Date.now(),
        status: 'unread',
      },
    ];

    await agent.run(signals);

    const sigCall = state.append.mock.calls.find(
      (call: any[]) => call[1]?.type === 'signal',
    );
    const entry = sigCall[1];
    expect(entry.workerType).toBe('puppet');
    expect(entry.emoji).toBe('\u{1F9F8}');
    expect(entry.taskTitle).toBe('Write tests');
    expect(entry.subtype).toBe('worker_failed');
    expect(entry.content).toBe('Timeout');
  });

  it('should pass workerType, emoji, and taskTitle in progress signal entry', async () => {
    mockStreamResponse('ok');

    const signals: ControllerSignal[] = [
      {
        id: 'sig-prog',
        source: 'worker',
        type: 'progress',
        payload: {
          workerId: 'w-12',
          taskId: 't-12',
          taskTitle: 'Build project',
          workerType: 'puppet',
          emoji: '\u{1F9F8}',
          message: 'Compiling...',
        },
        timestamp: Date.now(),
        status: 'unread',
      },
    ];

    await agent.run(signals);

    const sigCall = state.append.mock.calls.find(
      (call: any[]) => call[1]?.type === 'signal',
    );
    const entry = sigCall[1];
    expect(entry.workerType).toBe('puppet');
    expect(entry.emoji).toBe('\u{1F9F8}');
    expect(entry.taskTitle).toBe('Build project');
    expect(entry.subtype).toBe('worker_progress');
    expect(entry.content).toBe('Compiling...');
  });

  it('should handle input signal with text payload', async () => {
    mockStreamResponse('ok');

    const signals: ControllerSignal[] = [
      {
        id: 'sig-3',
        source: 'user',
        type: 'input',
        payload: { text: 'custom data' },
        timestamp: Date.now(),
        status: 'unread',
      },
    ];

    await agent.run(signals);

    const userCall = state.append.mock.calls.find(
      (call: any[]) => call[1]?.type === 'user',
    );
    expect(userCall[1].message.content).toBe('custom data');
  });

  it('should write the same sessionId on user, signal, and assistant entries', async () => {
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

    const signals: ControllerSignal[] = [
      {
        id: 'sig-sid-1',
        source: 'user',
        type: 'input',
        payload: { text: 'hello' },
        timestamp: Date.now(),
        status: 'unread',
      },
      {
        id: 'sig-sid-2',
        source: 'worker',
        type: 'completed',
        payload: { summary: 'task done', taskId: 't-sid', workerId: 'w-sid', taskTitle: 'Sid task' },
        timestamp: Date.now(),
        status: 'unread',
      },
    ];

    await agent.run(signals);

    const entries = state.append.mock.calls
      .filter((call: any[]) => call[0] === 'conversation')
      .map((call: any[]) => call[1]);
    expect(entries.length).toBeGreaterThanOrEqual(3);
    const types = new Set(entries.map((e: any) => e.type));
    expect(types.has('user')).toBe(true);
    expect(types.has('signal')).toBe(true);
    expect(types.has('assistant')).toBe(true);
    // Mock ctx sessionId is 'test-session' — every entry must carry it
    for (const entry of entries) {
      expect(entry.sessionId).toBe('test-session');
    }
  });

  it('should backfill the restored summary into the context manager on restore', async () => {
    mockStreamResponse('ok');

    // The state layer's restore() exposes the persisted compact summary
    state.set('compactSummary', 'restored summary text');
    await agent.restore();

    const signals: ControllerSignal[] = [
      {
        id: 'sig-restore-1',
        source: 'user',
        type: 'input',
        payload: { text: 'hello after restore' },
        timestamp: Date.now(),
        status: 'unread',
      },
    ];
    await agent.run(signals);

    const call = vi.mocked(streamText).mock.calls.at(-1)![0] as any;
    // System prompt carries the summary under [Conversation Summary]
    expect(call.system).toContain('[Conversation Summary]');
    expect(call.system).toContain('restored summary text');
    // getMessages() prepends the summary as the first system message
    expect(call.messages[0]).toEqual({
      role: 'system',
      content: '[Conversation Summary]\nrestored summary text',
    });
  });

  it('should fold the previous summary into the summarizer input on compaction', async () => {
    state.set('compactSummary', 'old summary to carry forward');
    await agent.restore();

    // compact() requires at least 4 conversation entries
    for (let i = 0; i < 4; i++) {
      state.append('conversation', {
        type: 'user',
        uuid: `u-comp-${i}`,
        parentUuid: null,
        sessionId: 'test-session',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: `entry ${i}` },
      });
    }
    vi.mocked(generateText).mockResolvedValue({ text: 'new summary' } as any);

    await agent.performCompaction();

    expect(generateText).toHaveBeenCalledTimes(1);
    const prompt = (vi.mocked(generateText).mock.calls[0][0] as any).prompt as string;
    expect(prompt).toContain('[Previous Summary]');
    expect(prompt).toContain('old summary to carry forward');
  });

  it('should not add [Previous Summary] when no previous summary exists', async () => {
    // Fresh agent — no restore, no prior compaction
    for (let i = 0; i < 4; i++) {
      state.append('conversation', {
        type: 'user',
        uuid: `u-noprev-${i}`,
        parentUuid: null,
        sessionId: 'test-session',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: `entry ${i}` },
      });
    }
    vi.mocked(generateText).mockResolvedValue({ text: 'brand new summary' } as any);

    await agent.performCompaction();

    expect(generateText).toHaveBeenCalledTimes(1);
    const prompt = (vi.mocked(generateText).mock.calls[0][0] as any).prompt as string;
    expect(prompt).not.toContain('[Previous Summary]');
  });

  it('should stamp compactMeta.model from the current provider config', async () => {
    for (let i = 0; i < 4; i++) {
      state.append('conversation', {
        type: 'user',
        uuid: `u-model-${i}`,
        parentUuid: null,
        sessionId: 'test-session',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: `entry ${i}` },
      });
    }
    vi.mocked(generateText).mockResolvedValue({ text: 'summary with model' } as any);

    await agent.performCompaction();

    const marker = state.append.mock.calls
      .map((call: any[]) => call[1])
      .find((e: any) => e?.type === 'system' && e?.subtype === 'compact');
    expect(marker).toBeDefined();
    expect(marker.compactMeta.model).toBe(mockProvider.modelName);
  });

  it('should omit compactMeta.model when the provider config carries no model name', async () => {
    const noModelProvider = { ...mockProvider, modelName: undefined } as any;
    const agentNoModel = new ControllerAgent(
      createMockCtx(),
      state as ControllerAgentState,
      noModelProvider,
      {},
      skills,
    );
    for (let i = 0; i < 4; i++) {
      state.append('conversation', {
        type: 'user',
        uuid: `u-nomodel-${i}`,
        parentUuid: null,
        sessionId: 'test-session',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: `entry ${i}` },
      });
    }
    vi.mocked(generateText).mockResolvedValue({ text: 'summary no model' } as any);

    await agentNoModel.performCompaction();

    const marker = state.append.mock.calls
      .map((call: any[]) => call[1])
      .find((e: any) => e?.type === 'system' && e?.subtype === 'compact');
    expect(marker).toBeDefined();
    // Never fabricated — absent config means absent field.
    expect(marker.compactMeta.model).toBeUndefined();
  });

  it('should write endedAt on user and signal entries at delivery time', async () => {
    mockStreamResponse('ok');

    const signals: ControllerSignal[] = [
      {
        id: 'sig-end-1',
        source: 'user',
        type: 'input',
        payload: { text: 'hello endedAt' },
        timestamp: Date.now() - 5_000,
        status: 'unread',
      },
      {
        id: 'sig-end-2',
        source: 'worker',
        type: 'completed',
        payload: { summary: 'task done', taskId: 't-end', workerId: 'w-end', taskTitle: 'Ended task' },
        timestamp: Date.now() - 4_000,
        status: 'unread',
      },
    ];

    await agent.run(signals);

    const entries = state.append.mock.calls
      .filter((call: any[]) => call[0] === 'conversation')
      .map((call: any[]) => call[1]);
    const userEntry = entries.find((e: any) => e?.type === 'user');
    const signalEntry = entries.find((e: any) => e?.type === 'signal');
    expect(userEntry.endedAt).toEqual(expect.any(String));
    expect(signalEntry.endedAt).toEqual(expect.any(String));
    // endedAt (delivery) must not precede startedAt (queue time).
    expect(new Date(signalEntry.endedAt!).getTime())
      .toBeGreaterThanOrEqual(new Date(signalEntry.startedAt!).getTime());
    // startedAt still reflects the queue time.
    expect(signalEntry.startedAt).toEqual(new Date(signals[1].timestamp).toISOString());
  });

  it('should convert task_cancelled signals with the dedicated subtype', async () => {
    mockStreamResponse('ok');

    const signals: ControllerSignal[] = [
      {
        id: 'sig-tc-1',
        source: 'system',
        type: 'task_cancelled',
        payload: { taskId: 't-cancelled', taskTitle: 'Cancelled task' },
        timestamp: Date.now(),
        status: 'unread',
      },
    ];

    await agent.run(signals);

    const sigCall = state.append.mock.calls.find(
      (call: any[]) => call[1]?.type === 'signal',
    );
    const entry = sigCall[1];
    expect(entry.subtype).toBe('task_cancelled');
    expect(entry.taskId).toBe('t-cancelled');
    expect(entry.taskTitle).toBe('Cancelled task');
    expect(entry.content).toContain('[TASK CANCELLED]');
    expect(entry.endedAt).toEqual(expect.any(String));
  });

  it('should write dynamicState.contextUsage after a step, preferring real usage over the estimate', async () => {
    // Step reports 25k input tokens — distinct from any local estimate.
    vi.mocked(streamText).mockImplementation(((opts: any) => {
      opts.onStepFinish?.({
        text: 'step text',
        usage: { inputTokens: 25_000, outputTokens: 100 },
        finishReason: 'stop',
      });
      return {
        textStream: (async function* () { yield 'final text'; })(),
        text: Promise.resolve('final text'),
        toolResults: Promise.resolve([]),
        usage: Promise.resolve({ inputTokens: 25_000, outputTokens: 100 }),
      };
    }) as any);

    const signals: ControllerSignal[] = [
      {
        id: 'sig-ctx-usage',
        source: 'user',
        type: 'input',
        payload: { text: 'hello context' },
        timestamp: Date.now(),
        status: 'unread',
      },
    ];
    await agent.run(signals);

    const usage = state.get('dynamicState.contextUsage');
    expect(usage).toBeDefined();
    expect(usage.source).toBe('usage');
    expect(usage.usedTokens).toBe(25_000);
    expect(usage.contextWindowTokens).toBe(256_000);
    expect(usage.ratio).toBeCloseTo(25_000 / 256_000);
  });

  it('should fall back to the estimate when the step reports no input tokens', async () => {
    vi.mocked(streamText).mockImplementation(((opts: any) => {
      opts.onStepFinish?.({
        text: 'step text',
        usage: { inputTokens: undefined, outputTokens: undefined },
        finishReason: 'stop',
      });
      return {
        textStream: (async function* () { yield 'final text'; })(),
        text: Promise.resolve('final text'),
        toolResults: Promise.resolve([]),
        usage: Promise.resolve(undefined),
      };
    }) as any);

    const signals: ControllerSignal[] = [
      {
        id: 'sig-ctx-est',
        source: 'user',
        type: 'input',
        payload: { text: 'hello estimate' },
        timestamp: Date.now(),
        status: 'unread',
      },
    ];
    await agent.run(signals);

    const usage = state.get('dynamicState.contextUsage');
    expect(usage).toBeDefined();
    expect(usage.source).toBe('estimate');
    // System prompt alone guarantees a positive estimate
    expect(usage.usedTokens).toBeGreaterThan(0);
    expect(usage.contextWindowTokens).toBe(256_000);
  });

  /** Assistant entry carrying provider usage (self-contained per test). */
  const usageEntry = (uuid: string, inputTokens: number) => ({
    type: EEntryType.Assistant,
    uuid,
    parentUuid: null,
    sessionId: 's',
    timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: 'x', usage: { inputTokens, outputTokens: 1 } },
  });

  it('should seed the compaction check with the last real usage on restore', async () => {
    state.set('conversation', [usageEntry('a-seed-1', 240_000)]);
    await agent.restore();

    // 240k > 90% of the 256k default — real usage, not the tiny estimate.
    expect(agent.needsCompaction()).toBe(true);
    const usage = state.get('dynamicState.contextUsage');
    expect(usage.source).toBe('usage');
    expect(usage.usedTokens).toBe(240_000);
  });

  it('should not seed usage that predates the last compaction marker', async () => {
    state.set('conversation', [
      usageEntry('a-seed-2', 240_000),
      {
        type: EEntryType.System,
        uuid: 'compact-seed',
        parentUuid: null,
        sessionId: 's',
        timestamp: new Date().toISOString(),
        subtype: 'compact',
        content: 'summary',
        compactMeta: { summarizedTokenCount: 1 },
      },
    ]);
    await agent.restore();

    expect(agent.needsCompaction()).toBe(false);
    expect(state.get('dynamicState.contextUsage').source).toBe('estimate');
  });

  it('should keep recent history and stop re-triggering after the truncation fallback', async () => {
    // A real usage mark above the threshold, then a summarizer that always fails.
    state.set('conversation', Array.from({ length: 10 }, (_, i) => usageEntry(`a-trunc-${i}`, 240_000)));
    await agent.restore();
    expect(agent.needsCompaction()).toBe(true);
    vi.mocked(generateText).mockRejectedValue(new Error('provider down'));

    await agent.performCompaction();

    expect(state.get('conversation')).toHaveLength(5);
    // Stale high-water mark cleared — the next loop must not truncate again.
    expect(agent.needsCompaction()).toBe(false);
  });

  it('should seed contextUsage from the estimate after restore', async () => {
    await agent.restore();

    const usage = state.get('dynamicState.contextUsage');
    expect(usage).toBeDefined();
    expect(usage.source).toBe('estimate');
    expect(usage.usedTokens).toBeGreaterThan(0);
  });

  it('should include the token breakdown and the last step usage in contextUsage', async () => {
    vi.mocked(streamText).mockImplementation(((opts: any) => {
      opts.onStepFinish?.({
        text: 'step text',
        usage: { inputTokens: 25_000, outputTokens: 100, cachedInputTokens: 20_000 },
        finishReason: 'stop',
      });
      return {
        textStream: (async function* () { yield 'final text'; })(),
        text: Promise.resolve('final text'),
        toolResults: Promise.resolve([]),
        usage: Promise.resolve({ inputTokens: 25_000, outputTokens: 100, cachedInputTokens: 20_000 }),
      };
    }) as any);

    const signals: ControllerSignal[] = [
      {
        id: 'sig-ctx-breakdown',
        source: 'user',
        type: 'input',
        payload: { text: 'hello breakdown' },
        timestamp: Date.now(),
        status: 'unread',
      },
    ];
    await agent.run(signals);

    const usage = state.get('dynamicState.contextUsage');

    expect(usage.breakdown).toBeDefined();
    const groups = ['systemPrompt', 'user', 'assistant', 'toolCalls', 'toolResults', 'compactSummary'] as const;
    for (const group of groups) {
      expect(typeof usage.breakdown[group]).toBe('number');
      expect(usage.breakdown[group]).toBeGreaterThanOrEqual(0);
    }
    const groupSum = groups.reduce((sum, group) => sum + usage.breakdown[group], 0);
    expect(usage.breakdown.total).toBe(groupSum);

    expect(usage.lastUsage).toEqual({
      inputTokens: 25_000,
      outputTokens: 100,
      cachedInputTokens: 20_000,
    });
  });

  it('should carry the newest assistant usage into contextUsage after restore', async () => {
    state.append('conversation', {
      type: 'assistant',
      uuid: 'a-restored',
      parentUuid: null,
      sessionId: 's-controller',
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: 'restored step',
        usage: { inputTokens: 9_000, outputTokens: 250, cachedInputTokens: 4_000 },
      },
    });

    await agent.restore();

    const usage = state.get('dynamicState.contextUsage');
    expect(usage.lastUsage).toEqual({
      inputTokens: 9_000,
      outputTokens: 250,
      cachedInputTokens: 4_000,
    });
    expect(usage.breakdown.total).toBeGreaterThan(0);
  });
});
