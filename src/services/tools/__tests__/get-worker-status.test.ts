import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getWorkerStatusTool } from '@/services/tools/get-worker-status';
import { readWorkerTranscript, readWorkerTranscriptWindow } from '@/services/worker-transcript';
import { readWorkerConversationTool } from '@/services/tools/read-worker-conversation';
import type { ActiveWorkerInfo, TaskDetail, WorkerLiveStatus } from '@/types/index';
import type { ConversationEntry } from '@/types/conversation';
import { makeTask } from '@/__tests__/helpers';
import {
  createTranscriptFixture,
  makeEntry,
  makeIncidentTranscript,
  type TranscriptFixture,
} from './worker-transcript-fixture';

async function exec(toolObj: any, args: any): Promise<string> {
  return toolObj.execute(args);
}

/** Pull the JSON status object/array out of the tool output. */
function readStatus(output: string): any {
  const tag = '[worker-status] ';
  const line = output.split('\n').find((l) => l.startsWith(tag));
  expect(line, 'missing [worker-status] line').toBeDefined();
  return JSON.parse((line as string).slice(tag.length));
}

/** Pull the JSON meta object out of read_worker_conversation's output. */
function readTranscriptMeta(output: string): any {
  const tag = '[transcript-meta] ';
  const line = output.split('\n').find((l) => l.startsWith(tag));
  expect(line, 'missing [transcript-meta] line').toBeDefined();
  return JSON.parse((line as string).slice(tag.length));
}

const NOW = Date.parse('2026-11-02T12:00:00.000+08:00');
/** makeEntry() timestamps are BASE_MS + offset; NOW is 2h past BASE_MS. */
const NOW_OFFSET_MS = 7_200_000;

let fx: TranscriptFixture;
const entries = makeIncidentTranscript();

function activeWorker(overrides: Partial<ActiveWorkerInfo> = {}): ActiveWorkerInfo {
  return {
    workerId: 'cw-1',
    taskId: 't1',
    startedAt: NOW - 571_000,
    workerType: 'claude-code',
    taskTitle: 'Review the branch',
    emoji: '🤖',
    status: 'running',
    ...overrides,
  };
}

function makeTool(opts: {
  workers?: ActiveWorkerInfo[];
  tasks?: TaskDetail[];
  live?: Record<string, WorkerLiveStatus>;
  /** Live in-memory conversations keyed by ENGINE worker id. */
  memory?: Record<string, ConversationEntry[]>;
  /** Transcript directory ids keyed by ENGINE worker id. */
  transcriptIds?: Record<string, string>;
} = {}) {
  return getWorkerStatusTool({
    listWorkers: () => opts.workers ?? [],
    listTasks: () => opts.tasks ?? [],
    readTranscript: (workerId) => readWorkerTranscript(fx.sessionDir, workerId),
    getWorkerConversationByWorkerId: (workerId) => opts.memory?.[workerId],
    getWorkerTranscriptId: (workerId) => opts.transcriptIds?.[workerId],
    getLiveStatus: (workerId) => opts.live?.[workerId],
    now: () => NOW,
  });
}

/** Same wiring, on the read_worker_conversation side, for cross-tool checks. */
function makeConversationTool(opts: {
  workers?: ActiveWorkerInfo[];
  tasks?: TaskDetail[];
  memory?: Record<string, ConversationEntry[]>;
  transcriptIds?: Record<string, string>;
} = {}) {
  return readWorkerConversationTool({
    sessionDir: fx.sessionDir,
    getWorkerConversationByWorkerId: (workerId) => opts.memory?.[workerId],
    getWorkerTranscriptId: (workerId) => opts.transcriptIds?.[workerId],
    readTranscriptWindow: (workerId, readOpts) => readWorkerTranscriptWindow(fx.sessionDir, workerId, readOpts),
    listWorkers: () => opts.workers ?? [],
    listTasks: () => opts.tasks ?? [],
    now: () => NOW,
  });
}

beforeEach(() => {
  fx = createTranscriptFixture();
});

afterEach(() => {
  fx.cleanup();
});

