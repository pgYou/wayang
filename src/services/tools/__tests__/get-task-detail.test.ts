import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTaskDetailTool } from '@/services/tools/get-task-detail';
import { readWorkerTranscriptWindow } from '@/services/worker-transcript';
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

/** Pull the machine-readable metadata line out of the tool output. */
function readMeta(output: string, tag = '[conversation-meta] '): any {
  const line = output.split('\n').find((l) => l.startsWith(tag));
  expect(line, `missing ${tag} line`).toBeDefined();
  return JSON.parse((line as string).slice(tag.length));
}

/** Count the rendered entry lines (`  #<n> [type]`). */
function countEntryLines(output: string): number {
  return output.split('\n').filter((l) => /^ {2}#\d+ \[/.test(l)).length;
}

const fixture: { current: TranscriptFixture | null } = { current: null };

afterEach(() => {
  fixture.current?.cleanup();
  fixture.current = null;
});

describe('getTaskDetailTool — pagination and truncation', () => {
  const entries = makeIncidentTranscript();
  const task = makeTask('t1', { status: 'running', workerSessionId: 'cw-1' });

  it('returns the newest 10 entries by default and marks the truncation explicitly', async () => {
    const tool = getTaskDetailTool({ getTask: () => task, getWorkerConversation: () => entries });
    const out = await exec(tool, { taskId: 't1' });

    expect(out).toContain('Conversation (21 entries total, showing 12-21 by offset=0 limit=10)');
    expect(out).toContain('[truncated: showing 10 of 21 entries (12-21), per-entry limit 200 chars');
    expect(out).toContain('pass offset/limit or full=true');

    const meta = readMeta(out);
    expect(meta.totalEntries).toBe(21);
    expect(meta.returnedEntries).toBe(10);
    expect(meta.offset).toBe(0);
    expect(meta.truncated).toBe(true);
    expect(countEntryLines(out)).toBe(meta.returnedEntries);
  });

  it('pages backwards from the newest with offset', async () => {
    const tool = getTaskDetailTool({ getTask: () => task, getWorkerConversation: () => entries });
    const out = await exec(tool, { taskId: 't1', offset: 10, limit: 10 });

    const meta = readMeta(out);
    expect(meta.offset).toBe(10);
    expect(meta.returnedEntries).toBe(10);
    expect(meta.totalEntries).toBe(21);
    expect(meta.startIndex).toBe(2);
    expect(meta.endIndex).toBe(11);
    expect(out).toContain('showing 2-11');
    // The window excludes the newest entries (12-21): the report step is absent.
    expect(out).not.toContain('REPORT_TAIL_MARKER');
    expect(countEntryLines(out)).toBe(10);
  });

  it('reports totalEntries consistent with the real transcript length on every page', async () => {
    const tool = getTaskDetailTool({ getTask: () => task, getWorkerConversation: () => entries });
    const first = readMeta(await exec(tool, { taskId: 't1', offset: 0, limit: 5 }));
    const second = readMeta(await exec(tool, { taskId: 't1', offset: 5, limit: 5 }));
    expect(first.totalEntries).toBe(21);
    expect(second.totalEntries).toBe(21);
    expect(first.returnedEntries).toBe(5);
    expect(second.returnedEntries).toBe(5);
    expect(second.startIndex).toBe(12);
    expect(second.endIndex).toBe(16);
  });

  it('marks each entry that was cut and never claims a truncated entry is the worker stopping', async () => {
    const tool = getTaskDetailTool({ getTask: () => task, getWorkerConversation: () => entries });
    const out = await exec(tool, { taskId: 't1' });

    // The final report entry is in the default window and is cut at exactly 200 chars.
    expect(out).toContain('(truncated: 200/4642 chars)');
    const meta = readMeta(out);
    expect(meta.shortenedEntries).toBeGreaterThan(0);
    expect(meta.truncated).toBe(true);
  });

  it('keeps the header tautology-free when nothing is cut (backward compatible)', async () => {
    const short = [makeEntry('user', 'hello'), makeEntry('assistant', 'world')];
    const tool = getTaskDetailTool({ getTask: () => task, getWorkerConversation: () => short });
    const out = await exec(tool, { taskId: 't1' });

    expect(out).toContain('Conversation (2 entries):');
    expect(out).not.toContain('[truncated:');
    const meta = readMeta(out);
    expect(meta.totalEntries).toBe(2);
    expect(meta.returnedEntries).toBe(2);
    expect(meta.truncated).toBe(false);
  });

  it('full=true returns every entry and the complete report text', async () => {
    const tool = getTaskDetailTool({ getTask: () => task, getWorkerConversation: () => entries });
    const out = await exec(tool, { taskId: 't1', full: true });

    expect(out).toContain('Conversation (21 entries):');
    expect(out).not.toContain('[truncated:');
    expect(out).toContain('REPORT_TAIL_MARKER');
    expect(countEntryLines(out)).toBe(21);

    const meta = readMeta(out);
    expect(meta.full).toBe(true);
    expect(meta.maxChars).toBeNull();
    expect(meta.returnedEntries).toBe(21);
    expect(meta.truncated).toBe(false);
  });

  it('honours maxChars over the entry text', async () => {
    const tool = getTaskDetailTool({ getTask: () => task, getWorkerConversation: () => entries });
    const out = await exec(tool, { taskId: 't1', maxChars: 50, full: true, limit: undefined });
    // full overrides maxChars, so nothing is cut
    expect(readMeta(out).maxChars).toBeNull();

    const narrow = await exec(tool, { taskId: 't1', maxChars: 50 });
    expect(narrow).toContain('per-entry limit 50 chars');
    expect(readMeta(narrow).maxChars).toBe(50);
    expect(narrow).toContain('(truncated: 50/4642 chars)');
  });

  it('falls back to the on-disk transcript once the in-memory conversation is gone', async () => {
    const fx = createTranscriptFixture();
    fixture.current = fx;
    fx.writeTranscript('cw-1', entries);

    const tool = getTaskDetailTool({
      getTask: () => makeTask('t1', { status: 'completed', workerSessionId: 'cw-1' }),
      getWorkerConversation: () => [], // worker already removed from the engine map
      readTranscriptWindow: (workerId, opts) => readWorkerTranscriptWindow(fx.sessionDir, workerId, opts),
    });
    const out = await exec(tool, { taskId: 't1', full: true });

    expect(out).toContain('[from transcript]');
    expect(out).toContain('REPORT_TAIL_MARKER');
    expect(readMeta(out).totalEntries).toBe(21);
    expect(readMeta(out).source).toBe('transcript');
  });

  it('resolves the disk transcript through workerTranscriptId (the engine id never names the dir)', async () => {
    const fx = createTranscriptFixture();
    fixture.current = fx;
    // The file lives under the worker instance's own id only.
    fx.writeTranscript('cw-9', entries);

    const tool = getTaskDetailTool({
      getTask: () => makeTask('t1', {
        status: 'failed',
        workerSessionId: 'w-1',
        workerTranscriptId: 'cw-9',
      }),
      getWorkerConversation: () => [],
      readTranscriptWindow: (workerId, opts) => readWorkerTranscriptWindow(fx.sessionDir, workerId, opts),
    });
    const out = await exec(tool, { taskId: 't1' });

    expect(out).toContain('[from transcript]');
    expect(readMeta(out).source).toBe('transcript');
    expect(readMeta(out).totalEntries).toBe(21);
    expect(readMeta(out).returnedEntries).toBe(10); // default limit
  });

  it('flags a torn last line on the disk fallback', async () => {
    const fx = createTranscriptFixture();
    fixture.current = fx;
    fx.writeTranscript('cw-1', [makeEntry('user', 'hello'), makeEntry('assistant', 'world')]);
    const fs = await import('node:fs');
    fs.appendFileSync(fx.transcriptPath('cw-1'), '{"type":"assistant","mess');

    const tool = getTaskDetailTool({
      getTask: () => makeTask('t1', { status: 'completed', workerSessionId: 'cw-1' }),
      getWorkerConversation: () => [],
      readTranscriptWindow: (workerId, opts) => readWorkerTranscriptWindow(fx.sessionDir, workerId, opts),
    });
    const out = await exec(tool, { taskId: 't1' });

    expect(out).toContain('[note: last entry is incomplete — the transcript is still being written]');
    expect(readMeta(out).incompleteTail).toBe(true);
    expect(readMeta(out).totalEntries).toBe(2);
  });

  it('does not invent a conversation when nothing is available', async () => {
    const tool = getTaskDetailTool({
      getTask: () => task,
      getWorkerConversation: () => [],
      readTranscriptWindow: vi.fn(() => null),
    });
    const out = await exec(tool, { taskId: 't1' });
    expect(out).not.toContain('Conversation');
    expect(out).not.toContain('[truncated:');
  });

  it('documents the pagination semantics it actually implements', () => {
    const tool = getTaskDetailTool({ getTask: () => task });
    for (const sentence of [
      'offset skips N entries counted back from the newest',
      'output is ordered oldest→newest',
      'type filtering is applied BEFORE pagination',
    ]) {
      expect(tool.description).toContain(sentence);
    }
  });
});
