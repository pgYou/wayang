import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  clampToolOutput,
  resolveToolOutputMaxChars,
  TOOL_OUTPUT_MAX_CHARS,
} from '@/services/agents/utils/tool-output-clamp';
import { buildAssistantEntry } from '@/services/agents/utils/build-assistant-entry';
import {
  truncateForStorage,
  toolResultBlockToRecord,
  CLAUDE_TOOL_RESULT_STORE_CHARS,
} from '@/services/agents/utils/claude-tool-records';

beforeEach(() => {
  delete process.env.WAYANG_TOOL_OUTPUT_MAX_CHARS;
});

afterEach(() => {
  delete process.env.WAYANG_TOOL_OUTPUT_MAX_CHARS;
  vi.unstubAllEnvs();
});

describe('clampToolOutput boundary behavior', () => {
  it('passes text exactly at the threshold through unchanged', () => {
    const exact = 'a'.repeat(100);
    expect(clampToolOutput(exact, 100)).toBe(exact);
  });

  it('clamps one char over the threshold and stays within it', () => {
    const text = 'a'.repeat(101);
    const out = clampToolOutput(text, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out).toContain('[omitted');
    expect(out).toMatch(/\[omitted \d+ of 101 chars\]/);
  });

  it('clamps a 1MB payload to the cap, keeping head, tail and the omission marker', () => {
    const text = `${'H'.repeat(1024 * 1024 - 8)}THE-END!`;
    const out = clampToolOutput(text, 20_000);
    expect(out.length).toBeLessThanOrEqual(20_000);
    // Head kept from the very start, tail kept to the very end.
    expect(out.startsWith('HHHH')).toBe(true);
    expect(out.endsWith('THE-END!')).toBe(true);
    // The marker names the omitted amount.
    expect(out).toMatch(/… \[omitted \d+ of 1048576 chars\] …/);
  });

  it('keeps a head-heavy split: head prefix and tail suffix both survive', () => {
    const text = `${'HEAD-'.repeat(4000)}${'TAIL-'.repeat(4000)}`;
    const out = clampToolOutput(text, 1000);
    expect(out.length).toBeLessThanOrEqual(1000);
    expect(out.startsWith('HEAD-HEAD')).toBe(true);
    expect(out.endsWith('TAIL-')).toBe(true);
  });

  it('never crashes or overflows on degenerate caps', () => {
    expect(clampToolOutput('abcdefghij', 1)).toBe('…');
    expect(clampToolOutput('abcdefghij', 5).length).toBeLessThanOrEqual(5);
    expect(clampToolOutput('abcdefghij', 10)).toBe('abcdefghij');
    expect(clampToolOutput('abcdefghij', 0)).toBe('');
    expect(clampToolOutput('abcdefghij', -3)).toBe('');
  });

  it('reports the exact omitted count in the marker', () => {
    const text = 'x'.repeat(300);
    const out = clampToolOutput(text, 100);
    // kept = head + tail; omitted = 300 - kept; marker states both numbers.
    const match = out.match(/\[omitted (\d+) of (\d+) chars\]/);
    expect(match).not.toBeNull();
    const omitted = Number(match![1]);
    const total = Number(match![2]);
    expect(total).toBe(300);
    // kept head + tail + marker + omitted == original length accounting.
    expect(omitted).toBeGreaterThan(0);
    expect(300 - omitted).toBeLessThanOrEqual(100);
  });
});

describe('resolveToolOutputMaxChars (configurability)', () => {
  it('defaults to the constant without the env var', () => {
    expect(resolveToolOutputMaxChars()).toBe(TOOL_OUTPUT_MAX_CHARS);
  });

  it('honors a positive integer override and rejects garbage', () => {
    process.env.WAYANG_TOOL_OUTPUT_MAX_CHARS = '5000';
    expect(resolveToolOutputMaxChars()).toBe(5000);
    expect(clampToolOutput('x'.repeat(6000)).length).toBeLessThanOrEqual(5000);

    process.env.WAYANG_TOOL_OUTPUT_MAX_CHARS = 'not-a-number';
    expect(resolveToolOutputMaxChars()).toBe(TOOL_OUTPUT_MAX_CHARS);

    process.env.WAYANG_TOOL_OUTPUT_MAX_CHARS = '-10';
    expect(resolveToolOutputMaxChars()).toBe(TOOL_OUTPUT_MAX_CHARS);
  });
});

