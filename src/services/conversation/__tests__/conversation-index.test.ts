import { describe, it, expect } from 'vitest';
import { ConversationIndexBuilder, buildConversationIndex } from '@/services/conversation/conversation-index';
import type { AssistantEntry, ConversationEntry, SignalEntry, SystemEntry, UserEntry } from '@/types/conversation';
import { EEntryType, ESignalSubtype, ESystemSubtype } from '@/types/conversation';

// --- Fixtures ---

let seq = 0;
const uuid = (prefix: string) => `${prefix}-${++seq}`;

const ts = (offsetMs = 0) => new Date(1_700_000_000_000 + offsetMs).toISOString();

function makeUser(over: Partial<UserEntry> = {}): UserEntry {
  return {
    type: EEntryType.User,
    uuid: uuid('u'),
    parentUuid: null,
    sessionId: 's1',
    timestamp: ts(),
    message: { role: 'user', content: 'do something' },
    ...over,
  };
}

function makeStep(over: Partial<AssistantEntry> = {}): AssistantEntry {
  return {
    type: EEntryType.Assistant,
    uuid: uuid('a'),
    parentUuid: null,
    sessionId: 's1',
    timestamp: ts(),
    message: { role: 'assistant', content: 'working' },
    ...over,
  };
}

function makeSignal(over: Partial<SignalEntry> = {}): SignalEntry {
  return {
    type: EEntryType.Signal,
    uuid: uuid('sig'),
    parentUuid: null,
    sessionId: 's1',
    timestamp: ts(),
    subtype: ESignalSubtype.WorkerCompleted,
    taskTitle: 'task',
    content: 'done',
    ...over,
  };
}

function makeSystem(over: Partial<SystemEntry> = {}): SystemEntry {
  return {
    type: EEntryType.System,
    uuid: uuid('sys'),
    parentUuid: null,
    sessionId: 's1',
    timestamp: ts(),
    subtype: ESystemSubtype.Error,
    content: 'boom',
    ...over,
  };
}

// --- Grouping ---

describe('ConversationIndexBuilder: grouping', () => {
  it('groups entries by explicit turnId into one TurnView', () => {
    const entries: ConversationEntry[] = [
      makeUser({ uuid: 'u1', turnId: 'T1', rootTurnId: 'T1' }),
      makeStep({ uuid: 'a1', turnId: 'T1', rootTurnId: 'T1' }),
      makeSignal({ uuid: 'sig1', turnId: 'T1' }),
      makeStep({ uuid: 'a2', turnId: 'T1' }),
    ];
    const idx = buildConversationIndex(entries);
    expect(idx.turnCount).toBe(1);
    const turn = idx.getTurn('T1')!;
    expect(turn.entryIds).toEqual(['u1', 'a1', 'sig1', 'a2']);
    expect(turn.userEntry?.uuid).toBe('u1');
    expect(turn.steps.map(s => s.uuid)).toEqual(['a1', 'a2']);
    expect(turn.signals.map(s => s.uuid)).toEqual(['sig1']);
    expect(idx.getIndex().byEntryId.get('a1')).toBe(turn);
    expect(idx.getTurnByEntryId('sig1')).toBe(turn);
  });

  it('keeps separate turns separate and preserves order', () => {
    const entries: ConversationEntry[] = [
      makeUser({ uuid: 'u1', turnId: 'T1' }),
      makeStep({ uuid: 'a1', turnId: 'T1' }),
      makeUser({ uuid: 'u2', turnId: 'T2' }),
      makeStep({ uuid: 'a2', turnId: 'T2' }),
    ];
    const idx = buildConversationIndex(entries);
    expect(idx.turnCount).toBe(2);
    expect(idx.getIndex().turns.map(t => t.turnId)).toEqual(['T1', 'T2']);
  });

  it('takes rootTurnId from the first entry that has one', () => {
    const idx = buildConversationIndex([
      makeStep({ uuid: 'a1', turnId: 'T2', rootTurnId: 'T1' }),
      makeStep({ uuid: 'a2', turnId: 'T2', rootTurnId: 'OTHER' }),
    ]);
    expect(idx.getTurn('T2')!.rootTurnId).toBe('T1');
  });

  it('derives actor from assistant/system entries over user/signal actors', () => {
    const idx = buildConversationIndex([
      makeUser({ uuid: 'u1', turnId: 'T1', actor: { kind: 'user', id: 'user' } }),
      makeSignal({ uuid: 'sig1', turnId: 'T1', actor: { kind: 'worker', id: 'w1', taskId: 't1' } }),
      makeStep({ uuid: 'a1', turnId: 'T1', actor: { kind: 'controller', id: 'ctrl' } }),
    ]);
    expect(idx.getTurn('T1')!.actor).toEqual({ kind: 'controller', id: 'ctrl' });
  });

  it('computes startedAt/endedAt across entry timestamps', () => {
    const idx = buildConversationIndex([
      makeUser({ uuid: 'u1', turnId: 'T1', timestamp: ts(1000), startedAt: ts(500) }),
      makeStep({ uuid: 'a1', turnId: 'T1', timestamp: ts(2000), endedAt: ts(3000) }),
    ]);
    const turn = idx.getTurn('T1')!;
    expect(turn.startedAt).toBe(ts(500));
    expect(turn.endedAt).toBe(ts(3000));
  });
});

