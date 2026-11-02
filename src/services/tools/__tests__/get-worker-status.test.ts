import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getWorkerStatusTool } from '@/services/tools/get-worker-status';
import { readWorkerTranscript } from '@/services/worker-transcript';
import type { ActiveWorkerInfo, TaskDetail, WorkerLiveStatus } from '@/types/index';
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

const NOW = Date.parse('2026-11-02T12:00:00.000+08:00');

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
} = {}) {
  return getWorkerStatusTool({
    listWorkers: () => opts.workers ?? [],
    listTasks: () => opts.tasks ?? [],
    readTranscript: (workerId) => readWorkerTranscript(fx.sessionDir, workerId),
    getLiveStatus: (workerId) => opts.live?.[workerId],
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
