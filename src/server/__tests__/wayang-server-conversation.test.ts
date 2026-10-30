import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

/**
 * Handler-layer tests for the read-only conversation RPCs
 * (conversation_list_turns / conversation_get_turn). The Supervisor is mocked
 * so the responses depend only on the handler + serializer logic: param
 * validation, pagination, unknown-turn errors, truncation flags, and the
 * normal response shape. (End-to-end behavior with a real Supervisor is
 * covered by wayang-server.test.ts and the e2e scenarios.)
 */

// --- Mock the Supervisor: wayang-server only needs its surface ---

const supervisorStub = {
  controllerAgent: { subscribe: () => () => {}, getSnapshot: () => undefined },
  signalQueue: { subscribe: () => () => {}, getSnapshot: () => [] },
  engine: { subscribe: () => () => {}, getSnapshot: () => [] },
  ctx: { sessionId: 'sess-rpc', sessionDir: '/tmp/sess-rpc', workspaceDir: '/tmp/ws' },
  restore: vi.fn(async () => {}),
  start: vi.fn(async () => {}),
  shutdown: vi.fn(async () => {}),
  getConversationIndex: vi.fn(),
  getTurn: vi.fn(),
};

vi.mock('@/services/supervisor', () => ({
  // A constructible mock: `new Supervisor(...)` yields the shared stub.
  Supervisor: class MockSupervisor {
    constructor() {
      Object.assign(this, supervisorStub);
    }
  },
}));

import { runWayangServer } from '../wayang-server';
import { RpcClient } from '@/rpc/rpc-client';
import { createStreamTransport } from '@/rpc/transport';
import { METHOD } from '@/rpc/protocol';
import { buildConversationIndex } from '@/services/conversation/conversation-index';
import type { AssistantEntry, ConversationEntry, SignalEntry, UserEntry } from '@/types/conversation';
import { EEntryType, ESignalSubtype } from '@/types/conversation';

// --- Fixtures: a two-turn controller conversation ---

const ts = (ms: number) => new Date(1_700_000_000_000 + ms).toISOString();

const userEntry: UserEntry = {
  type: EEntryType.User,
  uuid: 'u1',
  parentUuid: null,
  sessionId: 'sess-rpc',
  timestamp: ts(0),
  turnId: 'T1',
  rootTurnId: 'T1',
  actor: { kind: 'user', id: 'user' },
  message: { role: 'user', content: 'please run the very long task with lots of context'.repeat(20) },
};

const stepEntry: AssistantEntry = {
  type: EEntryType.Assistant,
  uuid: 'a1',
  parentUuid: null,
  sessionId: 'sess-rpc',
  timestamp: ts(10),
  turnId: 'T1',
  rootTurnId: 'T1',
  stepIndex: 0,
  finishReason: 'tool-calls',
  message: {
    role: 'assistant',
    content: 'dispatching the task now '.repeat(30),
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  },
  toolCalls: [{ toolCallId: 'tc1', toolName: 'add_task', arguments: '{}', taskId: 'task-1', status: 'running' }],
  model: { provider: 'fake', model: 'fake-model' },
};

const signalEntry: SignalEntry = {
  type: EEntryType.Signal,
  uuid: 'sig1',
  parentUuid: null,
  sessionId: 'sess-rpc',
  timestamp: ts(20),
  turnId: 'T2',
  rootTurnId: 'T1',
  subtype: ESignalSubtype.WorkerCompleted,
  taskId: 'task-1',
  taskTitle: 'long task',
  content: 'task finished successfully with a fairly long summary worth truncating'.repeat(10),
};

const replyEntry: AssistantEntry = {
  type: EEntryType.Assistant,
  uuid: 'a2',
  parentUuid: null,
  sessionId: 'sess-rpc',
  timestamp: ts(30),
  turnId: 'T2',
  rootTurnId: 'T1',
  stepIndex: 0,
  finishReason: 'stop',
  message: { role: 'assistant', content: 'all done', usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } },
};

const fixtureEntries: ConversationEntry[] = [userEntry, stepEntry, signalEntry, replyEntry];

