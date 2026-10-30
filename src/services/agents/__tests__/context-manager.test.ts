import { describe, it, expect, vi } from 'vitest';
import { ContextManager, RECENT_TOKEN_BUDGET } from '@/services/agents/context-manager';
import { EEntryType, ESystemSubtype } from '@/types/index';

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
});