// --- Legacy backfill ---

describe('ConversationIndexBuilder: legacy backfill', () => {
  it('starts a new derived turn at each user entry without turnId', () => {
    const entries: ConversationEntry[] = [
      makeUser({ uuid: 'u1' }),
      makeStep({ uuid: 'a1' }),
      makeStep({ uuid: 'a2' }),
      makeUser({ uuid: 'u2' }),
      makeStep({ uuid: 'a3' }),
    ];
    const idx = buildConversationIndex(entries);
    expect(idx.turnCount).toBe(2);
    const [t1, t2] = idx.getIndex().turns;
    expect(t1.turnId).toMatch(/^legacy-turn-\d+$/);
    expect(t1.entryIds).toEqual(['u1', 'a1', 'a2']);
    expect(t2.turnId).toMatch(/^legacy-turn-\d+$/);
    expect(t2.turnId).not.toBe(t1.turnId);
    expect(t2.entryIds).toEqual(['u2', 'a3']);
  });

  it('gives leading non-user entries their own derived turn', () => {
    const idx = buildConversationIndex([
      makeSignal({ uuid: 'sig0' }),
      makeUser({ uuid: 'u1' }),
      makeStep({ uuid: 'a1' }),
    ]);
    expect(idx.turnCount).toBe(2);
    expect(idx.getIndex().turns[0].entryIds).toEqual(['sig0']);
  });

  it('groups mixed old/new data: legacy entries attach to the current new-data turn', () => {
    const entries: ConversationEntry[] = [
      makeUser({ uuid: 'u1', turnId: 'T1' }),
      makeStep({ uuid: 'a1', turnId: 'T1' }),
      // Legacy entries (no turnId) after new-data entries join the current turn…
      makeStep({ uuid: 'a2' }),
      makeSignal({ uuid: 'sig1' }),
      // …until a user entry starts a fresh derived turn.
      makeUser({ uuid: 'u2' }),
      makeStep({ uuid: 'a3' }),
    ];
    const idx = buildConversationIndex(entries);
    expect(idx.turnCount).toBe(2);
    const [t1, t2] = idx.getIndex().turns;
    expect(t1.turnId).toBe('T1');
    expect(t1.entryIds).toEqual(['u1', 'a1', 'a2', 'sig1']);
    expect(t2.turnId).toMatch(/^legacy-turn-/);
    expect(t2.entryIds).toEqual(['u2', 'a3']);
  });

  it('old entries without any new fields build a usable index', () => {
    const entries: ConversationEntry[] = [
      { type: EEntryType.User, uuid: 'u1', parentUuid: null, sessionId: 's1', timestamp: ts(), message: { role: 'user', content: 'hi' } },
      { type: EEntryType.Assistant, uuid: 'a1', parentUuid: null, sessionId: 's1', timestamp: ts(), message: { role: 'assistant', content: 'hello', usage: { inputTokens: 3, outputTokens: 4 } } },
    ];
    const idx = buildConversationIndex(entries as ConversationEntry[]);
    expect(idx.turnCount).toBe(1);
    const turn = idx.getIndex().turns[0];
    expect(turn.status).toBe('completed');
    expect(turn.usage).toEqual({ inputTokens: 3, outputTokens: 4, cachedInputTokens: 0, reasoningTokens: 0, totalTokens: 7 });
  });
});

