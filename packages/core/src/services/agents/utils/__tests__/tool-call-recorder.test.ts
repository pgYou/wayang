import { describe, it, expect } from 'vitest';
import { ToolCallRecorder, recordToolCalls } from '@/services/agents/utils/tool-call-recorder';

describe('ToolCallRecorder', () => {
  it('records start and finish with status and timing', () => {
    const rec = new ToolCallRecorder();
    rec.start('tc1', 'bash');
    const mid = rec.lookup('tc1')!;
    expect(mid.status).toBe('running');
    expect(mid.startedAt).toBeTruthy();
    expect(mid.endedAt).toBeUndefined();
    rec.finish('tc1', 'succeeded');
    const done = rec.lookup('tc1')!;
    expect(done.status).toBe('succeeded');
    expect(done.endedAt).toBeTruthy();
  });

  it('records failure with an error type', () => {
    const rec = new ToolCallRecorder();
    rec.start('tc1', 'bash');
    rec.finish('tc1', 'failed', 'ToolError');
    expect(rec.lookup('tc1')).toMatchObject({ status: 'failed', errorType: 'ToolError' });
  });

  it('attachTask marks the call as a running async dispatch', () => {
    const rec = new ToolCallRecorder();
    rec.start('tc1', 'add_task');
    rec.finish('tc1', 'succeeded');
    rec.attachTask('tc1', 't-42');
    expect(rec.lookup('tc1')).toMatchObject({ taskId: 't-42', status: 'running' });
  });

  it('beginTurn clears stale records', () => {
    const rec = new ToolCallRecorder();
    rec.start('tc1', 'bash');
    rec.beginTurn();
    expect(rec.lookup('tc1')).toBeUndefined();
  });

  it('finish on an unknown id is a no-op', () => {
    const rec = new ToolCallRecorder();
    expect(() => rec.finish('nope', 'failed')).not.toThrow();
  });
});

describe('recordToolCalls', () => {
  it('wraps execute with timing and success status', async () => {
    const rec = new ToolCallRecorder();
    const tools = recordToolCalls({
      echo: { description: 'd', execute: async () => 'ok' },
    }, rec);
    const result = await tools.echo.execute({ a: 1 }, { toolCallId: 'tc9' });
    expect(result).toBe('ok');
    expect(rec.lookup('tc9')).toMatchObject({ toolCallId: 'tc9', toolName: 'echo', status: 'succeeded' });
  });

  it('marks "[ERROR]" result strings as failed (safeExecute convention)', async () => {
    const rec = new ToolCallRecorder();
    const tools = recordToolCalls({
      bad: { description: 'd', execute: async () => '[ERROR] bad: something broke' },
    }, rec);
    await tools.bad.execute({}, { toolCallId: 'tc1' });
    expect(rec.lookup('tc1')).toMatchObject({ status: 'failed', errorType: 'ToolError' });
  });

  it('records thrown errors as failed and rethrows', async () => {
    const rec = new ToolCallRecorder();
    const tools = recordToolCalls({
      boom: { description: 'd', execute: async () => { throw new Error('kaboom'); } },
    }, rec);
    await expect(tools.boom.execute({}, { toolCallId: 'tc1' })).rejects.toThrow('kaboom');
    expect(rec.lookup('tc1')).toMatchObject({ status: 'failed', errorType: 'Error' });
  });

  it('passes args and options through unchanged and passes tools without execute', async () => {
    const rec = new ToolCallRecorder();
    const seen: any[] = [];
    const tools = recordToolCalls({
      spy: { description: 'd', execute: async (a: any, o: any) => { seen.push([a, o]); return 'done'; } },
      passthrough: { description: 'no execute' },
    }, rec);
    await tools.spy.execute({ x: 1 }, { toolCallId: 'tc1', messages: [] });
    expect(seen).toEqual([[{ x: 1 }, { toolCallId: 'tc1', messages: [] }]]);
    expect(tools.passthrough).toEqual({ description: 'no execute' });
  });
});
