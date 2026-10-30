import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createMockCtx } from '@/__tests__/helpers';
import { ControllerAgentState } from '@/services/agents/controller-state';
import type { SystemContext } from '@/infra/system-context';
import { EEntryType, ESystemSubtype } from '@/types/index';

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
});
