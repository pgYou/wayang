import { describe, it, expect } from 'vitest';
import { serializeTurnView, summarizeTurn } from '@/services/conversation/turn-serialize';
import type { TurnToolCallView, TurnUsage, TurnView } from '@/types/conversation';
import type { AssistantEntry, SignalEntry, UserEntry } from '@/types/conversation';
import { EEntryType, ESignalSubtype } from '@/types/conversation';

const ts = '2026-01-01T00:00:00.000Z';

const userEntry: UserEntry = {
  type: EEntryType.User,
  uuid: 'u1',
  parentUuid: null,
  sessionId: 's1',
  timestamp: ts,
  turnId: 'T1',
  rootTurnId: 'T1',
  actor: { kind: 'user', id: 'user' },
  message: { role: 'user', content: 'x'.repeat(50) },
};

const step: AssistantEntry = {
  type: EEntryType.Assistant,
  uuid: 'a1',
  parentUuid: null,
  sessionId: 's1',
  timestamp: ts,
  turnId: 'T1',
  rootTurnId: 'T1',
  actor: { kind: 'controller', id: 'ctrl' },
  stepIndex: 0,
  model: { provider: 'openai', model: 'fake-model' },
  timing: { startedAt: ts, endedAt: ts, durationMs: 12 },
  requestId: 'resp-1',
  message: { role: 'assistant', content: 'y'.repeat(80), usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } },
  toolCalls: [{ toolCallId: 'tc1', toolName: 'add_task', arguments: '{}', taskId: 't1', status: 'running' }],
  toolResults: [{ toolCallId: 'tc1', toolName: 'add_task', output: { type: 'text', value: 'Task t1 added' } }],
};

const signal: SignalEntry = {
  type: EEntryType.Signal,
  uuid: 'sig1',
  parentUuid: null,
  sessionId: 's1',
  timestamp: ts,
  turnId: 'T1',
  subtype: ESignalSubtype.WorkerCompleted,
  signalId: 'sig-9',
  workerId: 'w1',
  taskId: 't1',
  taskTitle: 'task',
  content: 'z'.repeat(60),
};

function makeTurn(over: Partial<TurnView> = {}): TurnView {
  const usage: TurnUsage = { inputTokens: 1, outputTokens: 2, cachedInputTokens: 0, reasoningTokens: 0, totalTokens: 3 };
  const toolCalls: TurnToolCallView[] = [
    { toolCallId: 'tc1', toolName: 'add_task', taskId: 't1', status: 'running', resultStatus: 'succeeded' },
  ];
  return {
    turnId: 'T1',
    rootTurnId: 'T1',
    actor: { kind: 'controller', id: 'ctrl' },
    startedAt: ts,
    endedAt: ts,
    status: 'completed',
    steps: [step],
    userEntry,
    signals: [signal],
    toolCalls,
    usage,
    entryIds: ['u1', 'a1', 'sig1'],
    ...over,
  };
}

describe('serializeTurnView', () => {
  it('emits a JSON-safe turn with steps, signals and tool calls', () => {
    const out = serializeTurnView(makeTurn());
    expect(out.turnId).toBe('T1');
    expect(out.rootTurnId).toBe('T1');
    expect(out.status).toBe('completed');
    expect(out.steps).toHaveLength(1);
    expect(out.steps[0]).toMatchObject({
      uuid: 'a1', stepIndex: 0, contentTruncated: false, toolCallCount: 1, toolResultCount: 1,
    });
    expect(out.steps[0].model).toEqual({ provider: 'openai', model: 'fake-model' });
    expect(out.steps[0].requestId).toBe('resp-1');
    expect(out.signals[0]).toMatchObject({ uuid: 'sig1', signalId: 'sig-9', workerId: 'w1', taskId: 't1' });
    expect(out.toolCalls[0]).toMatchObject({ toolCallId: 'tc1', taskId: 't1', status: 'running' });
    expect(out.usage).toEqual({ inputTokens: 1, outputTokens: 2, cachedInputTokens: 0, reasoningTokens: 0, totalTokens: 3 });
    expect(out.entryIds).toEqual(['u1', 'a1', 'sig1']);
    // Must be structured-clone safe (no Map / class instances on the wire).
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
  });

  it('truncates long texts with an explicit marker and flag', () => {
    const out = serializeTurnView(makeTurn(), { maxTextLength: 10 });
    expect(out.userEntry!.content).toContain('[truncated]');
    expect(out.userEntry!.contentTruncated).toBe(true);
    expect(out.steps[0].content).toContain('[truncated]');
    expect(out.steps[0].contentTruncated).toBe(true);
    expect(out.signals[0].content).toContain('[truncated]');
    expect(out.signals[0].contentTruncated).toBe(true);
  });

  it('omits userEntry when the turn has none', () => {
    const out = serializeTurnView(makeTurn({ userEntry: undefined }));
    expect(out.userEntry).toBeUndefined();
  });
});

describe('summarizeTurn', () => {
  it('emits a compact header with counts and a user preview', () => {
    const out = summarizeTurn(makeTurn());
    expect(out).toMatchObject({
      turnId: 'T1',
      status: 'completed',
      stepCount: 1,
      signalCount: 1,
      toolCallCount: 1,
      entryCount: 3,
    });
    expect(out.userPreview).toBe('x'.repeat(50));
    expect(out.userPreviewTruncated).toBe(false);
  });

  it('truncates the user preview', () => {
    const out = summarizeTurn(makeTurn(), { maxTextLength: 5 });
    expect(out.userPreview).toContain('[truncated]');
    expect(out.userPreviewTruncated).toBe(true);
  });
});