describe('getWorkerStatusTool', () => {
  it('reports the live worker from the incident: result arrived, stream not closed', async () => {
    fx.writeTranscript('cw-1', entries);
    const tool = makeTool({
      workers: [activeWorker()],
      tasks: [makeTask('t1', { status: 'running', workerSessionId: 'cw-1', startedAt: NOW - 571_000 })],
      live: { 'cw-1': { resultReceived: true, streamEnded: false } },
    });

    const out = await exec(tool, { workerId: 'cw-1' });
    expect(out).toContain('Worker cw-1 (claude-code)');
    expect(out).toContain('status: running');
    expect(out).toContain('streamEnded: false');
    expect(out).toContain('resultReceived: true');
    expect(out).toContain('currentTool: bash');

    const status = readStatus(out);
    expect(status.workerId).toBe('cw-1');
    expect(status.type).toBe('claude-code');
    expect(status.taskId).toBe('t1');
    expect(status.status).toBe('running');
    expect(status.live).toBe(true);
    expect(status.runningForMs).toBe(571_000);
    expect(status.lastActivityAt).toBe(Date.parse(String((entries[entries.length - 1] as any).timestamp)));
    expect(status.lastActivityAgoMs).toBe(NOW - status.lastActivityAt);
    expect(status.currentTool).toBe('bash');
    expect(status.streamEnded).toBe(false);
    expect(status.resultReceived).toBe(true);
    expect(status.idleSince).toBeNull();
    expect(status.entries).toBe(21);
  });

  it('falls back to transcript inference when the worker type reports no live flags', async () => {
    fx.writeTranscript('cw-1', entries);
    const tool = makeTool({ workers: [activeWorker()] });
    const status = readStatus(await exec(tool, { workerId: 'cw-1' }));

    // Terminal task_result marker on disk proves both facts.
    expect(status.resultReceived).toBe(true);
    expect(status.streamEnded).toBe(true);
  });

  it('returns "unknown" rather than guessing for a live puppet worker with no terminal marker', async () => {
    fx.writeTranscript('w-1', [makeEntry('user', 'do it'), makeEntry('assistant', 'working')]);
    const tool = makeTool({
      workers: [activeWorker({ workerId: 'w-1', workerType: 'puppet' })],
      live: { 'w-1': { resultReceived: false, streamEnded: null } },
    });

    const status = readStatus(await exec(tool, { workerId: 'w-1' }));
    expect(status.resultReceived).toBe(false);
    expect(status.streamEnded).toBeNull();
  });

  it('reports a finished worker from disk after it left the engine map', async () => {
    fx.writeTranscript('cw-1', entries);
    const tool = makeTool({
      tasks: [makeTask('t1', {
        status: 'completed',
        workerSessionId: 'cw-1',
        workerType: 'claude-code',
        startedAt: NOW - 700_000,
        completedAt: NOW - 129_000,
      })],
    });

    const out = await exec(tool, { workerId: 'cw-1' });
    const status = readStatus(out);
    expect(status.status).toBe('completed');
    expect(status.live).toBe(false);
    expect(status.resultReceived).toBe(true);
    expect(status.streamEnded).toBe(true);
    expect(status.runningForMs).toBe(571_000);
    expect(out).toContain('(no longer tracked)');
  });

  it('includes idleSince for a parked multi-stage worker', async () => {
    fx.writeTranscript('w-1', [makeEntry('user', 'stage 1')]);
    const tool = makeTool({
      workers: [activeWorker({ workerId: 'w-1', workerType: 'puppet', status: 'idle', idleSinceMs: NOW - 60_000 })],
    });
    const status = readStatus(await exec(tool, { workerId: 'w-1' }));
    expect(status.status).toBe('idle');
    expect(status.idleSince).toBe(NOW - 60_000);
  });

  it('lists all current workers when workerId is omitted', async () => {
    fx.writeTranscript('cw-1', entries);
    fx.writeTranscript('w-1', [makeEntry('user', 'hello')]);
    const tool = makeTool({
      workers: [activeWorker(), activeWorker({ workerId: 'w-1', workerType: 'puppet', taskId: 't2' })],
    });

    const out = await exec(tool, {});
    expect(out).toContain('Workers (2):');
    const statuses = readStatus(out);
    expect(Array.isArray(statuses)).toBe(true);
    expect(statuses).toHaveLength(2);
    expect(statuses.map((s: any) => s.workerId).sort()).toEqual(['cw-1', 'w-1']);
  });

  it('says so when nothing is running', async () => {
    const out = await exec(makeTool(), {});
    expect(out).toContain('No workers are running or idle');
    expect(readStatus(out)).toEqual([]);
  });

  it('rejects path-traversal worker ids', async () => {
    const out = await exec(makeTool(), { workerId: '../etc' });
    expect(out).toContain('Invalid worker id');
    expect(out).not.toContain('[ERROR]');
  });

  it('returns a not-found message for an unknown workerId instead of throwing', async () => {
    const out = await exec(makeTool(), { workerId: 'ghost' });
    expect(out).toContain('Worker ghost not found');
    expect(out).not.toContain('[ERROR]');
    expect(out).not.toContain('[worker-status]');
  });
});

