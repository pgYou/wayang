/**
 * event-mapper unit tests (frozen §3 mapping table + accumulator semantics).
 *
 * Scenarios:
 * - tool_call accumulation: empty-rawInput first event → streaming update →
 *   same-id full resend with the kind corrected (measured codebuddy shape);
 *   the FIRST snapshot produces no record, the merged snapshot does;
 * - action mapping: text chunk / thought chunk / tool call / plan / usage /
 *   user_message_chunk echo / known no-render variants / unknown variants;
 * - flushUnsettled marks unsettled calls 'cancelled';
 * - snapshot → ToolCallRecord / ToolResultRecord shapes (transcript
 *   isomorphism: arguments = rawInput JSON, output = content text else
 *   rawOutput.text — measured as a single object, not a block array).
 */

import { describe, it, expect } from 'vitest';
import {
  createAcpToolAccumulator,
  mapSessionUpdate,
  snapshotToToolCallRecord,
  snapshotToToolResultRecord,
  type AcpMappedEvent,
} from '@/services/agents/acp/event-mapper';
import type { AcpSessionUpdate, AcpToolCall, AcpToolCallUpdate } from '@/services/acp/types';

/** The measured codebuddy three-part tool stream for one call (03 §2.1). */
function measuredToolCallStream(toolCallId = 'tc-1'): AcpSessionUpdate[] {
  return [
    { sessionUpdate: 'tool_call', toolCallId, title: 'Bash', kind: 'other', status: 'in_progress', rawInput: {} },
    { sessionUpdate: 'tool_call_update', toolCallId, rawInput: { command: 'echo probe-ok' } },
    {
      sessionUpdate: 'tool_call',
      toolCallId,
      title: '`echo probe-ok`',
      kind: 'execute',
      status: 'pending',
      rawInput: { command: 'echo probe-ok', description: 'run echo' },
      content: [{ type: 'content', content: { type: 'text', text: 'planned' } }],
    },
  ];
}

function kindsOf(events: AcpMappedEvent[]): string[] {
  return events.map((event) => event.kind);
}