// --- Usage accumulation ---

describe('ConversationIndexBuilder: usage accumulation', () => {
  it('sums per-step usage and derives totalTokens when absent', () => {
    const idx = buildConversationIndex([
      makeStep({
        uuid: 'a1', turnId: 'T1',
        message: { role: 'assistant', content: 'x', usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 4, reasoningTokens: 1, totalTokens: 15 } },
      }),
      makeStep({
        uuid: 'a2', turnId: 'T1',
        message: { role: 'assistant', content: 'y', usage: { inputTokens: 7, outputTokens: 3 } },
      }),
    ]);
    expect(idx.getTurn('T1')!.usage).toEqual({
      inputTokens: 17,
      outputTokens: 8,
      cachedInputTokens: 4,
      reasoningTokens: 1,
      totalTokens: 25, // 15 explicit + (7+3) derived
    });
  });
});

// --- Tool calls & task association ---

describe('ConversationIndexBuilder: tool calls and task association', () => {
  it('flattens tool calls with status, timing and result status', () => {
    const idx = buildConversationIndex([
      makeStep({
        uuid: 'a1', turnId: 'T1',
        toolCalls: [
          { toolCallId: 'tc1', toolName: 'bash', arguments: '{}', status: 'succeeded', startedAt: ts(1), endedAt: ts(2) },
          { toolCallId: 'tc2', toolName: 'read_file', arguments: '{}', status: 'failed', errorType: 'ToolError' },
        ],
        toolResults: [
          { toolCallId: 'tc1', toolName: 'bash', output: { type: 'text', value: 'ok' } },
          { toolCallId: 'tc2', toolName: 'read_file', output: { type: 'text', value: 'boom' }, isError: true },
        ],
      }),
    ]);
    const turn = idx.getTurn('T1')!;
    expect(turn.toolCalls).toHaveLength(2);
    expect(turn.toolCalls[0]).toMatchObject({ toolCallId: 'tc1', toolName: 'bash', status: 'succeeded', startedAt: ts(1), endedAt: ts(2), resultStatus: 'succeeded' });
    expect(turn.toolCalls[1]).toMatchObject({ toolCallId: 'tc2', status: 'failed', resultStatus: 'failed' });
    expect(turn.status).toBe('failed');
  });

  it('associates a dispatched task with its tool call and resolves via terminal signal', () => {
    const idx = buildConversationIndex([
      makeStep({
        uuid: 'a1', turnId: 'T1',
        toolCalls: [{ toolCallId: 'tc1', toolName: 'add_task', arguments: '{}', taskId: 'task-9', status: 'running' }],
      }),
      // Later turn consumes the completion signal for task-9.
      makeSignal({ uuid: 'sig1', turnId: 'T2', subtype: ESignalSubtype.WorkerCompleted, taskId: 'task-9' }),
    ]);
    const dispatch = idx.getTurn('T1')!;
    expect(dispatch.toolCalls[0]).toMatchObject({ toolCallId: 'tc1', taskId: 'task-9', status: 'running' });
    // Task finished → dispatching turn no longer running.
    expect(dispatch.status).toBe('completed');
    expect(idx.getTurn('T2')!.status).toBe('completed');
  });

  it('marks a turn running while its dispatched task has no terminal signal', () => {
    const idx = buildConversationIndex([
      makeStep({
        uuid: 'a1', turnId: 'T1',
        toolCalls: [{ toolCallId: 'tc1', toolName: 'add_task', arguments: '{}', taskId: 'task-9', status: 'running' }],
      }),
      // Progress / permission signals are not terminal.
      makeSignal({ uuid: 'sig1', turnId: 'T2', subtype: ESignalSubtype.WorkerProgress, taskId: 'task-9' }),
    ]);
    expect(idx.getTurn('T1')!.status).toBe('running');
  });

  it('marks dispatching and consuming turns failed when the task fails', () => {
    const idx = buildConversationIndex([
      makeStep({
        uuid: 'a1', turnId: 'T1',
        toolCalls: [{ toolCallId: 'tc1', toolName: 'add_task', arguments: '{}', taskId: 'task-9', status: 'running' }],
      }),
      makeSignal({ uuid: 'sig1', turnId: 'T2', subtype: ESignalSubtype.WorkerFailed, taskId: 'task-9', content: 'error' }),
    ]);
    expect(idx.getTurn('T1')!.status).toBe('failed');
    expect(idx.getTurn('T2')!.status).toBe('failed');
  });

  it('treats worker_disposed as terminal but not as failure', () => {
    const idx = buildConversationIndex([
      makeStep({
        uuid: 'a1', turnId: 'T1',
        toolCalls: [{ toolCallId: 'tc1', toolName: 'add_task', arguments: '{}', taskId: 'task-9', status: 'running' }],
      }),
      makeSignal({ uuid: 'sig1', turnId: 'T2', subtype: ESignalSubtype.WorkerDisposed, taskId: 'task-9' }),
    ]);
    expect(idx.getTurn('T1')!.status).toBe('completed');
    expect(idx.getTurn('T2')!.status).toBe('completed');
  });
});

