import { describe, it, expect } from 'vitest';
import { conversationToSdkMessages } from '@/services/agents/utils/conversation-to-sdk-messages';
import { buildAssistantEntry } from '@/services/agents/utils/build-assistant-entry';
import { generateId } from '@/utils/id';
import { EEntryType, ESignalSubtype } from '@/types/index';

// --- generateId ---

describe('generateId', () => {
  it('should generate id with correct prefix', () => {
    const id = generateId('t');
    expect(id).toMatch(/^t-\d+-\w+$/);
  });

  it('should generate unique ids', () => {
    const id1 = generateId('w');
    const id2 = generateId('w');
    expect(id1).not.toBe(id2);
  });
});

// --- conversationToSdkMessages ---

describe('conversationToSdkMessages', () => {
  it('should convert user entry', () => {
    const entries = [{
      type: EEntryType.User,
      uuid: 'u1',
      parentUuid: null,
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'Hello' },
    }];

    const msgs = conversationToSdkMessages(entries as any);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('should convert assistant text-only entry', () => {
    const entries = [{
      type: EEntryType.Assistant,
      uuid: 'a1',
      parentUuid: null,
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      message: { role: 'assistant', content: 'Hi there' },
    }];

    const msgs = conversationToSdkMessages(entries as any);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ role: 'assistant', content: 'Hi there' });
  });

  it('should convert assistant entry with tool calls', () => {
    const entries = [{
      type: EEntryType.Assistant,
      uuid: 'a1',
      parentUuid: null,
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      message: { role: 'assistant', content: '' },
      toolCalls: [{
        toolCallId: 'tc1',
        toolName: 'bash',
        arguments: '{"command":"ls"}',
      }],
      toolResults: [{
        toolCallId: 'tc1',
        toolName: 'bash',
        output: { type: 'text', value: 'file.txt' },
      }],
    }];

    const msgs = conversationToSdkMessages(entries as any);
    // assistant message + tool result message
    expect(msgs).toHaveLength(2);
    // Assistant has tool-call parts
    expect(msgs[0].role).toBe('assistant');
    // Tool result
    expect(msgs[1].role).toBe('tool');
  });

  it('should synthesize placeholder results for orphan tool calls', () => {
    const entries = [{
      type: EEntryType.Assistant,
      uuid: 'a1',
      parentUuid: null,
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      message: { role: 'assistant', content: '' },
      toolCalls: [{
        toolCallId: 'tc1',
        toolName: 'bash',
        arguments: '{"command":"ls"}',
      }],
      // No toolResults — simulates aborted step
    }];

    const msgs = conversationToSdkMessages(entries as any);
    expect(msgs).toHaveLength(2);
    const toolMsg = msgs[1] as any;
    expect(toolMsg.role).toBe('tool');
    expect(toolMsg.content[0].output.value).toContain('interrupted');
  });

  it('should skip SystemEntry entries', () => {
    const entries = [{
      type: EEntryType.System,
      uuid: 's1',
      parentUuid: null,
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      subtype: 'compact',
      content: 'Summary...',
    }];

    const msgs = conversationToSdkMessages(entries as any);
    expect(msgs).toHaveLength(0);
  });

  it('should convert SignalEntry to system message', () => {
    const entries = [{
      type: EEntryType.Signal,
      uuid: 'sig1',
      parentUuid: null,
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      subtype: ESignalSubtype.WorkerProgress,
      content: 'Working on it',
      taskId: 't1',
    }];

    const msgs = conversationToSdkMessages(entries as any);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('system');
    expect((msgs[0] as any).content).toContain('PROGRESS SIGNAL');
  });

  it('should strip content for skip_reply tool calls', () => {
    const entries = [{
      type: EEntryType.Assistant,
      uuid: 'a1',
      parentUuid: null,
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      message: { role: 'assistant', content: 'Acknowledged' },
      toolCalls: [{
        toolCallId: 'tc1',
        toolName: 'skip_reply',
        arguments: '{}',
      }],
    }];

    const msgs = conversationToSdkMessages(entries as any);
    // Content should be empty string (stripped), tool call kept
    const assistant = msgs[0] as any;
    expect(assistant.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'tool-call', toolName: 'skip_reply' })]),
    );
    // No text part since content was stripped
    const textParts = Array.isArray(assistant.content)
      ? assistant.content.filter((p: any) => p.type === 'text')
      : [];
    expect(textParts).toHaveLength(0);
  });

  it('should emit reasoning part before text and tool calls', () => {
    const entries = [{
      type: EEntryType.Assistant,
      uuid: 'a1',
      parentUuid: null,
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      message: { role: 'assistant', content: 'Let me look.', reasoning: 'thinking about it' },
      toolCalls: [{
        toolCallId: 'tc1',
        toolName: 'bash',
        arguments: '{"command":"ls"}',
      }],
    }];

    const msgs = conversationToSdkMessages(entries as any);
    const assistant = msgs[0] as any;
    expect(Array.isArray(assistant.content)).toBe(true);
    expect(assistant.content[0]).toEqual({ type: 'reasoning', text: 'thinking about it' });
    expect(assistant.content[1]).toEqual({ type: 'text', text: 'Let me look.' });
    expect(assistant.content[2]).toEqual(expect.objectContaining({ type: 'tool-call', toolName: 'bash' }));
  });

  it('should emit reasoning part for text-only entries', () => {
    const entries = [{
      type: EEntryType.Assistant,
      uuid: 'a1',
      parentUuid: null,
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      message: { role: 'assistant', content: 'Done.', reasoning: 'hmm' },
    }];

    const msgs = conversationToSdkMessages(entries as any);
    const assistant = msgs[0] as any;
    expect(Array.isArray(assistant.content)).toBe(true);
    expect(assistant.content).toEqual([
      { type: 'reasoning', text: 'hmm' },
      { type: 'text', text: 'Done.' },
    ]);
  });

  it('should backfill a placeholder reasoning part for entries without reasoning in a thinking conversation', () => {
    // Regression: the model sometimes skips thinking on a step; replaying that
    // assistant message without reasoning_content makes thinking endpoints
    // (DeepSeek) reject the whole request.
    const entries = [
      {
        type: EEntryType.Assistant,
        uuid: 'a1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: new Date().toISOString(),
        message: { role: 'assistant', content: '', reasoning: 'thought hard' },
        toolCalls: [{
          toolCallId: 'tc1',
          toolName: 'bash',
          arguments: '{"command":"ls"}',
        }],
      },
      {
        type: EEntryType.Assistant,
        uuid: 'a2',
        parentUuid: null,
        sessionId: 's1',
        timestamp: new Date().toISOString(),
        message: { role: 'assistant', content: '好的，稍等。' }, // no reasoning — model skipped thinking
      },
    ];

    const msgs = conversationToSdkMessages(entries as any);
    const noReasoning = msgs.filter((m: any) => m.role === 'assistant')[1] as any;
    expect(noReasoning.content[0]).toEqual({ type: 'reasoning', text: ' ' });
    expect(noReasoning.content[1]).toEqual({ type: 'text', text: '好的，稍等。' });
  });

  it('should NOT backfill reasoning when the conversation has no thinking evidence', () => {
    const entries = [{
      type: EEntryType.Assistant,
      uuid: 'a1',
      parentUuid: null,
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      message: { role: 'assistant', content: 'Hi there' },
    }];

    const msgs = conversationToSdkMessages(entries as any);
    expect(msgs[0]).toEqual({ role: 'assistant', content: 'Hi there' });
  });
});