describe('AcpToolAccumulator: measured merge sequence', () => {
  it('first snapshot (empty rawInput, kind other) produces NO record', () => {
    const acc = createAcpToolAccumulator();
    const [first] = measuredToolCallStream();
    const events = mapSessionUpdate(first, acc);
    expect(events).toEqual([{ kind: 'ignored', variant: 'tool_call', reason: 'first-snapshot' }]);
    // The snapshot exists (the permission bridge may already judge it).
    expect(acc.peek('tc-1')?.kind).toBe('other');
    expect(acc.peek('tc-1')?.rawInput).toEqual({});
  });

  it('a streaming update merges incrementally (rawInput filled, kind still other)', () => {
    const acc = createAcpToolAccumulator();
    const [first, second] = measuredToolCallStream();
    mapSessionUpdate(first, acc);
    const events = mapSessionUpdate(second, acc);
    // Non-terminal update: no records yet, but the snapshot has the command.
    expect(kindsOf(events)).toEqual(['ignored']);
    const snapshot = acc.peek('tc-1');
    expect(snapshot?.rawInput).toEqual({ command: 'echo probe-ok' });
    expect(snapshot?.kind).toBe('other');
    expect(snapshot?.status).toBe('in_progress');
  });

  it('the same-id full resend corrects the kind and yields a running record', () => {
    const acc = createAcpToolAccumulator();
    let resendEvents: AcpMappedEvent[] = [];
    for (const update of measuredToolCallStream()) {
      resendEvents = mapSessionUpdate(update, acc);
    }
    expect(kindsOf(resendEvents)).toEqual(['tool-call']);
    const record = resendEvents[0];
    if (record.kind !== 'tool-call') throw new Error('unreachable');
    // Judged AND stored from the MERGED snapshot: kind execute, full rawInput.
    expect(record.record.toolName).toBe('execute');
    expect(record.record.arguments).toBe(JSON.stringify({ command: 'echo probe-ok', description: 'run echo' }));
    expect(record.record.status).toBe('running');
    expect(acc.peek('tc-1')?.kind).toBe('execute');
  });

  it('a terminal update yields tool-call + tool-result from the merged snapshot', () => {
    const acc = createAcpToolAccumulator();
    for (const update of measuredToolCallStream()) {
      mapSessionUpdate(update, acc);
    }
    const terminal: AcpSessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      status: 'completed',
      rawOutput: { type: 'text', text: 'Stdout: probe-ok' },
    };
    const events = mapSessionUpdate(terminal, acc);
    expect(kindsOf(events)).toEqual(['tool-call', 'tool-result']);
    const call = events[0];
    const result = events[1];
    if (call.kind !== 'tool-call' || result.kind !== 'tool-result') throw new Error('unreachable');
    expect(call.record.status).toBe('succeeded');
    // Content-block text wins over rawOutput (frozen §3) — the resend carried
    // a content block, so 'planned' is the output of record here.
    expect(result.record.output).toEqual({ type: 'text', value: 'planned' });
    expect(result.record.status).toBe('succeeded');
  });

  it('update fields left null/undefined keep the previous value (frozen §2.3)', () => {
    const acc = createAcpToolAccumulator();
    const initial: AcpToolCall = {
      toolCallId: 'tc-2',
      title: 'Read',
      kind: 'read',
      status: 'in_progress',
      locations: [{ path: '/tmp/a.txt' }],
      rawInput: { file_path: '/tmp/a.txt' },
    };
    acc.upsert(initial);
    const update: AcpToolCallUpdate = { toolCallId: 'tc-2', status: 'completed' };
    const snapshot = acc.upsert(update);
    expect(snapshot.kind).toBe('read'); // kept
    expect(snapshot.rawInput).toEqual({ file_path: '/tmp/a.txt' }); // kept
    expect(snapshot.status).toBe('completed'); // replaced
  });

  it('flushUnsettled marks unsettled calls cancelled and clears the map', () => {
    const acc = createAcpToolAccumulator();
    acc.upsert({ toolCallId: 'tc-a', title: 'A', kind: 'execute', status: 'in_progress' });
    acc.upsert({ toolCallId: 'tc-b', title: 'B', kind: 'read', status: 'completed' });
    const unsettled = acc.flushUnsettled();
    expect(unsettled).toHaveLength(1);
    expect(unsettled[0].toolCallId).toBe('tc-a');
    expect(unsettled[0].status).toBe('cancelled');
    expect(acc.peek('tc-a')).toBeUndefined();
    expect(acc.peek('tc-b')).toBeUndefined();
  });
});

