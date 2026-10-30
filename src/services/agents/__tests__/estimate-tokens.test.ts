import { describe, it, expect } from 'vitest';
import { estimateTokens, estimateConversationTokens } from '@/services/agents/utils/estimate-tokens';
import { EEntryType } from '@/types/conversation';

describe('estimateTokens', () => {
  it('should return 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('should estimate ~1 token per 4 chars', () => {
    expect(estimateTokens('hello')).toBe(2); // 5/4 rounded up
    expect(estimateTokens('a'.repeat(100))).toBe(25);
    expect(estimateTokens('a'.repeat(8))).toBe(2);
  });
});

describe('estimateConversationTokens', () => {
  it('should return 0 for empty array', () => {
    expect(estimateConversationTokens([])).toBe(0);
  });

  it('should estimate tokens for user entries', () => {
    const entries = [
      { type: EEntryType.User, message: { content: 'Hello world' } },
    ];
    expect(estimateConversationTokens(entries)).toBeGreaterThan(0);
  });

  it('should estimate tokens for assistant entries with tool calls', () => {
    const entries = [
      {
        type: EEntryType.Assistant,
        message: { content: 'Let me check the files.' },
        toolCalls: [{ toolCallId: 'tc1', toolName: 'bash', arguments: '{"command": "ls"}' }],
        toolResults: [{ toolCallId: 'tc1', toolName: 'bash', output: { type: 'text', value: 'file1.txt\nfile2.txt' } }],
      },
    ];
    const tokens = estimateConversationTokens(entries);
    expect(tokens).toBeGreaterThan(0);
  });

  it('should estimate tokens for system entries', () => {
    const entries = [
      { type: EEntryType.System, content: 'Compact summary text' },
    ];
    expect(estimateConversationTokens(entries)).toBeGreaterThan(0);
  });

  it('should estimate tokens for signal entries', () => {
    const entries = [
      { type: EEntryType.Signal, content: 'Worker completed task' },
    ];
    expect(estimateConversationTokens(entries)).toBeGreaterThan(0);
  });
});

describe('estimateConversationTokens: SDK ModelMessage content arrays', () => {
  it('counts text, reasoning, tool-call input and tool-result output parts', () => {
    const args = { command: 'x'.repeat(400) };
    const output = 'y'.repeat(800);
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'r'.repeat(40) },
          { type: 'text', text: 't'.repeat(40) },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'bash', input: args },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'bash', output: { type: 'text', value: output } }],
      },
    ];
    const expected =
      estimateTokens('r'.repeat(40)) +
      estimateTokens('t'.repeat(40)) +
      estimateTokens(JSON.stringify(args)) +
      estimateTokens(output);
    expect(estimateConversationTokens(messages)).toBe(expected);
  });

  it('never stringifies array content to "[object Object]"', () => {
    const messages = [{ role: 'tool', content: [{ type: 'tool-result', output: { type: 'text', value: '' } }] }];
    // Old behavior counted String([{...}]) = "[object Object]" → 4 tokens.
    expect(estimateConversationTokens(messages)).toBe(0);
  });
});