// --- buildAssistantEntry ---

describe('buildAssistantEntry', () => {
  it('should build entry from text-only event', () => {
    const event = {
      text: 'Hello world',
      reasoningText: undefined,
      toolCalls: [],
      toolResults: [],
      usage: { inputTokens: 10, outputTokens: 20 },
      finishReason: 'stop',
    };

    const entry = buildAssistantEntry(event as any, 's1');
    expect(entry.type).toBe(EEntryType.Assistant);
    expect(entry.message.content).toBe('Hello world');
    expect(entry.message.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
    expect(entry.toolCalls).toBeUndefined();
    expect(entry.toolResults).toBeUndefined();
    expect(entry.sessionId).toBe('s1');
  });

  it('should build entry with tool calls and results', () => {
    const event = {
      text: '',
      toolCalls: [{
        toolCallId: 'tc1',
        toolName: 'bash',
        args: { command: 'ls' },
      }],
      toolResults: [{
        toolCallId: 'tc1',
        toolName: 'bash',
        output: 'file.txt',
      }],
      usage: { inputTokens: 50, outputTokens: 30 },
      finishReason: 'tool-calls',
    };

    const entry = buildAssistantEntry(event as any, 's1');
    expect(entry.toolCalls).toHaveLength(1);
    expect(entry.toolCalls![0].toolName).toBe('bash');
    expect(entry.toolResults).toHaveLength(1);
    expect(entry.toolResults![0].output).toEqual({ type: 'text', value: 'file.txt' });
  });

  it('should use provided uuid', () => {
    const event = { text: 'x', usage: undefined, finishReason: 'stop' };
    const entry = buildAssistantEntry(event as any, 's1', 'custom-uuid');
    expect(entry.uuid).toBe('custom-uuid');
  });

  it('should capture reasoningText when present', () => {
    const event = {
      text: 'ok',
      reasoningText: 'step-by-step thought',
      toolCalls: [],
      toolResults: [],
      usage: undefined,
      finishReason: 'stop',
    };

    const entry = buildAssistantEntry(event as any, 's1');
    expect(entry.message.reasoning).toBe('step-by-step thought');
  });

  it('should fall back to joining reasoning parts when reasoningText is empty', () => {
    const event = {
      text: 'ok',
      reasoningText: undefined,
      reasoning: [{ type: 'reasoning', text: 'part one' }, { type: 'reasoning', text: 'part two' }],
      toolCalls: [],
      toolResults: [],
      usage: undefined,
      finishReason: 'stop',
    };

    const entry = buildAssistantEntry(event as any, 's1');
    expect(entry.message.reasoning).toBe('part one\npart two');
  });

  it('should generate uuid when not provided', () => {
    const event = { text: 'x', usage: undefined, finishReason: 'stop' };
    const entry = buildAssistantEntry(event as any, 's1');
    expect(entry.uuid).toMatch(/^step-/);
  });

  it('should handle tool-error content parts', () => {
    const event = {
      text: '',
      toolCalls: [{
        toolCallId: 'tc1',
        toolName: 'bad_tool',
        args: {},
      }],
      toolResults: [],
      content: [{
        type: 'tool-error',
        toolCallId: 'tc1',
        toolName: 'bad_tool',
        error: { message: 'Schema validation failed' },
      }],
      usage: undefined,
      finishReason: 'tool-calls',
    };

    const entry = buildAssistantEntry(event as any, 's1');
    expect(entry.toolResults).toHaveLength(1);
    expect(entry.toolResults![0].isError).toBe(true);
    expect(entry.toolResults![0].output.value).toContain('Schema validation failed');
  });

  // --- SDK metadata fields (model / usage detail / requestId / stepIndex / timing) ---

  it('should fill model, usage extensions, requestId, stepIndex and timing from SDK fields', () => {
    // Field shapes verified against ai SDK StepResult:
    // model: { provider, modelId }; usage: { inputTokens, outputTokens, totalTokens,
    // inputTokenDetails.cacheReadTokens, outputTokenDetails.reasoningTokens };
    // response: { id, timestamp }; stepNumber (zero-based).
    const event = {
      text: 'ok',
      reasoningText: undefined,
      toolCalls: [],
      toolResults: [],
      content: [],
      usage: {
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
        inputTokenDetails: { cacheReadTokens: 60 },
        outputTokenDetails: { reasoningTokens: 12 },
      },
      finishReason: 'stop',
      stepNumber: 2,
      model: { provider: 'anthropic', modelId: 'claude-sonnet-4' },
      response: { id: 'resp_abc123', timestamp: new Date('2026-10-30T10:00:00Z') },
    };

    const entry = buildAssistantEntry(event as any, 's1');
    expect(entry.model).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' });
    expect(entry.message.usage).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      cachedInputTokens: 60,
      reasoningTokens: 12,
      totalTokens: 140,
    });
    expect(entry.requestId).toBe('resp_abc123');
    expect(entry.stepIndex).toBe(2);
    expect(entry.timing?.startedAt).toBe('2026-10-30T10:00:00.000Z');
    expect(entry.timing?.durationMs).toBeGreaterThanOrEqual(0);
    // Trace ids must never be fabricated when the caller has no context.
    expect(entry.traceId).toBeUndefined();
    expect(entry.spanId).toBeUndefined();
  });

  it('should map deprecated top-level usage fields when token details are absent', () => {
    const event = {
      text: 'ok',
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 4, reasoningTokens: 2 },
      finishReason: 'stop',
    };

    const entry = buildAssistantEntry(event as any, 's1');
    expect(entry.message.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 4,
      reasoningTokens: 2,
    });
  });

  it('should omit metadata fields when the SDK event does not provide them', () => {
    const event = {
      text: 'hi',
      usage: { inputTokens: 5, outputTokens: 6 },
      finishReason: 'stop',
    };

    const entry = buildAssistantEntry(event as any, 's1');
    expect(entry.message.usage).toEqual({ inputTokens: 5, outputTokens: 6 });
    expect(entry.model).toBeUndefined();
    expect(entry.requestId).toBeUndefined();
    expect(entry.stepIndex).toBeUndefined();
    expect(entry.timing?.startedAt).toBeUndefined();
    expect(entry.traceId).toBeUndefined();
    expect(entry.spanId).toBeUndefined();
  });

  it('should accept caller-provided timing and trace ids via optional extras', () => {
    const event = {
      text: 'hi',
      usage: { inputTokens: 5, outputTokens: 6 },
      finishReason: 'stop',
    };

    const entry = buildAssistantEntry(event as any, 's1', 'step-uuid-1', {
      startedAt: '2026-10-30T10:00:00.000Z',
      endedAt: '2026-10-30T10:00:05.000Z',
      firstTokenAt: '2026-10-30T10:00:01.000Z',
      traceId: 'trace-42',
      spanId: 'span-42',
    });
    expect(entry.uuid).toBe('step-uuid-1');
    expect(entry.timing).toEqual({
      startedAt: '2026-10-30T10:00:00.000Z',
      firstTokenAt: '2026-10-30T10:00:01.000Z',
      endedAt: '2026-10-30T10:00:05.000Z',
      durationMs: 5000,
    });
    expect(entry.traceId).toBe('trace-42');
    expect(entry.spanId).toBe('span-42');
  });

  it('should backfill temperature/maxOutputTokens from extras into the model section', () => {
    const event = {
      text: 'hi',
      usage: { inputTokens: 5, outputTokens: 6 },
      finishReason: 'stop',
      model: { provider: 'openai-compatible', modelId: 'fake-model' },
    };

    const entry = buildAssistantEntry(event as any, 's1', undefined, {
      temperature: 0.2,
      maxOutputTokens: 4096,
    });
    expect(entry.model).toEqual({
      provider: 'openai-compatible',
      model: 'fake-model',
      temperature: 0.2,
      maxOutputTokens: 4096,
    });
  });

  it('should create the model section from config extras alone when the SDK event has none', () => {
    const event = { text: 'hi', usage: { inputTokens: 5, outputTokens: 6 }, finishReason: 'stop' };
    const entry = buildAssistantEntry(event as any, 's1', undefined, { temperature: 0.7 });
    expect(entry.model).toEqual({ temperature: 0.7 });
  });

  it('should omit temperature/maxOutputTokens entirely when neither source provides them', () => {
    const event = {
      text: 'hi',
      usage: { inputTokens: 5, outputTokens: 6 },
      finishReason: 'stop',
      model: { provider: 'anthropic', modelId: 'claude-sonnet-4' },
    };
    const entry = buildAssistantEntry(event as any, 's1');
    expect(entry.model).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' });
  });

  it('should prefer the SDK response.timestamp over the caller-provided startedAt', () => {
    const event = {
      text: 'hi',
      usage: { inputTokens: 5, outputTokens: 6 },
      finishReason: 'stop',
      response: { id: 'resp_ts', timestamp: new Date('2026-10-30T09:00:00Z') },
    };
    const entry = buildAssistantEntry(event as any, 's1', undefined, {
      startedAt: '2026-10-30T10:00:00.000Z',
    });
    expect(entry.timing?.startedAt).toBe('2026-10-30T09:00:00.000Z');
  });

  it('should still work with the pre-extras call signatures', () => {
    const event = { text: 'legacy', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' };
    // Two-arg form
    const twoArg = buildAssistantEntry(event as any, 's1');
    expect(twoArg.type).toBe(EEntryType.Assistant);
    expect(twoArg.sessionId).toBe('s1');
    // Three-arg form (uuid, no extras)
    const threeArg = buildAssistantEntry(event as any, 's1', 'fixed-uuid');
    expect(threeArg.uuid).toBe('fixed-uuid');
    expect(threeArg.timing).toEqual({ endedAt: expect.any(String) });
  });
});

