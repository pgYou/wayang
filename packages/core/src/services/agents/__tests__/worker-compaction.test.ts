// Worker-side context compaction (issue #90): threshold behaviour, the
// mid-run compaction point, tool-call/result pairing after a compaction, the
// truncation fallback and the per-run compaction cap.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ModelMessage } from 'ai';
import { WorkerAgent } from '@/services/agents/worker-agent';
import { SkillRegistry } from '@/services/skills/registry';
import { createMockCtx, mockModel } from '@/__tests__/helpers';
import { EEntryType, ESystemSubtype } from '@/types/index';
import type { SystemEntry } from '@/types/conversation';

const skills = new SkillRegistry([]);

vi.mock('../model-factory.js', () => ({
  createModel: () => ({}),
}));

vi.mock('ai', () => ({
  streamText: vi.fn(),
  generateText: vi.fn(),
  stepCountIs: vi.fn((n: number) => n),
  hasToolCall: vi.fn((name: string) => name),
  tool: vi.fn((def: any) => def),
}));

import { streamText, generateText } from 'ai';

/** Threshold = 60% of 200k = 120k; BIG usage is above it, SMALL is far below. */
const WINDOW = 200_000;
const BIG = { inputTokens: 150_000, outputTokens: 5 };
const SMALL = { inputTokens: 1_000, outputTokens: 5 };

/** ~5k estimated tokens per assistant step, so the 8k-16k retained-zone budget triggers. */
const CHUNK = 'x'.repeat(20_000);

const model = { ...mockModel, contextWindowTokens: WINDOW };

interface StepSpec {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  toolCalls?: Array<{ toolCallId: string; toolName: string; args?: unknown }>;
  toolResults?: Array<{ toolCallId: string; toolName: string; output: unknown }>;
  /** Call done(summary) as the step's tool, like the real loop would. */
  done?: string;
}

interface Captured {
  /** Request messages of every step, after prepareStep. */
  requests: ModelMessage[][];
  /** Request system prompt of every step, after prepareStep. */
  systems: Array<string | undefined>;
}

/**
 * Fake SDK step loop: mirrors the real one closely enough for compaction —
 * prepareStep runs before each request (awaited, so the async compaction
 * path is exercised) and onStepFinish fires after the step's tools ran.
 */
function mockStepLoop(worker: WorkerAgent, steps: StepSpec[]): Captured {
  const captured: Captured = { requests: [], systems: [] };

  vi.mocked(streamText).mockImplementation(((streamOpts: any) => {
    let lastText = '';
    const run = (async () => {
      const responseMessages: ModelMessage[] = [];
      for (const [i, spec] of steps.entries()) {
        const stepInput: ModelMessage[] = [...streamOpts.messages, ...responseMessages];
        const prep = await streamOpts.prepareStep?.({
          messages: stepInput,
          steps: [],
          stepNumber: i,
          model: {},
          experimental_context: undefined,
        });
        captured.requests.push(prep?.messages ?? stepInput);
        captured.systems.push(prep?.system ?? streamOpts.system);
        if (spec.done !== undefined) {
          worker.complete(spec.done);
        }
        streamOpts.onStepFinish?.({
          text: spec.text,
          usage: spec.usage,
          finishReason: spec.done !== undefined ? 'tool-calls' : 'stop',
          ...(spec.toolCalls !== undefined && { toolCalls: spec.toolCalls }),
          ...(spec.toolResults !== undefined && { toolResults: spec.toolResults }),
        });
        responseMessages.push({ role: 'assistant', content: spec.text });
        lastText = spec.text;
        if (spec.done !== undefined) break;
      }
    })();

    return {
      textStream: (async function* () { await run; yield lastText; })(),
      text: (async () => { await run; return lastText; })(),
      reasoningText: (async () => { await run; return undefined; })(),
      toolResults: (async () => { await run; return []; })(),
      usage: (async () => { await run; return steps[0]?.usage ?? { inputTokens: 0, outputTokens: 0 }; })(),
      finishReason: (async () => { await run; return 'stop'; })(),
      steps: (async () => { await run; return steps.map(() => ({})); })(),
    } as any;
  }) as any);

  return captured;
}

