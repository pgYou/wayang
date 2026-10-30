import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { WorkerAgent } from '@/services/agents/worker-agent';
import { SkillRegistry } from '@/services/skills/registry';
import { mockProvider, createMockCtx } from '@/__tests__/helpers';
import { EEntryType } from '@/types/index';

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