describe('buildAssistantEntry write-layer clamp (issue #53 acceptance)', () => {
  /** Minimal OnStepFinishEvent fixture carrying tool results. */
  function stepWithToolResult(output: unknown) {
    return {
      text: '',
      toolCalls: [{ toolCallId: 'tc1', toolName: 'bash' }],
      toolResults: [{ toolCallId: 'tc1', toolName: 'bash', output }],
      usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: 'tool-calls',
    } as any;
  }

  it('a 1MB tool output lands in the entry capped and annotated', () => {
    const huge = `${'L'.repeat(1024 * 1024 - 6)}FINAL!`;
    const entry = buildAssistantEntry(stepWithToolResult(huge), 'session-1');

    const value = entry.toolResults![0]!.output.value;
    expect(value.length).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_CHARS);
    expect(value).toContain('[omitted');
    expect(value).toMatch(/of 1048576 chars/);
    expect(value.endsWith('FINAL!')).toBe(true);
  });

  it('a tool result exactly at the cap is stored verbatim', () => {
    const exact = 'y'.repeat(TOOL_OUTPUT_MAX_CHARS);
    const entry = buildAssistantEntry(stepWithToolResult(exact), 'session-1');
    expect(entry.toolResults![0]!.output.value).toBe(exact);
  });

  it('non-string outputs are stringified then clamped', () => {
    const bigObject = { data: 'z'.repeat(30_000) };
    const entry = buildAssistantEntry(stepWithToolResult(bigObject), 'session-1');
    const value = entry.toolResults![0]!.output.value;
    expect(value.length).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_CHARS);
    expect(value).toContain('"data"');
    expect(value).toContain('[omitted');
  });

  it('tool-error part values are clamped too', () => {
    const event = {
      text: '',
      toolCalls: [],
      toolResults: [],
      content: [
        {
          type: 'tool-error',
          toolCallId: 'tc-err',
          toolName: 'write_file',
          error: { message: 'E'.repeat(5000) },
        },
      ],
      finishReason: 'tool-calls',
    } as any;
    process.env.WAYANG_TOOL_OUTPUT_MAX_CHARS = '1000';
    const entry = buildAssistantEntry(event, 'session-1');

    const record = entry.toolResults![0]!;
    expect(record.isError).toBe(true);
    expect(record.output.value.length).toBeLessThanOrEqual(1000);
    expect(record.output.value).toContain('[omitted');
  });
});

describe('claude-code tool records stay under the unified bound', () => {
  it('applies its own cap first, then the unified outer clamp', () => {
    const block = { type: 'tool_result' as const, tool_use_id: 'tu-1', content: 'C'.repeat(5000) };
    const record = toolResultBlockToRecord(block, 'bash', '2026-01-01T00:00:00Z');
    // Own cap: 2000 chars, head-only with its own marker.
    expect(record.output.value.length).toBeLessThanOrEqual(CLAUDE_TOOL_RESULT_STORE_CHARS + 40);
    expect(record.output.value).toContain('truncated');

    // Layering contract: even if the per-worker cap were raised past the
    // unified bound, the composition never exceeds it.
    const raisedFirstLayer = truncateForStorage('C'.repeat(50_000), 50_000);
    expect(raisedFirstLayer.length).toBeGreaterThan(TOOL_OUTPUT_MAX_CHARS);
    expect(clampToolOutput(raisedFirstLayer).length).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_CHARS);
  });
});
