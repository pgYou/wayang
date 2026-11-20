import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createMockCtx } from '@/__tests__/helpers';
import { ControllerAgentState } from '@/services/agents/controller-state';
import { ContextManager } from '@/services/agents/context-manager';
import type { SystemContext } from '@/infra/system-context';
import { EEntryType, ESystemSubtype } from '@wayang-ai/protocol';

// --- JSONL fixtures ---

const makeUser = (uuid: string, content: string) => ({
  type: EEntryType.User,
  uuid,
  parentUuid: null,
  sessionId: 's1',
  timestamp: new Date().toISOString(),
  message: { role: 'user' as const, content },
});

const makeSystem = (uuid: string, subtype: ESystemSubtype, content: string, compactMeta?: any) => ({
  type: EEntryType.System,
  uuid,
  parentUuid: null,
  sessionId: 's1',
  timestamp: new Date().toISOString(),
  subtype,
  content,
  ...(compactMeta !== undefined ? { compactMeta } : {}),
});

const makeCompactMarker = (uuid: string, content: string) =>
  makeSystem(uuid, ESystemSubtype.Compact, content, { summarizedTokenCount: 100 });

const makeAssistantWithTools = (uuid: string, outputSize: number) => ({
  type: EEntryType.Assistant,
  uuid,
  parentUuid: null,
  sessionId: 's1',
  timestamp: new Date().toISOString(),
  message: { role: 'assistant' as const, content: 'working' },
  toolCalls: [{ toolCallId: `${uuid}-tc`, toolName: 'bash', arguments: '{"command":"ls"}' }],
  toolResults: [{
    toolCallId: `${uuid}-tc`,
    toolName: 'bash',
    output: { type: 'text' as const, value: 'x'.repeat(outputSize) },
  }],
});

