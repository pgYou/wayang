import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ClaudeCodeWorker } from '@/services/agents/claude-code-worker';
import type { WorkerConfig, TaskDetail } from '@/types/index';

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

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(() => mockLogger),
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
    return new ClaudeCodeWorker(cfg, tempDir, tempDir, mockLogger as any);
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
});