// --- Cancel semantics ---

describe('ConversationIndexBuilder: cancel semantics', () => {
  it('marks the dispatching turn cancelled when its task is cancelled', () => {
    const idx = buildConversationIndex([
      makeStep({
        uuid: 'a1', turnId: 'T1',
        toolCalls: [{ toolCallId: 'tc1', toolName: 'add_task', arguments: '{}', taskId: 'task-9', status: 'running' }],
      }),
      makeSignal({ uuid: 'sig1', turnId: 'T2', subtype: ESignalSubtype.TaskCancelled, taskId: 'task-9' }),
    ]);
    expect(idx.getTurn('T1')!.status).toBe('cancelled');
    // The consuming turn observed the cancellation but did not fail.
    expect(idx.getTurn('T2')!.status).toBe('completed');
  });

  it('marks the dispatching turn failed when its task fails (error stays failed)', () => {
    const idx = buildConversationIndex([
      makeStep({
        uuid: 'a1', turnId: 'T1',
        toolCalls: [{ toolCallId: 'tc1', toolName: 'add_task', arguments: '{}', taskId: 'task-9', status: 'running' }],
      }),
      makeSignal({ uuid: 'sig1', turnId: 'T2', subtype: ESignalSubtype.WorkerFailed, taskId: 'task-9', content: 'error' }),
    ]);
    expect(idx.getTurn('T1')!.status).toBe('failed');
    expect(idx.getTurn('T2')!.status).toBe('failed');
  });

  it('marks the dispatching turn completed when its task completes normally', () => {
    const idx = buildConversationIndex([
      makeStep({
        uuid: 'a1', turnId: 'T1',
        toolCalls: [{ toolCallId: 'tc1', toolName: 'add_task', arguments: '{}', taskId: 'task-9', status: 'running' }],
      }),
      makeSignal({ uuid: 'sig1', turnId: 'T2', subtype: ESignalSubtype.WorkerCompleted, taskId: 'task-9' }),
    ]);
    expect(idx.getTurn('T1')!.status).toBe('completed');
    expect(idx.getTurn('T2')!.status).toBe('completed');
  });

  it('a real failure outranks a cancellation in the same turn', () => {
    const idx = buildConversationIndex([
      makeStep({
        uuid: 'a1', turnId: 'T1',
        toolCalls: [
          { toolCallId: 'tc1', toolName: 'add_task', arguments: '{}', taskId: 'task-9', status: 'running' },
          { toolCallId: 'tc2', toolName: 'add_task', arguments: '{}', taskId: 'task-10', status: 'running' },
        ],
      }),
      makeSignal({ uuid: 'sig1', turnId: 'T2', subtype: ESignalSubtype.TaskCancelled, taskId: 'task-9' }),
      makeSignal({ uuid: 'sig2', turnId: 'T2', subtype: ESignalSubtype.WorkerFailed, taskId: 'task-10', content: 'error' }),
    ]);
    expect(idx.getTurn('T1')!.status).toBe('failed');
  });

  it('keeps a turn running until the task_cancelled signal arrives', () => {
    const idx = buildConversationIndex([
      makeStep({
        uuid: 'a1', turnId: 'T1',
        toolCalls: [{ toolCallId: 'tc1', toolName: 'add_task', arguments: '{}', taskId: 'task-9', status: 'running' }],
      }),
    ]);
    expect(idx.getTurn('T1')!.status).toBe('running');
  });
});