describe('mapSessionUpdate: variant table (frozen §3)', () => {
  it('agent_message_chunk → agent-text (messageId carried)', () => {
    const acc = createAcpToolAccumulator();
    const events = mapSessionUpdate(
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' }, messageId: 'm-1' },
      acc,
    );
    expect(events).toEqual([{ kind: 'agent-text', text: 'OK', messageId: 'm-1' }]);
  });

  it('agent_thought_chunk → ignored (never enters the transcript)', () => {
    const events = mapSessionUpdate(
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking…' } },
      createAcpToolAccumulator(),
    );
    expect(events).toEqual([{ kind: 'ignored', variant: 'agent_thought_chunk', reason: 'thought' }]);
  });

  it('user_message_chunk → ignored (echo — wayang writes its own UserEntry)', () => {
    const events = mapSessionUpdate(
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'prompt echo' } },
      createAcpToolAccumulator(),
    );
    expect(events).toEqual([{ kind: 'ignored', variant: 'user_message_chunk', reason: 'echo' }]);
  });

  it('plan → runtime-state(plan)', () => {
    const entries = [{ content: 'step 1', priority: 'high', status: 'completed' }];
    const events = mapSessionUpdate({ sessionUpdate: 'plan', entries }, createAcpToolAccumulator());
    expect(events).toEqual([{ kind: 'runtime-state', key: 'plan', value: entries }]);
  });

  it('usage_update → runtime-state(usage, {used,size})', () => {
    const events = mapSessionUpdate(
      { sessionUpdate: 'usage_update', used: 100, size: 8192, cost: { amount: 0.01, currency: 'USD' } },
      createAcpToolAccumulator(),
    );
    expect(events).toEqual([
      { kind: 'runtime-state', key: 'usage', value: { used: 100, size: 8192, cost: { amount: 0.01, currency: 'USD' } } },
    ]);
  });

  it('known no-render variants are ignored with their reason', () => {
    for (const variant of ['session_info_update', 'available_commands_update', 'notice', 'compaction_update']) {
      const events = mapSessionUpdate(
        { sessionUpdate: variant, whatever: { deep: true } },
        createAcpToolAccumulator(),
      );
      expect(events).toEqual([{ kind: 'ignored', variant, reason: 'no-render' }]);
    }
  });

  it('unknown/vendor variants are ignored as unknown-variant', () => {
    const events = mapSessionUpdate(
      { sessionUpdate: 'vendor_magic_update', payload: 1 },
      createAcpToolAccumulator(),
    );
    expect(events).toEqual([{ kind: 'ignored', variant: 'vendor_magic_update', reason: 'unknown-variant' }]);
  });
});

describe('snapshot records: transcript isomorphism (frozen §7)', () => {
  it('tool-call record: arguments = rawInput JSON, truncated by the shared cap', () => {
    const record = snapshotToToolCallRecord({
      toolCallId: 'tc-x',
      title: 'Write',
      name: 'write_file',
      kind: 'edit',
      status: 'completed',
      rawInput: { path: '/tmp/x', content: 'hello' },
    });
    expect(record.toolCallId).toBe('tc-x');
    expect(record.toolName).toBe('write_file');
    expect(record.arguments).toBe(JSON.stringify({ path: '/tmp/x', content: 'hello' }));
    expect(record.status).toBe('succeeded');
    expect(record.endedAt).toBeDefined();
  });

  it('toolName falls back kind → unknown when the agent sent no name', () => {
    expect(snapshotToToolCallRecord({ toolCallId: 'a', title: 'Bash', kind: 'execute' }).toolName).toBe('execute');
    expect(snapshotToToolCallRecord({ toolCallId: 'a', title: 'Mystery' }).toolName).toBe('unknown');
  });

  it('tool-result output prefers content-block text, falls back to rawOutput.text (single object)', () => {
    const fromContent = snapshotToToolResultRecord({
      toolCallId: 'a',
      title: 'T',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'from content' } }],
      rawOutput: { type: 'text', text: 'from rawOutput' },
    });
    expect(fromContent.output.value).toBe('from content');

    const fromRawOutput = snapshotToToolResultRecord({
      toolCallId: 'a',
      title: 'T',
      status: 'completed',
      rawOutput: { type: 'text', text: 'from rawOutput' },
    });
    expect(fromRawOutput.output.value).toBe('from rawOutput');
  });

  it('a failed call keeps isError + errorType on the result record', () => {
    const record = snapshotToToolResultRecord({
      toolCallId: 'a',
      title: 'T',
      status: 'failed',
      rawOutput: { type: 'text', text: 'boom' },
    });
    expect(record.isError).toBe(true);
    expect(record.errorType).toBe('ToolError');
    expect(record.status).toBe('failed');
  });

  it('diff and terminal content blocks are flattened with markers', () => {
    const record = snapshotToToolResultRecord({
      toolCallId: 'a',
      title: 'T',
      status: 'completed',
      content: [
        { type: 'content', content: { type: 'text', text: 'text part' } },
        { type: 'diff', path: '/tmp/f.txt', newText: 'x' },
        { type: 'terminal', terminalId: 'term-1' },
      ],
    });
    expect(record.output.value).toBe('text part\n[diff: /tmp/f.txt]\n[terminal: term-1]');
  });
});
