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
});