/** The index built from the fixture — real ConversationIndexBuilder output. */
function fixtureIndex() {
  return buildConversationIndex(fixtureEntries);
}

// --- Boot ---

let configPath: string;
let tempRoot: string;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'wayang-rpc-test-'));
  configPath = join(tempRoot, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    providers: { fake: { endpoint: 'http://localhost:9/v1', apiKey: 'test-key', modelName: 'fake-model' } },
    controller: { provider: 'fake' },
    worker: { provider: 'fake', maxConcurrency: 1 },
  }));
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});

afterAll(() => {
  exitSpy.mockRestore();
  rmSync(tempRoot, { recursive: true, force: true });
});

interface Booted {
  client: RpcClient;
  dispose: () => Promise<void>;
}

async function bootServer(): Promise<Booted> {
  const serverIn = new PassThrough();
  const serverOut = new PassThrough();
  const client = new RpcClient(createStreamTransport(serverOut, serverIn));

  // READY is notified after every handler is registered — awaiting it
  // removes any registration race.
  const readyPromise = new Promise<void>((resolve) => {
    client.on('ready', () => resolve());
  });

  void runWayangServer(
    {
      configPath,
      homeDir: join(tempRoot, 'home'),
      workspaceDir: join(tempRoot, 'workspace'),
      session: { mode: 'new' },
      logLevel: 'silent',
    },
    { stdin: serverIn, stdout: serverOut },
  );

  await Promise.race([
    readyPromise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('server not ready')), 5_000)),
  ]);

  return {
    client,
    dispose: async () => {
      await client.request(METHOD.SHUTDOWN).catch(() => { /* best effort */ });
      await new Promise((r) => setTimeout(r, 50));
      client.close();
    },
  };
}

beforeEach(() => {
  supervisorStub.getConversationIndex.mockReset().mockImplementation(() => fixtureIndex().getIndex());
  supervisorStub.getTurn.mockReset().mockImplementation(((turnId: string) => fixtureIndex().getTurn(turnId)) as any);
});

