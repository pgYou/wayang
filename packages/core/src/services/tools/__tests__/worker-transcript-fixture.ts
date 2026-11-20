/**
 * Temp-directory fixtures for the worker transcript tools (issue #16).
 *
 * Builds a throwaway session dir shaped like the real one:
 *   <sessionDir>/workers/<workerId>/conversation.jsonl
 * and removes it on cleanup().
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workerTranscriptPath } from '@/services/worker-transcript';

/** Fixed base timestamp so entry ordering is deterministic. */
const BASE_MS = Date.parse('2026-11-02T10:00:00.000+08:00');

export interface TranscriptFixture {
  sessionDir: string;
  transcriptPath: (workerId: string) => string;
  /** Write one jsonl line per entry (overwrites prior content). */
  writeTranscript: (workerId: string, entries: unknown[]) => void;
  cleanup: () => void;
}

export function createTranscriptFixture(): TranscriptFixture {
  const sessionDir = mkdtempSync(join(tmpdir(), 'wayang-transcript-'));
  return {
    sessionDir,
    transcriptPath: (workerId: string) => workerTranscriptPath(sessionDir, workerId),
    writeTranscript: (workerId: string, entries: unknown[]) => {
      const file = workerTranscriptPath(sessionDir, workerId);
      mkdirSync(join(sessionDir, 'workers', workerId), { recursive: true });
      writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    },
    cleanup: () => rmSync(sessionDir, { recursive: true, force: true }),
  };
}

let seq = 0;

export interface EntryOptions {
  timestampOffsetMs?: number;
  toolCalls?: Array<{ toolCallId?: string; toolName: string; arguments?: string }>;
  /** Tool results recorded on the entry (schema shape: output {type,value}). */
  toolResults?: Array<{
    toolCallId?: string;
    toolName?: string;
    output?: { type: 'text'; value: string };
    isError?: boolean;
  }>;
  subtype?: string;
}

/** Build a conversation entry (user / assistant / system / signal). */
export function makeEntry(type: string, content: string, opts: EntryOptions = {}): Record<string, unknown> {
  seq += 1;
  const timestamp = new Date(BASE_MS + (opts.timestampOffsetMs ?? seq * 1000)).toISOString();
  const base: Record<string, unknown> = {
    type,
    uuid: `e-${seq}`,
    parentUuid: null,
    sessionId: 'test-session',
    timestamp,
  };
  if (type === 'user' || type === 'assistant') {
    base.message = { role: type, content };
  } else {
    base.content = content;
  }
  if (opts.subtype) base.subtype = opts.subtype;
  if (opts.toolCalls) base.toolCalls = opts.toolCalls;
  if (opts.toolResults) base.toolResults = opts.toolResults;
  return base;
}

/**
 * Reproduce the incident transcript: one user entry, 18 assistant steps,
 * a long final report (default 4642 chars) and the terminal task_result marker
 * — 21 entries in total, exactly like session 20261102-103214-kf4j.
 */
export function makeIncidentTranscript(reportChars = 4642): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  entries.push(makeEntry('user', 'Review the branch and write a report.'));
  for (let i = 1; i <= 18; i++) {
    entries.push(makeEntry('assistant', `step ${i}: checking things`, {
      toolCalls: i % 5 === 0
        ? [{ toolCallId: `call-${i}`, toolName: 'bash', arguments: '{"command":"git status"}' }]
        : undefined,
    }));
  }
  // The long final report — the one the controller only ever saw 200 chars of.
  // Built to exactly `reportChars` characters so truncation markers are assertable.
  const head = 'A. 分支与 HEAD 概况\n';
  const tail = '\nREPORT_TAIL_MARKER';
  const report = head + 'x'.repeat(Math.max(0, reportChars - head.length - tail.length)) + tail;
  entries.push(makeEntry('assistant', report));
  entries.push(makeEntry('system', report, { subtype: 'task_result' }));
  return entries;
}