function writeConversationJsonl(dir: string, entries: any[]) {
  writeFileSync(
    join(dir, 'conversation.jsonl'),
    entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
}

describe('ControllerAgentState', () => {
  let tempDir: string;
  let state: ControllerAgentState;
  let ctx: SystemContext;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wayang-test-'));
    ctx = createMockCtx({ sessionDir: tempDir } as any);
    state = new ControllerAgentState(ctx);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should initialize with default data', () => {
    const runtime = state.get('runtimeState');
    expect(runtime.notebook).toBe('');
    expect(runtime.pendingInquiry).toBeNull();
    expect(state.get('conversation')).toEqual([]);
    expect(state.get('compactSummary')).toBeNull();
  });

  it('should set runtime state', () => {
    state.set('runtimeState.session', { id: 's1', startedAt: 1000 });
    expect(state.get('runtimeState.session')).toEqual({ id: 's1', startedAt: 1000 });
  });

  it('should persist conversation entries via append', () => {
    const entry = {
      type: 'user' as const,
      uuid: 'u1',
      parentUuid: null,
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      message: { role: 'user' as const, content: 'hello' },
    };

    state.append('conversation', entry);
    const fs = require('fs');
    const content = fs.readFileSync(join(tempDir, 'conversation.jsonl'), 'utf-8');
    expect(content).toContain('hello');
  });

  it('should restore from disk', async () => {
    state.set('runtimeState.session', { id: 's1', startedAt: 1000 });

    const state2 = new ControllerAgentState(ctx);
    await state2.restore();

    expect(state2.get('runtimeState.session')).toEqual({ id: 's1', startedAt: 1000 });
  });

  it('should restore conversation entries', async () => {
    state.append('conversation', {
      type: 'user',
      uuid: 'u1',
      parentUuid: null,
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'hello' },
    });

    const state2 = new ControllerAgentState(ctx);
    await state2.restore();

    expect(state2.get('conversation')).toHaveLength(1);
    expect((state2.get('conversation') as any[])[0].message.content).toBe('hello');
  });

  it('should window around a real compact marker and expose its summary', async () => {
    // Old entries + marker with compactMeta + new entries, all within budget
    writeConversationJsonl(tempDir, [
      makeUser('old-1', 'old message one'),
      makeUser('old-2', 'old message two'),
      makeCompactMarker('m-1', 'SUMMARY: everything before the marker'),
      makeUser('new-1', 'new message one'),
      makeUser('new-2', 'new message two'),
    ]);

    const state2 = new ControllerAgentState(ctx);
    await state2.restore();

    const conversation = state2.get('conversation') as any[];
    // Within budget → cutIdx = 0 → the whole history (marker included) is kept
    expect(conversation).toHaveLength(5);
    expect(conversation.map((e) => e.uuid)).toEqual(['old-1', 'old-2', 'm-1', 'new-1', 'new-2']);
    // The marker's content is exposed as the in-memory summary
    expect(state2.get('compactSummary')).toBe('SUMMARY: everything before the marker');
  });

  it('should not recognize a subtype=compact entry without compactMeta', async () => {
    writeConversationJsonl(tempDir, [
      makeUser('u-1', 'message one'),
      makeSystem('legacy-1', ESystemSubtype.Compact, 'legacy worker success record'),
      makeUser('u-2', 'message two'),
    ]);

    const state2 = new ControllerAgentState(ctx);
    await state2.restore();

    // No windowing — every entry loads, no summary exposed
    expect(state2.get('conversation')).toHaveLength(3);
    expect(state2.get('compactSummary')).toBeNull();
  });

  it('should use the last marker when multiple markers exist', async () => {
    writeConversationJsonl(tempDir, [
      makeUser('u-1', 'message one'),
      makeCompactMarker('m-1', 'first summary'),
      makeUser('u-2', 'message two'),
      makeCompactMarker('m-2', 'second summary'),
      makeUser('u-3', 'message three'),
    ]);

    const state2 = new ControllerAgentState(ctx);
    await state2.restore();

    expect(state2.get('compactSummary')).toBe('second summary');
  });

  it('should not expose a system-prompt summary for a current-format marker', async () => {
    // New format: the summary is a user entry right after the marker, so the
    // marker carries a summaryEntryUuid instead of the summary text. Restore
    // must leave compactSummary null (nothing to inject into the system
    // prompt) and keep the summary entry inside the windowed conversation.
    const marker = {
      ...makeCompactMarker('m-new', '[Context compacted] ...'),
      compactMeta: { summarizedTokenCount: 100, summaryEntryUuid: 'sum-1' },
    };
    writeConversationJsonl(tempDir, [
      makeUser('u-1', 'old message'),
      marker,
      makeUser('sum-1', '[Conversation Summary]\neverything before the marker'),
      makeUser('new-1', 'new message'),
    ]);

    const state2 = new ControllerAgentState(ctx);
    await state2.restore();

    expect(state2.get('compactSummary')).toBeNull();
    const conversation = state2.get('conversation') as any[];
    expect(conversation.map((e) => e.uuid)).toContain('sum-1');
    expect(conversation.find((e) => e.uuid === 'sum-1').message.content)
      .toBe('[Conversation Summary]\neverything before the marker');
  });

  it('should count toolCalls/toolResults toward the budget so the window start moves forward', async () => {
    // Entry with huge tool output (> RECENT_TOKEN_BUDGET alone) followed by a
    // small entry, then the marker. The heavy entry must fall out of the window.
    writeConversationJsonl(tempDir, [
      makeAssistantWithTools('heavy-1', 80_001), // ~20_001 tokens from toolResults alone
      makeUser('light-1', 'light message'),
      makeCompactMarker('m-1', 'SUMMARY: heavy context dropped'),
      makeUser('new-1', 'new message'),
    ]);

    const state2 = new ControllerAgentState(ctx);
    await state2.restore();

    const conversation = state2.get('conversation') as any[];
    const uuids = conversation.map((e) => e.uuid);
    // The heavy entry is pushed out of the window; the light entry survives
    expect(uuids).not.toContain('heavy-1');
    expect(uuids).toEqual(['light-1', 'm-1', 'new-1']);
    expect(state2.get('compactSummary')).toBe('SUMMARY: heavy context dropped');
  });

  it('scales the restore budget to the model window: a 32k window restores below the threshold', async () => {
    // 8 pre-marker entries × ~5k tokens plus ~8k tokens accumulated AFTER the
    // marker (post-marker entries are always kept — only the pre-marker
    // retained zone is budgeted). With the old fixed 20k budget the restore
    // keeps ~15k of the pre-marker entries, so the total lands above the 60%
    // threshold of a 32k window (19.2k) and the first request after resume
    // triggers a pointless compaction; the scaled 8k budget stays below it.
    const big = (uuid: string) => makeUser(uuid, `${uuid} ${'x'.repeat(20_000)}`);
    writeConversationJsonl(tempDir, [
      big('old-1'),
      big('old-2'),
      big('old-3'),
      big('old-4'),
      big('old-5'),
      big('old-6'),
      big('old-7'),
      big('old-8'),
      makeCompactMarker('m-1', 'SUMMARY: everything before the marker'),
      makeUser('post-1', 'p'.repeat(32_008)),
    ]);

    // Scaled restore (32k → 8k budget): one pre-marker entry survives; a 32k
    // ContextManager judges the restored context NOT full.
    const scaled = new ControllerAgentState(ctx);
    await scaled.restore(32_000);
    const scaledConversation = (scaled.get('conversation') as any[]).map((e) => e.uuid);
    expect(scaledConversation).toEqual(['old-8', 'm-1', 'post-1']);
    const cm = new ContextManager(scaled as any, 'STATIC PROMPT', 32_000);
    expect(cm.isFull()).toBe(false);

    // Control — the default (256k window) budget keeps ~15k pre-marker
    // tokens; judged against the same 32k window that context IS full: the
    // mismatch B6 fixes.
    const fixedBudget = new ControllerAgentState(ctx);
    await fixedBudget.restore();
    expect((fixedBudget.get('conversation') as any[]).map((e) => e.uuid))
      .toEqual(['old-6', 'old-7', 'old-8', 'm-1', 'post-1']);
    const cmFixed = new ContextManager(fixedBudget as any, 'STATIC PROMPT', 32_000);
    expect(cmFixed.isFull()).toBe(true);
  });
});
