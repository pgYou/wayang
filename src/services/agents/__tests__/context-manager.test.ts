import { describe, it, expect, vi } from 'vitest';
import { ContextManager, RECENT_TOKEN_BUDGET } from '@/services/agents/context-manager';
import { EEntryType, ESystemSubtype } from '@/types/index';
import { estimateTokens, extractContentText } from '@/services/agents/utils/estimate-tokens';

/** Minimal state stub — ContextManager only needs get/append. */
function createMockState(conversation: any[] = []) {
  const data: Record<string, any> = {
    conversation,
    runtimeState: { session: { id: 's-cm' } },
  };
  return {
    get: vi.fn((path: string) => data[path] ?? null),
    set: vi.fn((path: string, value: any) => { data[path] = value; }),
    append: vi.fn((path: string, entry: any) => { data[path].push(entry); }),
  } as any;
}

const makeUser = (uuid: string, content: string) => ({
  type: EEntryType.User,
  uuid,
  parentUuid: null,
  sessionId: 's-cm',
  timestamp: new Date().toISOString(),
  message: { role: 'user' as const, content },
});

describe('ContextManager', () => {
  it('should export RECENT_TOKEN_BUDGET', () => {
    expect(RECENT_TOKEN_BUDGET).toBe(20_000);
  });

  describe('restoreCompact', () => {
    it('should include the summary in getSystemPrompt under [Conversation Summary]', () => {
      const cm = new ContextManager(createMockState(), 'STATIC PROMPT');
      cm.restoreCompact('the restored summary');

      const prompt = cm.getSystemPrompt();
      expect(prompt).toContain('STATIC PROMPT');
      expect(prompt).toContain('[Conversation Summary]');
      expect(prompt).toContain('the restored summary');
    });

    it('should return the summary system message as the first message', () => {
      const conversation = [makeUser('u1', 'recent message')];
      const cm = new ContextManager(createMockState(conversation), 'STATIC PROMPT');
      cm.restoreCompact('the restored summary');

      const messages = cm.getMessages();
      expect(messages[0]).toEqual({
        role: 'system',
        content: '[Conversation Summary]\nthe restored summary',
      });
    });

    it('should treat the whole in-memory conversation as the verbatim zone', () => {
      // After the state layer slices the window, compactStartIdx must be 0:
      // every entry in memory is sent verbatim alongside the summary.
      const conversation = [makeUser('u1', 'one'), makeUser('u2', 'two'), makeUser('u3', 'three')];
      const cm = new ContextManager(createMockState(conversation), 'STATIC PROMPT');
      cm.restoreCompact('summary');

      const messages = cm.getMessages();
      // [summary system msg] + all three user entries
      expect(messages).toHaveLength(4);
      expect(messages[1]).toMatchObject({ role: 'user', content: 'one' });
      expect(messages[2]).toMatchObject({ role: 'user', content: 'two' });
      expect(messages[3]).toMatchObject({ role: 'user', content: 'three' });
    });

    it('should expose the summary via getCompactSummary', () => {
      const cm = new ContextManager(createMockState(), 'STATIC PROMPT');
      expect(cm.getCompactSummary()).toBeNull();
      cm.restoreCompact('restored');
      expect(cm.getCompactSummary()).toBe('restored');
    });
  });

  describe('compact', () => {
    it('should append a compact marker entry carrying compactMeta', async () => {
      const state = createMockState([
        makeUser('u1', 'hello'),
        makeUser('u2', 'world'),
        makeUser('u3', 'foo'),
        makeUser('u4', 'bar'),
      ]);
      const cm = new ContextManager(state, 'STATIC PROMPT');

      await cm.compact(async () => 'fresh summary');

      expect(state.append).toHaveBeenCalledTimes(1);
      const marker = state.append.mock.calls[0][1];
      expect(marker.type).toBe(EEntryType.System);
      expect(marker.subtype).toBe(ESystemSubtype.Compact);
      expect(marker.content).toBe('fresh summary');
      expect(marker.compactMeta).toBeDefined();
      expect(marker.compactMeta.summarizedTokenCount).toBeGreaterThan(0);
      expect(cm.getCompactSummary()).toBe('fresh summary');
    });

    it('should stamp startedAt/endedAt and pass model into the marker compactMeta', async () => {
      const state = createMockState([
        makeUser('u1', 'hello'),
        makeUser('u2', 'world'),
        makeUser('u3', 'foo'),
        makeUser('u4', 'bar'),
      ]);
      const cm = new ContextManager(state, 'STATIC PROMPT');

      await cm.compact(async () => 'summarized', { model: 'test-model' });

      const marker = state.append.mock.calls[0][1];
      expect(marker.compactMeta.model).toBe('test-model');
      expect(marker.compactMeta.createdAt).toEqual(expect.any(String));
      // Point-in-time event: startedAt/endedAt share the recording moment.
      expect(marker.startedAt).toBe(marker.timestamp);
      expect(marker.endedAt).toBe(marker.timestamp);
      expect(marker.compactMeta.createdAt).toBe(marker.timestamp);
    });

    it('should omit compactMeta.model when no model is provided', async () => {
      const state = createMockState([
        makeUser('u1', 'hello'),
        makeUser('u2', 'world'),
        makeUser('u3', 'foo'),
        makeUser('u4', 'bar'),
      ]);
      const cm = new ContextManager(state, 'STATIC PROMPT');

      await cm.compact(async () => 'summarized');

      const marker = state.append.mock.calls[0][1];
      expect(marker.compactMeta.model).toBeUndefined();
    });

    it('should set the verbatim zone start to the pre-compaction length', async () => {
      const conversation = [
        makeUser('u1', 'hello'),
        makeUser('u2', 'world'),
        makeUser('u3', 'foo'),
        makeUser('u4', 'bar'),
      ];
      const state = createMockState(conversation);
      const cm = new ContextManager(state, 'STATIC PROMPT');

      await cm.compact(async () => 'fresh summary');

      // Marker appended at index 4 — entries before it must NOT be re-sent.
      const messages = cm.getMessages();
      expect(messages[0]).toEqual({
        role: 'system',
        content: '[Conversation Summary]\nfresh summary',
      });
      // Only the marker follows, and system entries are skipped in conversion
      expect(messages).toHaveLength(1);

      // A new entry appended after compaction IS sent verbatim
      state.append('conversation', makeUser('u5', 'after compaction'));
      const messagesAfter = cm.getMessages();
      expect(messagesAfter).toHaveLength(2);
      expect(messagesAfter[1]).toMatchObject({ role: 'user', content: 'after compaction' });
    });
  });

  describe('context usage accessors', () => {
    it('should return the injected maxTokens', () => {
      const cm = new ContextManager(createMockState(), 'STATIC PROMPT', 42_000);
      expect(cm.getMaxTokens()).toBe(42_000);
    });

    it('should default maxTokens to 100k when not injected', () => {
      const cm = new ContextManager(createMockState(), 'STATIC PROMPT');
      expect(cm.getMaxTokens()).toBe(100_000);
    });

    it('should count the system prompt even with an empty conversation', () => {
      const cm = new ContextManager(createMockState(), 'STATIC PROMPT');
      expect(cm.getEstimatedTokens()).toBeGreaterThan(0);
    });

    it('should grow the estimate as the conversation grows', () => {
      const conversation: any[] = [];
      const state = createMockState(conversation);
      const cm = new ContextManager(state, 'STATIC PROMPT');
      const before = cm.getEstimatedTokens();
      for (let i = 0; i < 5; i++) {
        state.append('conversation', makeUser(`u-grow-${i}`, 'x'.repeat(400)));
      }
      const after = cm.getEstimatedTokens();
      expect(after).toBeGreaterThan(before);
    });

    it('should not mutate the conversation or append entries when estimating', () => {
      const conversation = [makeUser('u-est-1', 'hello')];
      const state = createMockState(conversation);
      const cm = new ContextManager(state, 'STATIC PROMPT');
      cm.getEstimatedTokens();
      cm.getEstimatedTokens();
      expect(state.append).not.toHaveBeenCalled();
      expect(conversation).toHaveLength(1);
    });
  });

  describe('getContextBreakdown', () => {
    const makeAssistant = (uuid: string, opts: {
      content?: string;
      reasoning?: string;
      toolArgs?: string;
      toolOutput?: string;
    } = {}) => ({
      type: EEntryType.Assistant,
      uuid,
      parentUuid: null,
      sessionId: 's-cm',
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant' as const,
        content: opts.content ?? '',
        ...(opts.reasoning !== undefined && { reasoning: opts.reasoning }),
      },
      ...(opts.toolArgs !== undefined && {
        toolCalls: [{ toolCallId: `tc-${uuid}`, toolName: 'read_file', arguments: opts.toolArgs }],
      }),
      ...(opts.toolOutput !== undefined && {
        toolResults: [{
          toolCallId: `tc-${uuid}`,
          toolName: 'read_file',
          output: { type: 'text' as const, value: opts.toolOutput },
        }],
      }),
    });

    it('should group tokens by entry kind without double counting tool payloads', () => {
      // 4 chars ≈ 1 token. Lengths are multiples of 4 so values are exact.
      const conversation = [
        makeUser('u-1', 'u'.repeat(40)), // 10
        makeAssistant('a-1', {
          content: 'a'.repeat(80), // 20
          reasoning: 'r'.repeat(8), // 2
          toolArgs: 'x'.repeat(12), // 3
          toolOutput: 'y'.repeat(24), // 6
        }),
      ];
      const state = createMockState(conversation);
      const cm = new ContextManager(state, 'STATIC PROMPT'); // 13 chars → 4

      const bd = cm.getContextBreakdown();

      expect(bd.systemPrompt).toBe(estimateTokens('STATIC PROMPT'));
      expect(bd.user).toBe(10);
      expect(bd.assistant).toBe(22); // content + reasoning, tool payloads excluded
      expect(bd.toolCalls).toBe(3);
      expect(bd.toolResults).toBe(6);
      expect(bd.compactSummary).toBe(0);
      expect(bd.total).toBe(bd.systemPrompt + bd.user + bd.assistant + bd.toolCalls + bd.toolResults + bd.compactSummary);
      expect(bd.total).toBe(4 + 10 + 22 + 3 + 6);
    });

    it('should count the compact summary once, ignoring the compact marker entry', () => {
      const summary = 's'.repeat(40); // 10
      const conversation = [
        {
          type: EEntryType.System,
          uuid: 'compact-1',
          parentUuid: null,
          sessionId: 's-cm',
          timestamp: new Date().toISOString(),
          subtype: ESystemSubtype.Compact,
          content: summary,
        },
        makeUser('u-after', 'q'.repeat(20)), // 5
      ];
      const state = createMockState(conversation);
      const cm = new ContextManager(state, 'STATIC PROMPT');
      cm.restoreCompact(summary);

      const bd = cm.getContextBreakdown();

      expect(bd.compactSummary).toBe(10); // from the cached summary, not the marker
      expect(bd.user).toBe(5);
      expect(bd.total).toBe(bd.systemPrompt + bd.user + bd.assistant + bd.toolCalls + bd.toolResults + bd.compactSummary);
    });

    it('should count worker signals using the label actually sent', () => {
      const signalContent = 'progress payload';
      const conversation = [{
        type: EEntryType.Signal,
        uuid: 'sig-1',
        parentUuid: null,
        sessionId: 's-cm',
        timestamp: new Date().toISOString(),
        subtype: 'worker_progress',
        taskId: 'task-42',
        content: signalContent,
      }];
      const cm = new ContextManager(createMockState(conversation), 'STATIC PROMPT');

      const bd = cm.getContextBreakdown();
      const sent = cm.getMessages();
      const sentContent = (sent[0] as { content: string }).content;

      // Real wire label: worker_ prefix stripped, uppercased, task tag appended.
      expect(sentContent).toBe(`[WORKER PROGRESS SIGNAL: PROGRESS task=task-42] ${signalContent}`);
      // Signals are replayed as system messages — inbound context, user group.
      expect(bd.user).toBe(estimateTokens(sentContent));
      expect(bd.total).toBe(bd.systemPrompt + bd.user + bd.assistant + bd.toolCalls + bd.toolResults + bd.compactSummary);
    });

    it('should strip skip_reply content exactly like the sent assistant message', () => {
      const conversation = [{
        type: EEntryType.Assistant,
        uuid: 'a-skip',
        parentUuid: null,
        sessionId: 's-cm',
        timestamp: new Date().toISOString(),
        message: { role: 'assistant' as const, content: 'fabricated reply body' },
        toolCalls: [{
          toolCallId: 'tc-skip',
          toolName: 'skip_reply',
          arguments: '{"reason":"duplicate"}',
        }],
        toolResults: [{
          toolCallId: 'tc-skip',
          toolName: 'skip_reply',
          output: { type: 'text' as const, value: 'skipped' },
        }],
      }];
      const cm = new ContextManager(createMockState(conversation), 'STATIC PROMPT');

      const sent = cm.getMessages();
      const assistantMessage = sent.find((m) => m.role === 'assistant') as { content: unknown };

      // Fabricated content is stripped — only the tool-call part survives.
      expect(assistantMessage.content).toEqual([
        expect.objectContaining({ type: 'tool-call', toolName: 'skip_reply' }),
      ]);

      const bd = cm.getContextBreakdown();
      expect(bd.assistant).toBe(0);
      expect(bd.toolCalls).toBe(estimateTokens('{"reason":"duplicate"}'));
      expect(bd.toolResults).toBe(estimateTokens('skipped'));
    });

    it('should count synthesized orphan tool results as tool result payloads', () => {
      const placeholder = '[No result — step was interrupted]';
      const conversation = [{
        type: EEntryType.Assistant,
        uuid: 'a-orphan',
        parentUuid: null,
        sessionId: 's-cm',
        timestamp: new Date().toISOString(),
        message: { role: 'assistant' as const, content: '' },
        toolCalls: [
          { toolCallId: 'tc-done', toolName: 'read_file', arguments: '{"path":"a"}' },
          { toolCallId: 'tc-orphan', toolName: 'read_file', arguments: '{"path":"b"}' },
        ],
        toolResults: [{
          toolCallId: 'tc-done',
          toolName: 'read_file',
          output: { type: 'text' as const, value: 'file body' },
        }],
      }];
      const cm = new ContextManager(createMockState(conversation), 'STATIC PROMPT');

      const sent = cm.getMessages();
      const toolMessages = sent.filter((m) => m.role === 'tool') as Array<{ content: unknown }>;
      expect(toolMessages).toHaveLength(2);
      expect(toolMessages[1]!.content).toEqual([
        expect.objectContaining({
          type: 'tool-result',
          toolCallId: 'tc-orphan',
          output: { type: 'text', value: placeholder },
        }),
      ]);

      const bd = cm.getContextBreakdown();
      expect(bd.toolResults).toBe(estimateTokens('file body') + estimateTokens(placeholder));
    });

    it('should match the token footprint of the messages actually sent', () => {
      const signalContent = 'worker says hi';
      const conversation = [
        makeUser('u-consistency', 'u'.repeat(40)),
        makeAssistant('a-consistency', {
          content: 'a'.repeat(80),
          reasoning: 'r'.repeat(8),
          toolArgs: '{"path":"x"}',
          toolOutput: 'y'.repeat(24),
        }),
        {
          type: EEntryType.Signal,
          uuid: 'sig-consistency',
          parentUuid: null,
          sessionId: 's-cm',
          timestamp: new Date().toISOString(),
          subtype: 'worker_completed',
          content: signalContent,
        },
      ];
      const cm = new ContextManager(createMockState(conversation), 'STATIC PROMPT');

      const sent = cm.getMessages();
      let sentTokens = 0;
      for (const message of sent) {
        const { texts, toolCalls, toolResults } = extractContentText(message.content);
        for (const text of texts) sentTokens += estimateTokens(text);
        for (const call of toolCalls) sentTokens += estimateTokens(call);
        for (const result of toolResults) sentTokens += estimateTokens(result);
      }

      const bd = cm.getContextBreakdown();
      expect(bd.total).toBe(estimateTokens('STATIC PROMPT') + sentTokens);
    });

    it('should be read-only — no trims, no appends, no state writes', () => {
      const conversation = [makeUser('u-ro', 'u'.repeat(40))];
      const state = createMockState(conversation);
      const cm = new ContextManager(state, 'STATIC PROMPT');

      cm.getContextBreakdown();
      cm.getContextBreakdown();

      expect(state.append).not.toHaveBeenCalled();
      expect(state.set).not.toHaveBeenCalled();
      expect(conversation).toHaveLength(1);
    });
  });

  describe('real usage (reportRealUsage)', () => {
    it('should trigger isFull on real usage even when the estimate is small', () => {
      // Small conversation → small estimate; huge real usage must still win.
      const conversation = [makeUser('u1', 'small message')];
      const cm = new ContextManager(createMockState(conversation), 'STATIC PROMPT', 42_000);

      expect(cm.isFull()).toBe(false); // estimate-only, well under 90% of 42k

      cm.reportRealUsage(50_000); // real prompt size > 0.9 * 42_000
      expect(cm.isFull()).toBe(true);
    });

    it('should ignore non-positive and non-finite reported values', () => {
      const cm = new ContextManager(createMockState(), 'STATIC PROMPT', 42_000);
      cm.reportRealUsage(0);
      cm.reportRealUsage(-5);
      cm.reportRealUsage(Number.NaN);
      // None of the above may arm the real-usage override; estimate-only path.
      expect(cm.isFull()).toBe(false);
    });

    it('should clear the real usage after a compaction', async () => {
      const conversation = [
        makeUser('u1', 'one'), makeUser('u2', 'two'),
        makeUser('u3', 'three'), makeUser('u4', 'four'),
      ];
      const state = createMockState(conversation);
      const cm = new ContextManager(state, 'STATIC PROMPT', 42_000);

      cm.reportRealUsage(50_000);
      expect(cm.isFull()).toBe(true);

      await cm.compact(async () => 'the summary');
      // Stale pre-compaction usage must not keep triggering isFull.
      expect(cm.isFull()).toBe(false);
    });
  });
});