// --- Status rules ---

describe('ConversationIndexBuilder: status rules', () => {
  it('marks a turn failed on an error system entry', () => {
    const idx = buildConversationIndex([
      makeUser({ uuid: 'u1', turnId: 'T1' }),
      makeSystem({ uuid: 'e1', turnId: 'T1', subtype: ESystemSubtype.Error }),
    ]);
    expect(idx.getTurn('T1')!.status).toBe('failed');
  });

  it('does not fail a turn for a compact marker', () => {
    const idx = buildConversationIndex([
      makeUser({ uuid: 'u1', turnId: 'T1' }),
      makeSystem({
        uuid: 'c1', turnId: 'T1', subtype: ESystemSubtype.Compact,
        content: 'summary', compactMeta: { summarizedTokenCount: 5 },
      }),
    ]);
    expect(idx.getTurn('T1')!.status).toBe('completed');
  });

  it('marks a turn running on a pending/running sync tool call', () => {
    const idx = buildConversationIndex([
      makeStep({
        uuid: 'a1', turnId: 'T1',
        toolCalls: [{ toolCallId: 'tc1', toolName: 'bash', arguments: '{}', status: 'running' }],
      }),
    ]);
    expect(idx.getTurn('T1')!.status).toBe('running');
  });

  it('isCompactMarker logic is unaffected by extended compactMeta fields', () => {
    const idx = buildConversationIndex([
      makeSystem({
        uuid: 'c1', turnId: 'T1', subtype: ESystemSubtype.Compact, content: 'summary',
        compactMeta: { summarizedTokenCount: 5, fromEntryId: 'u1', toEntryId: 'a9', model: 'm', createdAt: ts() },
      }),
    ]);
    expect(idx.getTurn('T1')!.status).toBe('completed');
  });
});

// --- Incremental append ---

describe('ConversationIndexBuilder: incremental append', () => {
  it('produces the same result as a full build when fed incrementally', () => {
    const entries: ConversationEntry[] = [
      makeUser({ uuid: 'u1', turnId: 'T1', rootTurnId: 'T1' }),
      makeStep({
        uuid: 'a1', turnId: 'T1',
        message: { role: 'assistant', content: 'x', usage: { inputTokens: 5, outputTokens: 2 } },
        toolCalls: [{ toolCallId: 'tc1', toolName: 'add_task', arguments: '{}', taskId: 'task-1', status: 'running' }],
      }),
      makeSignal({ uuid: 'sig1', turnId: 'T2', subtype: ESignalSubtype.WorkerCompleted, taskId: 'task-1' }),
      makeStep({ uuid: 'a2', turnId: 'T2' }),
      makeUser({ uuid: 'u2', turnId: 'T3' }),
      makeStep({
        uuid: 'a3', turnId: 'T3',
        toolCalls: [{ toolCallId: 'tc2', toolName: 'bash', arguments: '{}', status: 'failed', errorType: 'ToolError' }],
      }),
    ];

    const full = buildConversationIndex(entries);
    const incremental = new ConversationIndexBuilder(entries.slice(0, 3));
    for (const e of entries.slice(3)) incremental.onAppend(e);

    const strip = (idx: ReturnType<typeof buildConversationIndex>) =>
      idx.getIndex().turns.map(t => ({
        turnId: t.turnId, status: t.status, usage: t.usage, entryIds: t.entryIds,
        rootTurnId: t.rootTurnId, actor: t.actor,
        toolCalls: t.toolCalls, stepCount: t.steps.length, signalIds: t.signals.map(s => s.uuid),
      }));
    expect(strip(incremental)).toEqual(strip(full));
  });

  it('ignores duplicate uuids (idempotent append feed)', () => {
    const entry = makeUser({ uuid: 'u1', turnId: 'T1' });
    const idx = new ConversationIndexBuilder([entry]);
    idx.onAppend(entry);
    expect(idx.turnCount).toBe(1);
    expect(idx.getTurn('T1')!.entryIds).toEqual(['u1']);
  });
});