describe('conversation RPCs (mocked supervisor)', () => {
  it('lists turns with the documented summary structure', async () => {
    const { client, dispose } = await bootServer();
    try {
      const res = await client.request<Record<string, any>>(METHOD.CONVERSATION_LIST_TURNS, {});
      expect(res.total).toBe(2);
      expect(res.offset).toBe(0);
      expect(res.limit).toBe(50);
      expect(res.turns).toHaveLength(2);

      const [t1, t2] = res.turns;
      expect(t1).toMatchObject({
        turnId: 'T1',
        rootTurnId: 'T1',
        status: 'completed',
        stepCount: 1,
        signalCount: 0,
        toolCallCount: 1,
        entryCount: 2,
        usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, reasoningTokens: 0, totalTokens: 15 },
      });
      expect(t1.userPreview).toContain('please run the very long task');
      expect(t1.userPreviewTruncated).toBe(true); // 200-char default preview limit
      expect(t2).toMatchObject({
        turnId: 'T2',
        rootTurnId: 'T1',
        status: 'completed',
        stepCount: 1,
        signalCount: 1,
        entryCount: 2,
      });
    } finally {
      await dispose();
    }
  });

  it('paginates with limit/offset while keeping the true total', async () => {
    const { client, dispose } = await bootServer();
    try {
      const res = await client.request<Record<string, any>>(METHOD.CONVERSATION_LIST_TURNS, { limit: 1, offset: 1 });
      expect(res.total).toBe(2);
      expect(res.limit).toBe(1);
      expect(res.offset).toBe(1);
      expect(res.turns).toHaveLength(1);
      expect(res.turns[0].turnId).toBe('T2');

      // offset beyond the end → empty page, total unchanged
      const empty = await client.request<Record<string, any>>(METHOD.CONVERSATION_LIST_TURNS, { limit: 10, offset: 5 });
      expect(empty.turns).toEqual([]);
      expect(empty.total).toBe(2);
    } finally {
      await dispose();
    }
  });

  it('rejects invalid list params with INVALID_PARAMS', async () => {
    const { client, dispose } = await bootServer();
    try {
      await expect(client.request(METHOD.CONVERSATION_LIST_TURNS, { limit: 'x' }))
        .rejects.toThrow(/RPC -32002: Param limit must be an integer/);
      await expect(client.request(METHOD.CONVERSATION_LIST_TURNS, { limit: 0 }))
        .rejects.toThrow(/RPC -32002/);
      await expect(client.request(METHOD.CONVERSATION_LIST_TURNS, { limit: 501 }))
        .rejects.toThrow(/RPC -32002/);
      await expect(client.request(METHOD.CONVERSATION_LIST_TURNS, { offset: -1 }))
        .rejects.toThrow(/RPC -32002/);
      await expect(client.request(METHOD.CONVERSATION_LIST_TURNS, { previewLength: 5000 }))
        .rejects.toThrow(/RPC -32002/);
    } finally {
      await dispose();
    }
  });

  it('returns a full turn by id with the documented structure', async () => {
    const { client, dispose } = await bootServer();
    try {
      const turn = await client.request<Record<string, any>>(METHOD.CONVERSATION_GET_TURN, { turnId: 'T2' });
      expect(turn).toMatchObject({
        turnId: 'T2',
        rootTurnId: 'T1',
        status: 'completed',
        usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
      });
      expect(turn.steps).toHaveLength(1);
      expect(turn.steps[0]).toMatchObject({
        uuid: 'a2',
        stepIndex: 0,
        content: 'all done',
        contentTruncated: false,
        finishReason: 'stop',
        toolCallCount: 0,
        toolResultCount: 0,
      });
      expect(turn.signals).toHaveLength(1);
      expect(turn.signals[0]).toMatchObject({
        uuid: 'sig1',
        subtype: 'worker_completed',
        taskId: 'task-1',
        taskTitle: 'long task',
      });
      expect(turn.entryIds).toEqual(['sig1', 'a2']);
      expect(turn.userEntry).toBeUndefined();
    } finally {
      await dispose();
    }
  });

  it('marks truncated long texts in get_turn responses', async () => {
    const { client, dispose } = await bootServer();
    try {
      const turn = await client.request<Record<string, any>>(METHOD.CONVERSATION_GET_TURN, {
        turnId: 'T1',
        maxTextLength: 12,
      });
      expect(turn.userEntry.content).toBe('please run t…[truncated]');
      expect(turn.userEntry.contentTruncated).toBe(true);
      expect(turn.steps[0].contentTruncated).toBe(true);
      expect(turn.steps[0].content.endsWith('…[truncated]')).toBe(true);
      // The signal lives in T2 — T1's own fields stay untruncated-safe.
      expect(turn.signals).toEqual([]);
    } finally {
      await dispose();
    }
  });

  it('marks truncated signal content in get_turn responses', async () => {
    const { client, dispose } = await bootServer();
    try {
      const turn = await client.request<Record<string, any>>(METHOD.CONVERSATION_GET_TURN, {
        turnId: 'T2',
        maxTextLength: 15,
      });
      expect(turn.signals[0].contentTruncated).toBe(true);
      expect(turn.signals[0].content.endsWith('…[truncated]')).toBe(true);
    } finally {
      await dispose();
    }
  });

  it('rejects unknown turnId with INVALID_PARAMS', async () => {
    const { client, dispose } = await bootServer();
    try {
      await expect(client.request(METHOD.CONVERSATION_GET_TURN, { turnId: 'does-not-exist' }))
        .rejects.toThrow(/RPC -32002: Unknown turnId: does-not-exist/);
    } finally {
      await dispose();
    }
  });

  it('rejects get_turn with a missing or non-string turnId', async () => {
    const { client, dispose } = await bootServer();
    try {
      await expect(client.request(METHOD.CONVERSATION_GET_TURN, {}))
        .rejects.toThrow(/RPC -32002: Missing required string param: turnId/);
      await expect(client.request(METHOD.CONVERSATION_GET_TURN, { turnId: 42 }))
        .rejects.toThrow(/RPC -32002/);
      await expect(client.request(METHOD.CONVERSATION_GET_TURN, { turnId: 'T1', maxTextLength: 0 }))
        .rejects.toThrow(/RPC -32002/);
    } finally {
      await dispose();
    }
  });
});