describe('getWorkerStatusTool — activity source resolution (engine id vs transcript dir id)', () => {
  /**
   * Production shape: the ENGINE tracks the worker as w-…, while its
   * transcript lives under the worker INSTANCE's own id (cw-…/agent-…).
   * Before the layered resolution this tool read workers/<engine-id>/,
   * which never exists — busy workers reported lastActivityAt=null and
   * entries=0 while read_worker_conversation showed full activity.
   */
  function freshMemory(): ConversationEntry[] {
    return [
      makeEntry('user', 'do it', { timestampOffsetMs: NOW_OFFSET_MS - 5000 }),
      makeEntry('assistant', 'working', {
        timestampOffsetMs: NOW_OFFSET_MS - 3000,
        toolCalls: [{ toolName: 'bash', arguments: '{"command":"git status"}' }],
      }),
      makeEntry('assistant', 'still working', { timestampOffsetMs: NOW_OFFSET_MS - 1000 }),
    ] as unknown as ConversationEntry[];
  }

  it('live worker keyed by the engine id reads its in-memory conversation, not a missing disk path', async () => {
    // A stale on-disk copy exists under the INSTANCE id; nothing under w-1.
    fx.writeTranscript('cw-1', entries);
    const tool = makeTool({
      workers: [activeWorker({ workerId: 'w-1' })],
      tasks: [makeTask('t1', {
        status: 'running', workerSessionId: 'w-1', workerTranscriptId: 'cw-1', startedAt: NOW - 571_000,
      })],
      memory: { 'w-1': freshMemory() },
      transcriptIds: { 'w-1': 'cw-1' },
    });

    const status = readStatus(await exec(tool, { workerId: 'w-1' }));
    expect(status.status).toBe('running');
    expect(status.live).toBe(true);
    expect(status.activitySource).toBe('memory');
    expect(status.entries).toBe(3);
    // Freshest entry is 1s old — well within the 5s freshness requirement.
    expect(status.lastActivityAgoMs).toBe(1000);
    expect(status.lastActivityAt).toBe(NOW - 1000);
    expect(status.currentTool).toBe('bash');
    expect(status.lastEntryType).toBe('assistant');
  });

  it('live worker with no in-memory entries falls back to the instance-id transcript directory', async () => {
    fx.writeTranscript('cw-1', entries);
    const tool = makeTool({
      workers: [activeWorker({ workerId: 'w-1' })],
      tasks: [makeTask('t1', {
        status: 'running', workerSessionId: 'w-1', workerTranscriptId: 'cw-1', startedAt: NOW - 571_000,
      })],
      transcriptIds: { 'w-1': 'cw-1' },
    });

    const status = readStatus(await exec(tool, { workerId: 'w-1' }));
    expect(status.activitySource).toBe('disk');
    expect(status.entries).toBe(21);
    expect(status.currentTool).toBe('bash');
    expect(status.lastEntryType).toBe('system');
  });

  it('entries match read_worker_conversation totalEntries for the same worker (memory and disk)', async () => {
    fx.writeTranscript('cw-1', entries);
    const opts = {
      workers: [activeWorker({ workerId: 'w-1' })],
      tasks: [makeTask('t1', {
        status: 'running', workerSessionId: 'w-1', workerTranscriptId: 'cw-1', startedAt: NOW - 571_000,
      })],
      memory: { 'w-1': freshMemory() },
      transcriptIds: { 'w-1': 'cw-1' },
    };
    const status = readStatus(await exec(makeTool(opts), { workerId: 'w-1' }));
    const meta = readTranscriptMeta(await exec(makeConversationTool(opts), { workerId: 'w-1' }));
    expect(meta.source).toBe('memory');
    expect(meta.totalEntries).toBe(status.entries);

    const diskOpts = { ...opts, memory: undefined };
    const diskStatus = readStatus(await exec(makeTool(diskOpts), { workerId: 'w-1' }));
    const diskMeta = readTranscriptMeta(await exec(makeConversationTool(diskOpts), { workerId: 'w-1' }));
    expect(diskMeta.source).toBe('disk');
    expect(diskMeta.transcriptId).toBe('cw-1');
    expect(diskMeta.totalEntries).toBe(diskStatus.entries);
  });

  it('finished worker resolves the transcript through the task persisted workerTranscriptId', async () => {
    fx.writeTranscript('cw-1', entries);
    const tool = makeTool({
      tasks: [makeTask('t1', {
        status: 'completed',
        workerSessionId: 'w-1',
        workerTranscriptId: 'cw-1',
        workerType: 'claude-code',
        startedAt: NOW - 700_000,
        completedAt: NOW - 129_000,
      })],
    });

    const status = readStatus(await exec(tool, { workerId: 'w-1' }));
    expect(status.status).toBe('completed');
    expect(status.live).toBe(false);
    expect(status.activitySource).toBe('disk');
    expect(status.entries).toBe(21);
    expect(status.lastActivityAt).toBe(Date.parse(String((entries[entries.length - 1] as any).timestamp)));
    expect(status.runningForMs).toBe(571_000);

    // The same finished worker is also reachable by its instance id.
    const byInstanceId = readStatus(await exec(tool, { workerId: 'cw-1' }));
    expect(byInstanceId.taskId).toBe('t1');
    expect(byInstanceId.status).toBe('completed');
    expect(byInstanceId.entries).toBe(21);
  });

  it('idle worker reports idleSince and reads its in-memory conversation', async () => {
    const tool = makeTool({
      workers: [activeWorker({
        workerId: 'w-1', workerType: 'puppet', status: 'idle', idleSinceMs: NOW - 60_000,
      })],
      memory: { 'w-1': freshMemory() },
    });
    const status = readStatus(await exec(tool, { workerId: 'w-1' }));
    expect(status.status).toBe('idle');
    expect(status.idleSince).toBe(NOW - 60_000);
    expect(status.activitySource).toBe('memory');
    expect(status.entries).toBe(3);
  });

  it('a tracked worker that wrote nothing: source=none, null activity — distinct from a type that tracks nothing', async () => {
    // Puppet: activity fields null because there are no entries yet, while
    // streamEnded/resultReceived null mean the TYPE does not record them.
    const puppet = readStatus(await exec(makeTool({
      workers: [activeWorker({ workerId: 'w-1', workerType: 'puppet' })],
    }), { workerId: 'w-1' }));
    expect(puppet.status).toBe('running');
    expect(puppet.activitySource).toBe('none');
    expect(puppet.lastActivityAt).toBeNull();
    expect(puppet.lastActivityAgoMs).toBeNull();
    expect(puppet.currentTool).toBeNull();
    expect(puppet.lastEntryType).toBeNull();
    expect(puppet.entries).toBe(0);
    expect(puppet.streamEnded).toBeNull();
    expect(puppet.resultReceived).toBeNull();

    // Claude-code with nothing written: same "no entries", but the terminal
    // flags are tracked facts (false), not unknowns.
    const claude = readStatus(await exec(makeTool({
      workers: [activeWorker({ workerId: 'w-2', taskId: 't2' })],
    }), { workerId: 'w-2' }));
    expect(claude.activitySource).toBe('none');
    expect(claude.lastActivityAt).toBeNull();
    expect(claude.entries).toBe(0);
    expect(claude.streamEnded).toBe(false);
    expect(claude.resultReceived).toBe(false);
  });
});
