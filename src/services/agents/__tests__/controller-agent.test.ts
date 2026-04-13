import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ControllerAgent } from '@/services/agents/controller-agent';
import type { ControllerAgentState } from '@/services/agents/controller-state';
import type { ControllerSignal } from '@/types/index';
import { mockProvider, createMockCtx } from '@/__tests__/helpers';

// Mock model-factory to avoid real SDK calls
vi.mock('../model-factory.js', () => ({
  createModel: () => ({}),
}));

// Mock streamText to avoid real LLM calls
vi.mock('ai', () => ({
  streamText: vi.fn(),
  stepCountIs: vi.fn((n: number) => n),
  hasToolCall: vi.fn((name: string) => name),
}));

import { streamText } from 'ai';

function createMockState(): any {
  const data: Record<string, any> = {
    conversation: [],
    'runtimeState.activeWorkers': [],
  };
  return {
    get: vi.fn((path: string) => data[path] ?? null),
    set: vi.fn((path: string, value: any) => { data[path] = value; }),
    append: vi.fn((path: string, entry: any) => {
      data[path] = data[path] ?? [];
      data[path].push(entry);
    }),
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
    agent = new ControllerAgent(
      createMockCtx(),
      state as ControllerAgentState,
      mockProvider,
      {}, // tools
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
});
