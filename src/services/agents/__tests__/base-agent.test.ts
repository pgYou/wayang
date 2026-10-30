import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaseAgent } from '@/services/agents/base-agent';
import type { ProviderConfig } from '@/types/index';
import { mockProvider } from '@/__tests__/helpers';

// Mock streamText and model-factory
vi.mock('ai', () => ({
  streamText: vi.fn(),
  stepCountIs: vi.fn((n: number) => n),
  hasToolCall: vi.fn((name: string) => name),
}));
vi.mock('../model-factory.js', () => ({
  createModel: () => ({}),
}));

import { streamText } from 'ai';
import type { StepMeta, StreamLoopOptions } from '@/services/agents/base-agent';

// Concrete subclass for testing
class TestAgent extends BaseAgent {
  readonly state: any;
  constructor(provider: ProviderConfig, state?: any) {
    super(provider);
    this.state = state ?? { append: vi.fn(), get: vi.fn(() => []) };
  }
  /** Expose the protected streaming loop for direct testing. */
  runLoop(opts: StreamLoopOptions) {
    return this.streamLoop(opts);
  }
}

describe('BaseAgent', () => {
  it('should generate unique id', () => {
    const agent1 = new TestAgent(mockProvider);
    const agent2 = new TestAgent(mockProvider);
    expect(agent1.id).not.toBe(agent2.id);
  });

  it('should abort via abortController', () => {
    const agent = new TestAgent(mockProvider);
    agent.abort();
    expect(agent.abortController.signal.aborted).toBe(true);
  });

  it('should create model from provider', () => {
    const agent = new TestAgent(mockProvider);
    expect(agent).toBeDefined();
  });
});

// --- streamLoop: per-step StepMeta timing (added with the timing work) ---

/** A minimal stream result object satisfying streamLoop's awaits. */
function fakeStream(text: string) {
  return {
    textStream: (async function* () { yield text; })(),
    text: Promise.resolve(text),
    reasoningText: Promise.resolve(''),
    toolResults: Promise.resolve([]),
    usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
    finishReason: Promise.resolve('stop'),
    steps: Promise.resolve([]),
  };
}

describe('BaseAgent.streamLoop: per-step StepMeta timing', () => {
  beforeEach(() => {
    vi.mocked(streamText).mockReset();
  });

  it('hands onStep the first-chunk time for text steps and undefined for pure tool steps', async () => {
    const metas: StepMeta[] = [];
    vi.mocked(streamText).mockImplementation(((opts: any) => {
      const textStream = (async function* () {
        // Step 1: a text chunk arrives, then the step finishes.
        yield 'hello';
        opts.onStepFinish?.({ text: 'hello', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } });
        // Step 2: pure tool step — no text chunk between the boundaries.
        opts.onStepFinish?.({ text: '', toolCalls: [{ toolCallId: 'tc1', toolName: 'bash' }], toolResults: [], finishReason: 'tool-calls' });
        yield 'end';
      })();
      return { ...fakeStream('hello end'), textStream };
    }) as any);

    const agent = new TestAgent(mockProvider);
    const gen = agent.runLoop({
      system: 'sys',
      messages: [],
      tools: {},
      onStep: (_event, meta) => { metas.push(meta); },
    });
    // Drain the generator to completion.
    while (true) {
      const { done } = await gen.next();
      if (done) break;
    }

    expect(metas).toHaveLength(2);
    // Step 1: stream start recorded, first token recorded.
    expect(metas[0].startedAt).toEqual(expect.any(String));
    expect(metas[0].firstTokenAt).toEqual(expect.any(String));
    // Step 2 (pure tool step): step start recorded, but NO firstTokenAt —
    // no text chunk arrived between the step boundaries.
    expect(metas[1].startedAt).toEqual(expect.any(String));
    expect(metas[1].firstTokenAt).toBeUndefined();
    // Each step's start resets: step 2 starts no earlier than step 1's.
    expect(new Date(metas[1].startedAt!).getTime())
      .toBeGreaterThanOrEqual(new Date(metas[0].startedAt!).getTime());
  });

  it('leaves firstTokenAt undefined when the stream never yields text before the step', async () => {
    const metas: StepMeta[] = [];
    vi.mocked(streamText).mockImplementation(((opts: any) => {
      const textStream = (async function* () {
        // The (only) step finishes with a tool call and no preceding text chunk.
        opts.onStepFinish?.({ text: '', toolCalls: [{ toolCallId: 'tc1', toolName: 'read_file' }], toolResults: [], finishReason: 'tool-calls' });
        // A later chunk would belong to a hypothetical next step — irrelevant
        // to the step that already finished.
        yield 'late';
      })();
      return { ...fakeStream(''), textStream };
    }) as any);

    const agent = new TestAgent(mockProvider);
    const gen = agent.runLoop({
      system: 'sys',
      messages: [],
      tools: {},
      onStep: (_event, meta) => { metas.push(meta); },
    });
    while (true) {
      const { done } = await gen.next();
      if (done) break;
    }

    expect(metas).toHaveLength(1);
    expect(metas[0].startedAt).toEqual(expect.any(String));
    expect(metas[0].firstTokenAt).toBeUndefined();
  });
});
