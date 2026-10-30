/**
 * Build the summarizer input from conversation entries.
 *
 * Each entry becomes a compact line (plus one indented line per tool call),
 * keeping what a later turn needs to continue the work: user requests,
 * worker signals, assistant text, and — crucially — which tools were called
 * with which arguments and what they returned. Tool-only assistant steps have
 * empty text, so reading text alone (the previous behavior) hid every command
 * and result from the summarizer.
 *
 * The whole input is fitted to a character budget so the summarizer request
 * itself cannot overflow the model window: caps per field shrink first, and
 * only if that is not enough are the oldest entries dropped (with a note).
 */
import { ESignalSubtype, ESystemSubtype } from '@/types/index';

/** Per-field character caps for one formatting pass. */
export interface SummaryCaps {
  /** User / assistant / signal / system text. */
  text: number;
  /** Tool call arguments (JSON). */
  args: number;
  /** Tool result output. */
  result: number;
}

/** Caps tried in order until the input fits the budget. */
export const SUMMARY_CAP_LEVELS: readonly SummaryCaps[] = [
  { text: 600, args: 300, result: 400 },
  { text: 300, args: 150, result: 200 },
  { text: 150, args: 80, result: 100 },
];

/**
 * Tool calls that carry no information for a summary: skip_reply is the
 * controller choosing not to answer, check_controller_messages just polls.
 */
const NOISE_TOOLS = new Set(['skip_reply', 'check_controller_messages']);

/** Collapse whitespace to single spaces and cut to `max` chars with an ellipsis. */
function clip(value: unknown, max: number): string {
  const text = (typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value))
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

/** "[task title · w:abcd] " context tag for signal lines ('' when unknown). */
function signalTag(entry: any): string {
  const parts: string[] = [];
  if (entry.taskTitle) parts.push(entry.taskTitle);
  if (entry.workerId) parts.push(`w:${String(entry.workerId).slice(-4)}`);
  return parts.length > 0 ? `[${parts.join(' · ')}] ` : '';
}

/**
 * Format one entry. Returns null for entries that carry nothing worth
 * summarizing: heartbeats, compaction markers (the previous summary is passed
 * separately), and empty steps.
 */
export function formatEntryForSummary(entry: any, index: number, caps: SummaryCaps): string | null {
  if (!entry) return null;
  const head = `[${index}]`;

  switch (entry.type) {
    case 'user': {
      const text = clip(entry.message?.content, caps.text);
      return text ? `${head} user: ${text}` : null;
    }

    case 'signal': {
      if (entry.subtype === ESignalSubtype.Heartbeat) return null;
      const text = clip(entry.content, caps.text);
      return `${head} signal(${entry.subtype ?? 'unknown'}) ${signalTag(entry)}${text}`.trimEnd();
    }

    case 'system': {
      if (entry.subtype === ESystemSubtype.Compact) return null;
      const text = clip(entry.content, caps.text);
      return text ? `${head} system(${entry.subtype ?? 'unknown'}): ${text}` : null;
    }

    case 'assistant': {
      const lines: string[] = [];
      const text = clip(entry.message?.content, caps.text);
      if (text) lines.push(`${head} assistant: ${text}`);

      // Pair each call with its result so the summarizer sees call → outcome.
      const results = new Map<string, any>();
      for (const tr of entry.toolResults ?? []) results.set(tr.toolCallId, tr);
      const calls: any[] = (entry.toolCalls ?? []).filter((tc: any) => !NOISE_TOOLS.has(tc.toolName));
      if (calls.length > 0 && lines.length === 0) lines.push(`${head} assistant: (tool calls)`);
      for (const tc of calls) {
        const tr = results.get(tc.toolCallId);
        let line = `  → ${tc.toolName}(${clip(tc.arguments, caps.args)})`;
        if (tr) {
          const output = clip(tr.output?.value ?? tr.output, caps.result);
          line += ` ← ${tr.isError ? 'ERROR: ' : ''}${output}`;
        }
        lines.push(line);
      }
      return lines.length > 0 ? lines.join('\n') : null;
    }

    default: {
      const text = clip(entry.message?.content ?? entry.content, caps.text);
      return text ? `${head} ${entry.type ?? 'entry'}: ${text}` : null;
    }
  }
}

/** Format all entries with one set of caps (empty entries skipped). */
function formatAll(entries: readonly any[], caps: SummaryCaps): string[] {
  const out: string[] = [];
  entries.forEach((entry, i) => {
    const line = formatEntryForSummary(entry, i, caps);
    if (line) out.push(line);
  });
  return out;
}

function totalLength(lines: readonly string[]): number {
  // +1 per line for the joining newline.
  return lines.reduce((n, l) => n + l.length + 1, 0);
}

/**
 * Format entries into summarizer lines that fit within `maxChars`.
 *
 * Tries each cap level in SUMMARY_CAP_LEVELS; if even the smallest caps do
 * not fit, keeps the newest lines that fit and prepends a note saying how many
 * older entries were left out.
 */
export function buildSummaryInput(entries: readonly any[], maxChars: number): string[] {
  let lines: string[] = [];
  for (const caps of SUMMARY_CAP_LEVELS) {
    lines = formatAll(entries, caps);
    if (totalLength(lines) <= maxChars) return lines;
  }

  // Still over budget at the smallest caps — keep the newest lines that fit,
  // reserving room for the omission note so the total stays within budget.
  const noteFor = (n: number) => `[${n} older entries omitted — over the summarizer input budget]`;
  const reserve = noteFor(lines.length).length + 1;
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const size = lines[i]!.length + 1;
    if (used + size > maxChars - reserve) break;
    kept.unshift(lines[i]!);
    used += size;
  }
  const omitted = lines.length - kept.length;
  return omitted > 0 ? [noteFor(omitted), ...kept] : kept;
}
