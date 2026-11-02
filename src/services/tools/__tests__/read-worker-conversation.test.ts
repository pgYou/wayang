import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWorkerConversationTool } from '@/services/tools/read-worker-conversation';
import {
  readWorkerTranscriptWindow,
  workerTranscriptPath,
} from '@/services/worker-transcript';
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

interface ToolOpts {
  workers?: ActiveWorkerInfo[];
  tasks?: TaskDetail[];
  memoryConversation?: Record<string, any[]>;
  transcriptIds?: Record<string, string>;
}

function makeTool(opts: ToolOpts = {}) {
  return readWorkerConversationTool({
    sessionDir: fx.sessionDir,
    getWorkerConversationByWorkerId: (workerId) => opts.memoryConversation?.[workerId],
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

  it('full=true renders tool result text (not [object Object]) and flags errors', async () => {
    // A claude-code-shaped step: text + toolCalls + toolResults on one entry.
    const toolEntries = [
      makeEntry('user', 'Fix the failing test.'),
      makeEntry('assistant', 'Running the suite', {
        toolCalls: [
          { toolCallId: 't1', toolName: 'Bash', arguments: '{"command":"npm test"}' },
          { toolCallId: 't2', toolName: 'Bash', arguments: '{"command":"npm run build"}' },
        ],
        toolResults: [
          { toolCallId: 't1', toolName: 'Bash', output: { type: 'text', value: '1 test failed' }, isError: true },
          { toolCallId: 't2', toolName: 'Bash', output: { type: 'text', value: 'build ok' } },
        ],
      }),
      makeEntry('system', 'Fixed.', { subtype: 'task_result' }),
    ];
    fx.writeTranscript('cw-tool', toolEntries);

    const out = await exec(makeTool(), { workerId: 'cw-tool', full: true });

    // Tool result values render as text — output is {type:'text', value} on
    // the schema, which must not degrade to "[object Object]".
    expect(out).toContain('↳ result [error]: 1 test failed');
    expect(out).toContain('↳ result: build ok');
    expect(out).not.toContain('[object Object]');
    expect(out).toContain('↳ Bash {"command":"npm test"}');
  });

  it('reports unknown worker when nothing references the id', async () => {
    const out = await exec(makeTool(), { workerId: 'ghost' });
    expect(out).toContain('Unknown worker ghost: no active worker and no task references it.');
    expect(out).not.toContain('[transcript-meta]');
  });

  it('reports an active worker that has not written anything yet', async () => {
    const workers: ActiveWorkerInfo[] = [{
      workerId: 'w-1', taskId: 't1', startedAt: NOW - 5000, workerType: 'claude-code',
      taskTitle: 'Review', emoji: '🤖', status: 'running',
    }];
    const out = await exec(makeTool({ workers }), { workerId: 'w-1' });
    expect(out).toContain('Worker w-1 is running but has not written any transcript entries yet.');
    expect(out).not.toContain('[transcript-meta]');
  });

  it('distinguishes the three failure modes instead of one vague "no transcript found"', async () => {
    // 1) unknown: no active worker, no task reference, nothing on disk.
    const unknown = await exec(makeTool(), { workerId: 'ghost' });
    expect(unknown).toContain('Unknown worker ghost: no active worker and no task references it.');

    // 2) known but not locatable: a task references the engine id, but the
    //    task predates workerTranscriptId and no dir exists under that id.
    const legacyTasks = [makeTask('t1', { status: 'completed', workerSessionId: 'w-legacy' })];
    const legacy = await exec(makeTool({ tasks: legacyTasks }), { workerId: 'w-legacy' });
    expect(legacy).toContain('Worker w-legacy exists but its transcript cannot be located on disk (legacy session id layout?).');

    // 3) empty file: the transcript exists but holds no complete entry.
    fx.writeTranscript('cw-empty', []);
    const empty = await exec(makeTool(), { workerId: 'cw-empty' });
    expect(empty).toContain('Transcript for worker cw-empty exists but contains no complete entries yet.');
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

  it('flags a torn last line as incompleteTail in meta and in a visible note', async () => {
    fx.writeTranscript('cw-1', [makeEntry('user', 'hello'), makeEntry('assistant', 'world')]);
    const fs = await import('node:fs');
    fs.appendFileSync(workerTranscriptPath(fx.sessionDir, 'cw-1'), '{"type":"assistant","mess');

    const out = await exec(makeTool(), { workerId: 'cw-1' });
    expect(out).toContain('[note: last entry is incomplete — the transcript is still being written]');
    const meta = readMeta(out);
    expect(meta.incompleteTail).toBe(true);
    // The complete prefix is kept.
    expect(countEntryLines(out)).toBe(2);
  });

  it('returns the live in-memory conversation (source=memory) while the worker runs, with nothing on disk', async () => {
    const memory = [makeEntry('user', 'task'), makeEntry('assistant', 'step 1')];
    const workers: ActiveWorkerInfo[] = [{
      workerId: 'w-1', taskId: 't1', startedAt: NOW - 1000, workerType: 'puppet',
      taskTitle: 'Work', emoji: '🤖', status: 'running',
    }];
    // No transcript on disk for either id namespace.
    const out = await exec(
      makeTool({ workers, memoryConversation: { 'w-1': memory } }),
      { workerId: 'w-1' },
    );

    const meta = readMeta(out);
    expect(meta.source).toBe('memory');
    expect(meta.totalEntries).toBe(2);
    expect(meta.returnedEntries).toBe(2);
    expect(meta.readWindowTruncated).toBe(false);
    expect(out).toContain('source=memory');
    expect(out).toContain('step 1');
    // The disk-only path line is not used for a memory read.
    expect(out).not.toContain('source=disk');
  });

  it('reads the disk transcript through workerTranscriptId after the worker finished (source=disk)', async () => {
    // Engine id w-1 references the task; the file lives under cw-9 only.
    fx.writeTranscript('cw-9', entries);
    const tasks = [makeTask('t1', {
      status: 'completed',
      workerSessionId: 'w-1',
      workerTranscriptId: 'cw-9',
      workerType: 'claude-code',
    })];
    const out = await exec(makeTool({ tasks }), { workerId: 'w-1', limit: 2, offset: 0 });

    const meta = readMeta(out);
    expect(meta.source).toBe('disk');
    expect(meta.transcriptId).toBe('cw-9');
    expect(meta.totalEntries).toBe(21);
    expect(meta.returnedEntries).toBe(2);
    expect(out).toContain(workerTranscriptPath(fx.sessionDir, 'cw-9'));
    expect(out).toContain('[system/task_result]');
  });

  it('falls back to the live transcript id for a tracked worker whose task is not stamped yet', async () => {
    fx.writeTranscript('agent-7', [makeEntry('user', 'ping'), makeEntry('assistant', 'pong')]);
    const workers: ActiveWorkerInfo[] = [{
      workerId: 'w-1', taskId: 't1', startedAt: NOW - 1000, workerType: 'puppet',
      taskTitle: 'Work', emoji: '🤖', status: 'running',
    }];
    // Memory lookup misses (worker conversation empty), task carries no
    // workerTranscriptId — the engine-side transcript id still resolves.
    const out = await exec(
      makeTool({ workers, transcriptIds: { 'w-1': 'agent-7' } }),
      { workerId: 'w-1' },
    );
    const meta = readMeta(out);
    expect(meta.source).toBe('disk');
    expect(meta.transcriptId).toBe('agent-7');
    expect(meta.totalEntries).toBe(2);
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

  it('documents the pagination semantics it actually implements', async () => {
    const tool = makeTool();
    for (const sentence of [
      'offset skips N entries counted back from the newest',
      'output is ordered oldest→newest',
      'type filtering is applied BEFORE pagination',
    ]) {
      expect(tool.description).toContain(sentence);
    }
  });
});

describe('readWorkerConversationTool — tail-bounded disk reads', () => {
  /** ~550 bytes per line: 5000 entries ≈ 2.7 MB, past the 2 MB read cap. */
  const BIG_ENTRY_PAD = 'z'.repeat(480);

  function writeBigTranscript(workerId: string, count: number): void {
    const big = Array.from({ length: count }, (_, i) => makeEntry('assistant', `entry ${i} ${BIG_ENTRY_PAD}`));
    fx.writeTranscript(workerId, big);
  }

  it('returns only the last N entries of a 5000-entry transcript without reading it whole', async () => {
    writeBigTranscript('cw-big', 5000);
    const out = await exec(makeTool(), { workerId: 'cw-big' });

    const meta = readMeta(out);
    expect(meta.returnedEntries).toBe(20); // default limit
    expect(meta.readWindowTruncated).toBe(true);
    expect(meta.windowTruncated).toBe(true);
    expect(out).toContain('older entries exist beyond the read-window cap');
    expect(out).toContain('page back with offset/limit');
    // The newest entry always survives.
    expect(out).toContain('entry 4999 ');
  });

  it('never yields a half entry at the read-window boundary', async () => {
    writeBigTranscript('cw-big', 5000);
    const out = await exec(makeTool(), { workerId: 'cw-big', limit: 20 });

    const nums = out.split('\n')
      .map((l) => /^ {2}#\d+ \[assistant\](?: \(truncated: \d+\/\d+ chars\))? entry (\d+) /.exec(l)?.[1])
      .filter((v): v is string => v !== undefined)
      .map(Number);
    expect(nums).toHaveLength(20);
    // A window cut mid-line would surface as a dropped or garbled entry:
    // the 20 returned entries must be 20 consecutive, complete entries.
    expect(nums).toEqual(Array.from({ length: 20 }, (_, i) => nums[0] + i));
    expect(nums[0]).toBeGreaterThan(0);
    expect(nums[19]).toBe(4999);
  });

  it('full=true respects the same 2 MB hard cap and says so', async () => {
    writeBigTranscript('cw-big', 5000);
    const out = await exec(makeTool(), { workerId: 'cw-big', full: true });

    const meta = readMeta(out);
    expect(meta.full).toBe(true);
    expect(meta.readWindowTruncated).toBe(true);
    expect(meta.totalEntries).toBeLessThan(5000);
    expect(meta.truncated).toBe(true);
    expect(out).toContain('older entries exist beyond the read-window cap');
  });

  it('pages past the window with offset once the entries fit the window', async () => {
    writeBigTranscript('cw-big', 5000);
    // offset+limit=520 entries ≈ 350 KB — inside the cap, so the read window
    // grows to cover them and the page is exact: it skips the newest 500
    // file entries and returns file entries 4480-4499.
    const out = await exec(makeTool(), { workerId: 'cw-big', offset: 500, limit: 20 });
    const meta = readMeta(out);
    expect(meta.returnedEntries).toBe(20);
    expect(meta.readWindowTruncated).toBe(true); // older entries still exist beyond the window
    const nums = out.split('\n')
      .map((l) => /^ {2}#\d+ \[assistant\](?: \(truncated: \d+\/\d+ chars\))? entry (\d+) /.exec(l)?.[1])
      .filter((v): v is string => v !== undefined)
      .map(Number);
    expect(nums).toEqual(Array.from({ length: 20 }, (_, i) => 4480 + i));
  });

  it('readWorkerTranscriptWindow: growth stops once enough entries are parsed', async () => {
    writeBigTranscript('cw-big', 5000);
    const win = readWorkerTranscriptWindow(fx.sessionDir, 'cw-big', { need: 5 });
    expect(win).not.toBeNull();
    expect((win as { entries: unknown[]; coversFile: boolean; windowTruncated: boolean }).coversFile).toBe(false);
    expect((win as { entries: unknown[]; windowTruncated: boolean }).windowTruncated).toBe(true);
    // Only a bounded tail was parsed — far from the full 5000 entries.
    const count = (win as { entries: unknown[] }).entries.length;
    expect(count).toBeGreaterThanOrEqual(5);
    expect(count).toBeLessThan(1000);
    // Every parsed entry is complete (no boundary half entry).
    for (const e of (win as { entries: Array<{ type: string; uuid: string }> }).entries) {
      expect(typeof e.uuid).toBe('string');
      expect(e.type).toBe('assistant');
    }
  });

  it('readWorkerTranscriptWindow: small files are still read exactly, with coversFile', async () => {
    fx.writeTranscript('cw-1', entries);
    const win = readWorkerTranscriptWindow(fx.sessionDir, 'cw-1', { need: 20 });
    expect(win).toEqual({
      entries: expect.any(Array),
      incompleteTail: false,
      windowTruncated: false,
      coversFile: true,
    });
    expect((win as { entries: unknown[] }).entries).toHaveLength(21);
  });

  it('readWorkerTranscriptWindow: returns null for a missing file and an empty result for an empty file', async () => {
    expect(readWorkerTranscriptWindow(fx.sessionDir, 'ghost')).toBeNull();
    fx.writeTranscript('cw-empty', []);
    expect(readWorkerTranscriptWindow(fx.sessionDir, 'cw-empty')).toEqual({
      entries: [],
      incompleteTail: false,
      windowTruncated: false,
      coversFile: true,
    });
  });
});
