import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWorkerConversationTool } from '@/services/tools/read-worker-conversation';
import { readWorkerTranscript, workerTranscriptPath } from '@/services/worker-transcript';
import type { ActiveWorkerInfo, TaskDetail } from '@/types/index';
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

function readMeta(output: string): any {
  const tag = '[transcript-meta] ';
  const line = output.split('\n').find((l) => l.startsWith(tag));
  expect(line, 'missing [transcript-meta] line').toBeDefined();
  return JSON.parse((line as string).slice(tag.length));
}

function countEntryLines(output: string): number {
  return output.split('\n').filter((l) => /^ {2}#\d+ \[/.test(l)).length;
}

const NOW = Date.parse('2026-11-02T12:00:00.000+08:00');

let fx: TranscriptFixture;
const entries = makeIncidentTranscript();

function makeTool(opts: { workers?: ActiveWorkerInfo[]; tasks?: TaskDetail[] } = {}) {
  return readWorkerConversationTool({
    sessionDir: fx.sessionDir,
    readTranscript: (workerId) => readWorkerTranscript(fx.sessionDir, workerId),
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

describe('readWorkerConversationTool', () => {
  it('reads the transcript straight from disk (no in-memory worker needed)', async () => {
    fx.writeTranscript('cw-1', entries);
    const tool = makeTool();

    const out = await exec(tool, { workerId: 'cw-1' });

    expect(out).toContain(workerTranscriptPath(fx.sessionDir, 'cw-1'));
    expect(out).toContain('Conversation (21 entries total, showing 2-21 by offset=0 limit=20)');
    expect(out).toContain('[truncated: showing 20 of 21 entries (2-21), per-entry limit 200 chars');
    const meta = readMeta(out);
    expect(meta.workerId).toBe('cw-1');
    expect(meta.totalEntries).toBe(21);
    expect(meta.returnedEntries).toBe(20);
    expect(meta.offset).toBe(0);
    expect(meta.truncated).toBe(true);
    expect(countEntryLines(out)).toBe(meta.returnedEntries);
  });

  it('totalEntries matches the number of lines in the jsonl file', async () => {
    fx.writeTranscript('cw-1', entries);
    const out = await exec(makeTool(), { workerId: 'cw-1', limit: 100 });
    expect(readMeta(out).totalEntries).toBe(entries.length);
    expect(readMeta(out).returnedEntries).toBe(entries.length);
    expect(readMeta(out).truncated).toBe(true); // per-entry caps still cut the report
  });

  it('pages backwards with offset and keeps chronological order', async () => {
    fx.writeTranscript('cw-1', entries);
    const tool = makeTool();

    const first = await exec(tool, { workerId: 'cw-1', offset: 0, limit: 3 });
    const second = await exec(tool, { workerId: 'cw-1', offset: 3, limit: 3 });

    const firstMeta = readMeta(first);
    const secondMeta = readMeta(second);
    expect(firstMeta.startIndex).toBe(19);
    expect(firstMeta.endIndex).toBe(21);
    expect(secondMeta.startIndex).toBe(16);
    expect(secondMeta.endIndex).toBe(18);

    // Chronological order inside a window: lower index printed first.
    const indexes = second.split('\n')
      .map((l) => /^ {2}#(\d+) \[/.exec(l)?.[1])
      .filter((v): v is string => v !== undefined)
      .map(Number);
    expect(indexes).toEqual([16, 17, 18]);
  });

  it('full=true returns the complete 4642-char report and every entry', async () => {
    fx.writeTranscript('cw-1', entries);
    const out = await exec(makeTool(), { workerId: 'cw-1', full: true });

    expect(out).toContain('Conversation (21 entries):');
    expect(out).toContain('REPORT_TAIL_MARKER');
    expect(out).not.toContain('[truncated:');
    expect(countEntryLines(out)).toBe(21);
    const meta = readMeta(out);
    expect(meta.full).toBe(true);
    expect(meta.returnedEntries).toBe(21);
    expect(meta.truncated).toBe(false);
  });

  it('filters by entry type, keeping both counts visible', async () => {
    fx.writeTranscript('cw-1', entries);
    const tool = makeTool();

    const assistants = await exec(tool, { workerId: 'cw-1', type: 'assistant', full: true });
    const meta = readMeta(assistants);
    expect(meta.filter).toBe('assistant');
    expect(meta.totalEntriesBeforeFilter).toBe(21);
    expect(meta.totalEntries).toBe(19); // 18 steps + the final report
    expect(assistants).toContain('type=assistant; 21 entries in transcript');

    const systems = await exec(tool, { workerId: 'cw-1', type: 'system' });
    expect(readMeta(systems).totalEntries).toBe(1);
    expect(systems).toContain('[system/task_result]');
  });

  it('supports type=tool for entries that made tool calls', async () => {
    fx.writeTranscript('cw-1', entries);
    const out = await exec(makeTool(), { workerId: 'cw-1', type: 'tool' });
    const meta = readMeta(out);
    expect(meta.totalEntries).toBeGreaterThan(0);
    expect(out).toContain('(tools: bash)');
    expect(out).not.toContain('[system/task_result]');
  });

  it('reports worker not found for an unknown id', async () => {
    const out = await exec(makeTool(), { workerId: 'ghost' });
    expect(out).toContain('Worker ghost not found');
    expect(out).not.toContain('[transcript-meta]');
  });

  it('reports a missing transcript for a known worker', async () => {
    const workers: ActiveWorkerInfo[] = [{
      workerId: 'cw-1', taskId: 't1', startedAt: NOW - 5000, workerType: 'claude-code',
      taskTitle: 'Review', emoji: '🤖', status: 'running',
    }];
    const out = await exec(makeTool({ workers }), { workerId: 'cw-1' });
    expect(out).toContain('no transcript found for worker cw-1');
    expect(out).toContain(`session dir: ${fx.sessionDir}`);
  });

  it('stays readable after the worker finished and left the engine map', async () => {
    fx.writeTranscript('cw-1', entries);
    // No active workers; only a settled task still references the worker id.
    const tasks = [makeTask('t1', { status: 'completed', workerSessionId: 'cw-1', workerType: 'claude-code' })];
    const out = await exec(makeTool({ tasks }), { workerId: 'cw-1', limit: 2, offset: 0 });

    expect(out).toContain('[system/task_result]');
    expect(readMeta(out).totalEntries).toBe(21);
    expect(readMeta(out).returnedEntries).toBe(2);
  });

  it('tolerates a torn last line without failing the read', async () => {
    fx.writeTranscript('cw-1', [makeEntry('user', 'hello'), makeEntry('assistant', 'world')]);
    const fs = await import('node:fs');
    fs.appendFileSync(workerTranscriptPath(fx.sessionDir, 'cw-1'), '{"type":"assistant","mess');

    const out = await exec(makeTool(), { workerId: 'cw-1' });
    expect(readMeta(out).totalEntries).toBe(2);
    expect(out).not.toContain('[ERROR]');
  });

  it('drops the oldest entries instead of overflowing the tool-output cap', async () => {
    const big = Array.from({ length: 30 }, (_, i) => makeEntry('assistant', `entry ${i} ` + 'y'.repeat(3000)));
    fx.writeTranscript('cw-big', big);

    const out = await exec(makeTool(), { workerId: 'cw-big', full: true });
    const meta = readMeta(out);

    expect(out.length).toBeLessThanOrEqual(40_000);
    expect(meta.totalEntries).toBe(30);
    expect(meta.returnedEntries).toBeLessThan(30);
    expect(meta.truncated).toBe(true);
    expect(out).toContain('output cap reached');
    // The newest entry always survives.
    expect(out).toContain('entry 29 ');
  });

  it('refuses path-traversal worker ids (read-only tool, no arbitrary file reads)', async () => {
    fx.writeTranscript('cw-1', entries);
    const out = await exec(makeTool(), { workerId: '../../other-session/workers/cw-1' });
    expect(out).toContain('Invalid worker id');
    expect(out).not.toContain('Conversation');
    expect(out).not.toContain('transcript:');
  });

  it('surfaces activity so liveness can be judged from the same call', async () => {
    fx.writeTranscript('cw-1', entries);
    const out = await exec(makeTool(), { workerId: 'cw-1', limit: 1 });
    expect(out).toContain('Last activity: ');
    expect(out).toContain('currentTool: bash');
    expect(out).toContain('terminal marker: task_result');
  });
});
