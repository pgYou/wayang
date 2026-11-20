import { describe, it, expect } from 'vitest';
import {
  buildSummaryInput,
  formatEntryForSummary,
  SUMMARY_CAP_LEVELS,
} from '@/services/agents/utils/summarizer-input';

const CAPS = SUMMARY_CAP_LEVELS[0]!;

// --- self-contained fixtures (fresh objects per call) ---

const user = (content: string) => ({ type: 'user', message: { role: 'user', content } });

function toolStep(args: Record<string, unknown>, output: string, isError = false) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: '' },
    toolCalls: [{ toolCallId: 'c1', toolName: 'bash', arguments: JSON.stringify(args) }],
    toolResults: [{ toolCallId: 'c1', toolName: 'bash', output: { type: 'text', value: output }, isError }],
  };
}

describe('formatEntryForSummary', () => {
  it('shows tool calls with arguments and paired results for tool-only steps', () => {
    const line = formatEntryForSummary(toolStep({ command: 'git status' }, 'clean tree'), 3, CAPS)!;
    expect(line).toContain('[3] assistant: (tool calls)');
    expect(line).toContain('→ bash({"command":"git status"}) ← clean tree');
  });

  it('marks failed tool results', () => {
    const line = formatEntryForSummary(toolStep({ command: 'rm x' }, 'denied', true), 0, CAPS)!;
    expect(line).toContain('← ERROR: denied');
  });

  it('keeps assistant text ahead of its tool calls', () => {
    const entry = { ...toolStep({ command: 'ls' }, 'a b'), message: { role: 'assistant', content: 'Checking files' } };
    const lines = formatEntryForSummary(entry, 1, CAPS)!.split('\n');
    expect(lines[0]).toBe('[1] assistant: Checking files');
    expect(lines[1]).toContain('→ bash');
  });

  it('includes signal context and skips heartbeats and compaction markers', () => {
    const signal = { type: 'signal', subtype: 'worker_completed', taskTitle: 'Build', workerId: 'w-1-abcd', content: 'done' };
    expect(formatEntryForSummary(signal, 2, CAPS)).toBe('[2] signal(worker_completed) [Build · w:abcd] done');
    expect(formatEntryForSummary({ type: 'signal', subtype: 'heartbeat', content: '' }, 0, CAPS)).toBeNull();
    expect(formatEntryForSummary({ type: 'system', subtype: 'compact', content: 'old summary' }, 0, CAPS)).toBeNull();
  });

  it('collapses whitespace and clips long fields', () => {
    const line = formatEntryForSummary(user(`a\n\nb ${'x'.repeat(1000)}`), 0, CAPS)!;
    expect(line.startsWith('[0] user: a b ')).toBe(true);
    expect(line.length).toBeLessThanOrEqual('[0] user: '.length + CAPS.text);
    expect(line.endsWith('…')).toBe(true);
  });

  it('drops noise tool calls (skip_reply) and the step when nothing is left', () => {
    const skip = {
      type: 'assistant',
      message: { role: 'assistant', content: '' },
      toolCalls: [{ toolCallId: 's1', toolName: 'skip_reply', arguments: '{}' }],
      toolResults: [{ toolCallId: 's1', toolName: 'skip_reply', output: { type: 'text', value: '(skipped)' } }],
    };
    expect(formatEntryForSummary(skip, 0, CAPS)).toBeNull();
  });

  it('skips empty steps', () => {
    expect(formatEntryForSummary({ type: 'assistant', message: { role: 'assistant', content: '  ' } }, 0, CAPS)).toBeNull();
  });
});

describe('buildSummaryInput', () => {
  it('keeps full caps when the input fits', () => {
    const lines = buildSummaryInput([user('hello'), toolStep({ command: 'ls' }, 'ok')], 10_000);
    expect(lines[0]).toBe('[0] user: hello');
    expect(lines.join('\n')).toContain('← ok');
  });

  it('shrinks caps before dropping entries', () => {
    const entries = Array.from({ length: 10 }, () => user('y'.repeat(600)));
    // Full caps need ~6k chars; the middle level (300) fits in 3.5k.
    const lines = buildSummaryInput(entries, 3_500);
    expect(lines).toHaveLength(10);
    expect(lines.join('\n').length).toBeLessThanOrEqual(3_500);
  });

  it('drops the oldest entries with a note when even the smallest caps do not fit', () => {
    const entries = Array.from({ length: 50 }, (_, i) => user(`${i} ${'z'.repeat(300)}`));
    const lines = buildSummaryInput(entries, 2_000);
    expect(lines[0]).toMatch(/^\[\d+ older entries omitted/);
    // The newest entry survives.
    expect(lines.at(-1)).toContain('[49] user: 49');
    // The note is included in the budget.
    expect(lines.join('\n').length).toBeLessThanOrEqual(2_000);
  });
});