// --- buildAssistantEntry: recorded tool execution metadata ---

describe('buildAssistantEntry: recorded tool calls', () => {
  it('merges recorder data (taskId / status / timing) into tool calls and results', async () => {
    const { ToolCallRecorder } = await import('@/services/agents/utils/tool-call-recorder');
    const rec = new ToolCallRecorder();
    rec.start('tc1', 'add_task');
    rec.finish('tc1', 'succeeded');
    rec.attachTask('tc1', 't-42');

    const event = {
      text: '',
      toolCalls: [{ toolCallId: 'tc1', toolName: 'add_task', args: { title: 'T' } }],
      toolResults: [{ toolCallId: 'tc1', toolName: 'add_task', output: 'Task t-42 added' }],
      usage: undefined,
      finishReason: 'tool-calls',
    };

    const entry = buildAssistantEntry(event as any, 's1', undefined, {
      recordedToolCalls: (id) => rec.lookup(id),
    });
    // Async dispatch semantics: the call stays 'running' with the task id.
    expect(entry.toolCalls![0]).toMatchObject({
      toolCallId: 'tc1', taskId: 't-42', status: 'running',
    });
    expect(entry.toolCalls![0].startedAt).toBeTruthy();
    expect(entry.toolCalls![0].endedAt).toBeTruthy();
    expect(entry.toolResults![0]).toMatchObject({ toolCallId: 'tc1', status: 'running' });
    expect(entry.toolResults![0].startedAt).toBeTruthy();
  });

  it('marks SDK tool-error parts as failed with an error type', () => {
    const event = {
      text: '',
      toolCalls: [{ toolCallId: 'tc1', toolName: 'bad_tool', args: {} }],
      toolResults: [],
      content: [{ type: 'tool-error', toolCallId: 'tc1', toolName: 'bad_tool', error: { message: 'nope' } }],
      usage: undefined,
      finishReason: 'tool-calls',
    };
    const entry = buildAssistantEntry(event as any, 's1');
    expect(entry.toolResults![0].status).toBe('failed');
    expect(entry.toolResults![0].errorType).toBe('ToolInputValidationError');
  });
});
