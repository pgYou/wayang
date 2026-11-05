/**
 * The DEBUG-off fast path (issue #52): when the level check says debug is
 * disabled, the beforeLLM hook must return BEFORE building any payload —
 * walking the messages (or serializing them) at info level would reintroduce
 * the overhead the fix removes. Proven by spying on the payload builder.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ControllerSignal } from '@/types/index';
import { ControllerAgent } from '@/services/agents/controller-agent';
import type { ControllerAgentState } from '@/services/agents/controller-state';
import { SkillRegistry } from '@/services/skills/registry';
import { mockProvider, createMockCtx } from '@/__tests__/helpers';

vi.mock('../model-factory.js', () => ({
  createModel: () => ({}),
}));
vi.mock('ai', () => ({
  streamText: vi.fn(),
  generateText: vi.fn(),
  stepCountIs: vi.fn((n: number) => n),
  hasToolCall: vi.fn((name: string) => name),
}));
vi.mock('@/services/agents/utils/llm-call-logging', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/services/agents/utils/llm-call-logging')
  >();
  return {
    ...actual,
    buildLlmCallStartPayload: vi.fn(actual.buildLlmCallStartPayload),
  };
});

import { streamText } from 'ai';
import { buildLlmCallStartPayload } from '@/services/agents/utils/llm-call-logging';

function mockStreamResponse(text: string) {
  vi.mocked(streamText).mockReturnValue({
    textStream: (async function* () {
      yield text;
    })(),
    text: Promise.resolve(text),
    reasoningText: Promise.resolve(undefined),
    toolResults: Promise.resolve([]),
    usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
    finishReason: Promise.resolve('stop'),
    steps: Promise.resolve([]),
  } as any);
}

function inputSignal(id: string): ControllerSignal {
  return {
    id,
    source: 'user',
    type: 'input',
    payload: { text: 'hello zero overhead' },
    timestamp: Date.now(),
    status: 'unread',
  };
}

describe('beforeLLM fast path when DEBUG is off (issue #52)', () => {
  let state: any;

  beforeEach(() => {
    state = {
      get: vi.fn((path: string) => (path === 'conversation' ? [] : null)),
      set: vi.fn(),
      append: vi.fn(),
      restore: vi.fn(async () => {}),
    };
    vi.mocked(streamText).mockReset();
    vi.mocked(buildLlmCallStartPayload).mockClear();
    mockStreamResponse('ok');
  });

  it('returns before any payload work when the level check is false', async () => {
    const ctx = createMockCtx();
    // A logger whose level check says "debug is off" — the hook must exit on
    // this alone: no payload builder call, no debug call.
    (ctx.logger as any).isLevelEnabled = vi.fn(() => false);
    (ctx.logger as any).debug = vi.fn();

    const agent = new ControllerAgent(ctx, state as ControllerAgentState, mockProvider, {}, new SkillRegistry([]));
    await agent.run([inputSignal('sig-zero-1')]);

    expect(buildLlmCallStartPayload).not.toHaveBeenCalled();
    expect((ctx.logger as any).debug).not.toHaveBeenCalled();
  });

  it('builds the metadata payload exactly once per turn when debug is on', async () => {
    const ctx = createMockCtx();
    (ctx.logger as any).isLevelEnabled = vi.fn(() => true);
    (ctx.logger as any).debug = vi.fn();

    const agent = new ControllerAgent(ctx, state as ControllerAgentState, mockProvider, {}, new SkillRegistry([]));
    await agent.run([inputSignal('sig-zero-2')]);

    expect(buildLlmCallStartPayload).toHaveBeenCalledTimes(1);
    const args = vi.mocked(buildLlmCallStartPayload).mock.calls[0]!;
    // (messages, messageCount, model)
    expect(Array.isArray(args[0])).toBe(true);
    expect(typeof args[1]).toBe('number');
    expect(args[2]).toBe(mockProvider.modelName);
    expect((ctx.logger as any).debug).toHaveBeenCalledTimes(1);
  });
});
