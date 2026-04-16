import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkerAgent } from '@/services/agents/worker-agent';
import { mockProvider, createMockCtx } from '@/__tests__/helpers';

// Mock model-factory to avoid real SDK calls
vi.mock('../model-factory.js', () => ({
  createModel: () => ({}),
}));

// Mock streamText
vi.mock('ai', () => ({
  streamText: vi.fn(),
  stepCountIs: vi.fn((n: number) => n),
  hasToolCall: vi.fn((name: string) => name),
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
    const w1 = new WorkerAgent(mockProvider, createMockCtx());
    const w2 = new WorkerAgent(mockProvider, createMockCtx());
    expect(w1.id).not.toBe(w2.id);
  });

  it('should return completed result via complete() callback', () => {
    const worker = new WorkerAgent(mockProvider, createMockCtx());
    worker.complete('All done successfully');
    expect(worker['_terminalResult']).toEqual({ status: 'completed', summary: 'All done successfully' });
  });

  it('should return failed result via fail() callback', () => {
    const worker = new WorkerAgent(mockProvider, createMockCtx());
    worker.fail('Something went wrong');
    expect(worker['_terminalResult']).toEqual({ status: 'failed', error: 'Something went wrong' });
  });

  it('should return stream text when max steps reached without done/fail', async () => {
    mockStreamResponse('some text without calling done');

    const worker = new WorkerAgent(mockProvider, createMockCtx());
    const result = await worker.run(
      { id: 't-5', title: 'test', description: 'test', workerId: 'w-5', priority: 'normal', status: 'running', createdAt: Date.now() },
      {},
    );

    expect(result.status).toBe('completed');
    expect(result.summary).toBe('some text without calling done');
  });

  it('should return failed when abort signal is already set before run', async () => {
    mockStreamResponse('');

    const worker = new WorkerAgent(mockProvider, createMockCtx());
    worker.abort();

    const result = await worker.run(
      { id: 't-6', title: 'test', description: 'test', workerId: 'w-6', priority: 'normal', status: 'running', createdAt: Date.now() },
      {},
    );

    expect(result.status).toBe('failed');
    expect(result.error).toBe('Aborted');
  });

  it('should return terminal result when complete() called via done tool', async () => {
    const worker = new WorkerAgent(mockProvider, createMockCtx());

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
});