function task(id: string, description: string) {
  return {
    id, title: `Task ${id}`, description, workerId: `w-${id}`,
    priority: 'normal' as const, status: 'running' as const, createdAt: Date.now(),
  };
}

function compactMarkers(worker: WorkerAgent): SystemEntry[] {
  return worker.getConversation().filter(
    (e): e is SystemEntry => e.type === EEntryType.System && e.subtype === ESystemSubtype.Compact,
  );
}

describe('WorkerAgent context compaction (issue #90)', () => {
  let tempDir: string;
  let ctx: ReturnType<typeof createMockCtx>;

  beforeEach(() => {
    vi.mocked(streamText).mockReset();
    vi.mocked(generateText).mockReset();
    tempDir = mkdtempSync(join(tmpdir(), 'wayang-wcmp-'));
    ctx = createMockCtx({ sessionDir: tempDir });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const newWorker = () => new WorkerAgent(model, ctx, skills);

  it('a) does not compact while the reported usage stays under the threshold', async () => {
    const worker = newWorker();
    const captured = mockStepLoop(worker, [
      { text: 's0', usage: SMALL },
      { text: 's1', usage: SMALL },
      { text: 'done', usage: SMALL, done: 'finished quietly' },
    ]);

    const result = await worker.run(task('a', 'small task'), {});

    expect(result).toEqual({ status: 'completed', summary: 'finished quietly' });
    expect(generateText).not.toHaveBeenCalled();
    expect(compactMarkers(worker)).toHaveLength(0);
    // No compaction → no step override: every request is the plain SDK history.
    expect(captured.requests.map((m) => m.length)).toEqual([1, 2, 3]);
    expect(captured.systems.every((s) => s === captured.systems[0])).toBe(true);
    // Real usage is published on the worker state.
    const usage = worker.getState().get<any>('dynamicState.contextUsage');
    expect(usage.source).toBe('usage');
    expect(usage.usedTokens).toBe(SMALL.inputTokens);
    expect(usage.contextWindowTokens).toBe(WINDOW);
    expect(usage.ratio).toBeCloseTo(SMALL.inputTokens / WINDOW, 10);
  });

  it('b) compacts once past the threshold and keeps running to done with the summary in the message flow', async () => {
    const worker = newWorker();
    vi.mocked(generateText).mockResolvedValue({ text: 'SUMMARY: half of the task is done' } as any);
    const captured = mockStepLoop(worker, [
      { text: CHUNK, usage: BIG },
      { text: CHUNK, usage: BIG },
      { text: CHUNK, usage: BIG },
      { text: 'done', usage: SMALL, done: 'finished after compaction' },
    ]);

    const result = await worker.run(task('b', 'the task prompt'), {});

    expect(result).toEqual({ status: 'completed', summary: 'finished after compaction' });
    expect(generateText).toHaveBeenCalledTimes(1);

    // The compact marker carries the summarized token count and is persisted
    // to the worker's append-only conversation file.
    const markers = compactMarkers(worker);
    expect(markers).toHaveLength(1);
    expect(markers[0]!.compactMeta?.summarizedTokenCount).toBeGreaterThan(0);
    const jsonl = readFileSync(join(tempDir, 'workers', worker.id, 'conversation.jsonl'), 'utf8');
    expect(jsonl).toContain('"subtype":"compact"');
    expect(jsonl).toContain('summarizedTokenCount');

    // Step 3 runs on the compacted context. The summary is a user entry in
    // the message flow (never the system prompt), right after the retained
    // history; the request still opens with the seeded continuation turn
    // carrying the CURRENT task description.
    expect(captured.systems[3]).not.toContain('[Conversation Summary]');
    const request = captured.requests[3]!;
    expect(request[0]).toMatchObject({ role: 'user' });
    expect((request[0] as any).content).toContain('[Conversation compacted]');
    expect((request[0] as any).content).toContain('[Current task]');
    expect((request[0] as any).content).toContain('the task prompt');
    expect((request[0] as any).content).toContain('summary of completed work is the user message that begins with [Conversation Summary]');
    expect((request[0] as any).content).toContain('do not re-run an operation that already succeeded');
    expect(request[request.length - 2]).toMatchObject({ role: 'system' });
    expect((request[request.length - 2] as any).content).toContain('[Context compacted]');
    expect(request[request.length - 1]).toMatchObject({ role: 'user' });
    expect((request[request.length - 1] as any).content).toContain('SUMMARY: half of the task is done');

    // The summary was built from the pre-compaction conversation — minus the
    // current task description, which is re-injected verbatim instead.
    const prompt = (vi.mocked(generateText).mock.calls[0]![0] as any).prompt as string;
    expect(prompt).not.toContain('the task prompt');
  });

  it('c) keeps tool call/result pairs intact on the rebuilt post-compaction request', async () => {
    const worker = newWorker();
    vi.mocked(generateText).mockResolvedValue({ text: 'SUMMARY' } as any);
    const captured = mockStepLoop(worker, [
      { text: CHUNK, usage: BIG },
      { text: CHUNK, usage: BIG },
      { text: CHUNK, usage: BIG },
      {
        text: '',
        usage: SMALL,
        toolCalls: [{ toolCallId: 'c-1', toolName: 'read_file', args: { path: 'a.ts' } }],
        toolResults: [{ toolCallId: 'c-1', toolName: 'read_file', output: { type: 'text', value: 'file body' } }],
      },
      { text: 'done', usage: SMALL, done: 'paired' },
    ]);

    const result = await worker.run(task('c', 'tool task'), {});

    expect(result).toEqual({ status: 'completed', summary: 'paired' });
    expect(generateText).toHaveBeenCalledTimes(1);

    const request = captured.requests[4]!;
    const callIds = new Set<string>();
    const resultIds = new Set<string>();
    for (const message of request) {
      if (message.role === 'assistant' && Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === 'tool-call') callIds.add(part.toolCallId);
        }
      }
      if (message.role === 'tool') {
        for (const part of message.content) {
          if (part.type === 'tool-result') resultIds.add(part.toolCallId);
        }
      }
    }
    expect(callIds.has('c-1')).toBe(true);
    expect(resultIds.has('c-1')).toBe(true);
    // No orphaned call survives the compaction boundary.
    expect([...callIds].every((id) => resultIds.has(id))).toBe(true);
  });

  it('d) degrades to half-truncation when the summarizer fails, logs it, and still finishes', async () => {
    const worker = newWorker();
    vi.mocked(generateText).mockRejectedValue(new Error('provider down'));
    mockStepLoop(worker, [
      { text: CHUNK, usage: BIG },
      { text: CHUNK, usage: BIG },
      { text: CHUNK, usage: BIG },
      { text: CHUNK, usage: BIG },
      { text: 'done', usage: SMALL, done: 'finished after fallback' },
    ]);

    const result = await worker.run(task('d', 'fallback task'), {});

    expect(result).toEqual({ status: 'completed', summary: 'finished after fallback' });
    // Summarizer failed → no marker, history halved in memory, task not aborted.
    expect(compactMarkers(worker)).toHaveLength(0);
    // 5 entries at compaction time → 2 kept, then the final step appends 1.
    expect(worker.getConversation()).toHaveLength(3);
    const warns = vi.mocked(ctx.logger.warn).mock.calls.map((c) => String(c[1]));
    expect(warns.some((m) => m.includes('Compaction failed, falling back to half-truncation'))).toBe(true);
    expect(warns.some((m) => m.includes('Compaction summarizer failed'))).toBe(true);
  });

  it('e) caps compactions at 5 per run and degrades to truncation past the cap', async () => {
    const worker = newWorker();
    vi.mocked(generateText).mockResolvedValue({ text: 'SUMMARY' } as any);
    const steps: StepSpec[] = Array.from({ length: 12 }, () => ({ text: CHUNK, usage: BIG }));
    steps.push({ text: 'done', usage: SMALL, done: 'finished at the cap' });
    mockStepLoop(worker, steps);

    const result = await worker.run(task('e', 'runaway task'), {});

    expect(result).toEqual({ status: 'completed', summary: 'finished at the cap' });
    // The summarizer runs at most MAX_COMPACTIONS_PER_RUN times, then only
    // truncation is left — the run cannot loop on compaction.
    expect(generateText).toHaveBeenCalledTimes(5);
    const warns = vi.mocked(ctx.logger.warn).mock.calls.map((c) => String(c[1]));
    expect(warns.some((m) => m.includes('Compaction limit reached'))).toBe(true);
  });

  it('f) a reused worker keeps the second task description when the second stage compacts on its first step', async () => {
    const worker = newWorker();
    vi.mocked(generateText).mockResolvedValue({ text: 'SUMMARY' } as any);
    // Stage 1 fills the context and compacts; its last step reports BIG usage
    // so stage 2 is already full before its first request.
    mockStepLoop(worker, [
      { text: CHUNK, usage: BIG },
      { text: CHUNK, usage: BIG },
      { text: CHUNK, usage: BIG },
      { text: 'done stage 1', usage: BIG, done: 'stage 1 done' },
    ]);
    await worker.run(task('stage1', 'FIRST stage task'), {});

    // Stage 2 on the SAME instance: prepareStep(0) compacts before the model
    // has produced anything. The task description must still reach the model.
    vi.mocked(generateText).mockClear();
    const captured = mockStepLoop(worker, [
      { text: 's0-2', usage: SMALL },
      { text: 'done stage 2', usage: SMALL, done: 'stage 2 done' },
    ]);
    const result = await worker.run(task('stage2', 'SECOND stage task: write the report'), {});

    expect(result).toEqual({ status: 'completed', summary: 'stage 2 done' });
    const request = JSON.stringify(captured.requests[0]);
    expect(request).toContain('SECOND stage task: write the report');
    expect(request).toContain('[Current task]');
    // The description was excluded from the summarizer input (it is re-injected
    // instead), so the summary cannot paraphrase it away.
    const prompt = (vi.mocked(generateText).mock.calls[0]![0] as any).prompt as string;
    expect(prompt).not.toContain('SECOND stage task: write the report');
  });

  it('g) a hung summarizer times out, degrades to half-truncation and the task still finishes', async () => {
    vi.useFakeTimers();
    try {
      const worker = newWorker();
      // A summarizer call that never resolves on its own: it only rejects when
      // the per-attempt AbortController fires.
      vi.mocked(generateText).mockImplementation(((opts: any) =>
        new Promise((_, reject) => {
          opts.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as any);
      mockStepLoop(worker, [
        { text: CHUNK, usage: BIG },
        { text: CHUNK, usage: BIG },
        { text: CHUNK, usage: BIG },
        { text: CHUNK, usage: BIG },
        { text: 'done', usage: SMALL, done: 'finished after timeout' },
      ]);

      const runPromise = worker.run(task('g', 'timeout task'), {});
      // Let the first steps run until the compaction call actually schedules
      // its timer, then keep firing every 60 s attempt timer (a later step may
      // start another compaction) until none is left.
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 10 && vi.getTimerCount() > 0; i += 1) {
        await vi.advanceTimersByTimeAsync(60_000);
      }
      const result = await runPromise;

      expect(result).toEqual({ status: 'completed', summary: 'finished after timeout' });
      // Timeout → summarizer failure → truncation fallback, never a hang.
      expect(compactMarkers(worker)).toHaveLength(0);
      const warns = vi.mocked(ctx.logger.warn).mock.calls.map((c) => String(c[1]));
      expect(warns.some((m) => m.includes('Compaction summarizer timed out'))).toBe(true);
      expect(warns.some((m) => m.includes('Compaction failed, falling back to half-truncation'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
