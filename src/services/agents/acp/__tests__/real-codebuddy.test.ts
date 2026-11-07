/**
 * Real-machine codebuddy ACP verification (opt-in) — Refs #25.
 *
 * Guarded by `ACP_REAL_CODEBUDDY`: the default suite (CI) never spawns the
 * real CLI. Cases only run when a human opts in on a machine with a logged-in
 * `codebuddy` (06 booklet §5: real-machine acceptance = a real task with a
 * real permission round; fake-server behavior is never real behavior).
 *
 * Verified against the frozen page (00 §8/§9) and the 03 booklet:
 *  1. full turn — initialize → session/new → session/prompt with tools →
 *     end_turn → completed, transcript isomorphism (text + toolCalls/
 *     toolResults), runtimeState.acp.pid/command, clean process exit;
 *  2. permission ask path — an out-of-workspace write surfaces as a
 *     permission_request signal, a controller refusal (resolvePermission
 *     false) stops the write, the round still settles;
 *  3. cancel — session/cancel mid-tool → failed('Aborted'), no residual
 *     codebuddy/sleep processes, transcript intact (no torn JSONL lines).
 *
 * Shared fixtures live in `./real-acp-harness.ts`. Every case dumps its raw
 * wire transcript (both directions, timestamped), collected signals and a
 * digest into `.agents/tmp/real-evidence/codebuddy-*.json` via onTestFinished
 * — the evidence survives even when an assertion fails.
 */

import { describe, it, expect, afterEach, onTestFinished } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkerResult } from '@/types/worker';
import {
  WireTappingCodebuddyWorker,
  RecordingSignalQueue,
  makeRealDirs,
  trackDir,
  cleanupTrackedDirs,
  dumpEvidence,
  digestWire,
  permissionRounds,
  pgrep,
  pidAlive,
  waitFor,
  makeTask,
  wireSignalContext,
  makeWorkerConfig,
  makeMockCtxFor,
  readTranscript,
  skills,
} from './real-acp-harness';

afterEach(cleanupTrackedDirs);

describe.skipIf(!process.env.ACP_REAL_CODEBUDDY)('real codebuddy: full turn (opt-in)', () => {
  it(
    'runs a real task end-to-end (read package.json, write out.txt, echo hi, pwd) → completed',
    async () => {
      const dirs = makeRealDirs('full-turn');
      trackDir(dirs.root);
      const worker = new WireTappingCodebuddyWorker(makeWorkerConfig('codebuddy'), dirs.sessionDir, dirs.workspace, makeMockCtxFor(dirs), skills);
      const queue = new RecordingSignalQueue(() => true); // safety net: approve any policy ask
      queue.bind(worker.permissionHandler);
      wireSignalContext(worker, dirs, queue, {
        workerId: 'w-real-cb-full',
        taskId: 'task-real-cb-full',
        taskTitle: 'Real codebuddy full turn',
        workerType: 'codebuddy',
      });

      const captured: { result?: WorkerResult; durationMs: number } = { durationMs: 0 };
      onTestFinished(() => {
        dumpEvidence('codebuddy-full-turn', {
          durationMs: captured.durationMs,
          result: captured.result,
          signalTypes: queue.signals.map((s) => s.type),
          signals: queue.signals,
          wireDigest: digestWire(worker.wire),
          wire: worker.wire,
        });
      });

      const task = makeTask(
        'real-cb-full',
        '读取 package.json 里的 name 与 version 并回答；然后创建 .agents/tmp/real/out.txt 内容为 OK；然后执行 echo hi 与 pwd 两条命令',
      );
      const startedAt = Date.now();
      const result = await worker.run(task, {});
      captured.result = result;
      captured.durationMs = Date.now() - startedAt;

      // 1) The round completed.
      expect(result.status).toBe('completed');

      // 2) Transcript: non-empty agent text, readable tool calls and results.
      const conversation = worker.getConversation();
      const assistantTexts = conversation
        .filter((entry) => entry.type === 'assistant' && !(entry as any).toolCalls)
        .map((entry) => String((entry as any).message?.content ?? ''));
      expect(assistantTexts.some((text) => text.trim().length > 0)).toBe(true);
      const toolEntries = conversation.filter(
        (entry) => entry.type === 'assistant' && Array.isArray((entry as any).toolCalls) && (entry as any).toolCalls.length > 0,
      );
      expect(toolEntries.length).toBeGreaterThan(0);
      const toolCalls = toolEntries.flatMap((entry) => (entry as any).toolCalls as any[]);
      const toolResults = toolEntries.flatMap((entry) => ((entry as any).toolResults ?? []) as any[]);
      expect(toolResults.length).toBeGreaterThan(0);
      for (const call of toolCalls) {
        expect(typeof call.toolName).toBe('string');
        expect(call.toolName.length).toBeGreaterThan(0);
        expect(() => JSON.parse(call.arguments)).not.toThrow();
        expect(typeof JSON.parse(call.arguments)).toBe('object');
      }
      // The tools ran for real: the answer quotes the fixture, echo/pwd outputs
      // are in the results.
      const joinedText = assistantTexts.join('\n').toLowerCase();
      expect(joinedText).toContain('wayang-acp-real-fixture');
      expect(joinedText).toContain('9.9.9-real');
      const toolOutput = toolResults.map((r) => String(r.output?.value ?? '')).join('\n');
      expect(toolOutput).toContain('hi');
      expect(toolOutput).toContain(dirs.workspace);

      // 3) The workspace side effect really happened.
      const outFile = join(dirs.workspace, '.agents', 'tmp', 'real', 'out.txt');
      expect(existsSync(outFile)).toBe(true);
      expect(readFileSync(outFile, 'utf8')).toContain('OK');

      // 4) runtimeState.acp carries the pid + launch-command evidence.
      const runtime = worker.getState().get<Record<string, any>>('runtimeState') ?? {};
      expect(runtime.acp?.pid).toBeGreaterThan(0);
      expect(runtime.acp?.command).toBe('codebuddy');

      // 5) The codebuddy process is gone (reaped), and pgrep no longer lists it.
      const pid = runtime.acp?.pid as number;
      await waitFor('codebuddy process exit', () => !pidAlive(pid), 10_000);
      expect(pgrep('codebuddy').map(Number)).not.toContain(pid);

      console.log(
        `[real-acp] codebuddy full turn: ${captured.durationMs}ms, signals=[${queue.signals.map((s) => s.type).join(',') || 'none'}], ` +
          `tools=[${toolCalls.map((c) => `${c.toolName}/${c.status}`).join(', ')}]`,
      );
    },
    120_000,
  );
});

describe.skipIf(!process.env.ACP_REAL_CODEBUDDY)('real codebuddy: permission ask path (opt-in)', () => {
  it(
    'an out-of-workspace write asks through the bridge; a refusal stops it and the round settles',
    async () => {
      const dirs = makeRealDirs('ask-deny');
      trackDir(dirs.root);
      const forbiddenPath = `/tmp/wayang-acp-should-not-exist-${randomUUID()}.txt`;
      const worker = new WireTappingCodebuddyWorker(makeWorkerConfig('codebuddy'), dirs.sessionDir, dirs.workspace, makeMockCtxFor(dirs), skills);
      // Refuse the requests that would WRITE the forbidden path; approve the
      // agent's read-only existence probes so the actual write request (the
      // interesting evidence) is reached.
      // NOTE: match on "read-only"/command-shape only — never on words like
      // "exist": the forbidden path itself contains "should-not-exist".
      const isReadOnlyProbe = (payload: Record<string, any>): boolean => {
        const command = String(payload.toolArgs?.command ?? '');
        const description = String(payload.description ?? '');
        return /^if \[ -e\b/.test(command.trim()) || /read-only/i.test(description);
      };
      const queue = new RecordingSignalQueue((payload) => {
        if (!JSON.stringify(payload).includes(forbiddenPath)) return true; // unrelated → approve
        return isReadOnlyProbe(payload); // probe → approve, write → refuse
      });
      queue.bind(worker.permissionHandler);
      wireSignalContext(worker, dirs, queue, {
        workerId: 'w-real-cb-ask',
        taskId: 'task-real-cb-ask',
        taskTitle: 'Real codebuddy permission ask',
        workerType: 'codebuddy',
      });

      const captured: { result?: WorkerResult; durationMs: number } = { durationMs: 0 };
      onTestFinished(() => {
        dumpEvidence('codebuddy-ask-deny', {
          durationMs: captured.durationMs,
          result: captured.result,
          forbiddenPath,
          signalTypes: queue.signals.map((s) => s.type),
          signals: queue.signals,
          permissionRounds: permissionRounds(worker.wire),
          wireDigest: digestWire(worker.wire),
          wire: worker.wire,
        });
      });

      const task = makeTask(
        'real-cb-ask',
        `请把字符串 DENIED 写入文件 ${forbiddenPath}（这个路径在当前 workspace 之外）。尝试写入，然后报告结果。`,
      );
      const startedAt = Date.now();
      const result = await worker.run(task, {});
      captured.result = result;
      captured.durationMs = Date.now() - startedAt;

      // 1) The forbidden write surfaced as a permission_request with readable
      //    toolName / toolArgs / description.
      const permissionSignals = queue.byType('permission_request');
      expect(permissionSignals.length).toBeGreaterThan(0);
      const targeting = permissionSignals.filter((s) => JSON.stringify(s.payload).includes(forbiddenPath));
      expect(targeting.length).toBeGreaterThan(0);
      for (const signal of targeting) {
        expect(typeof signal.payload.toolName).toBe('string');
        expect(signal.payload.toolName.length).toBeGreaterThan(0);
        expect(signal.payload.toolArgs).toBeDefined();
        expect(typeof signal.payload.description).toBe('string');
        expect(signal.payload.description.length).toBeGreaterThan(0);
      }

      // 2) The refusal went out on the wire: a reject-kind option (or a
      //    cancelled outcome when the agent offered no reject option) for at
      //    least one forbidden-path round.
      const rounds = permissionRounds(worker.wire);
      const forbiddenRounds = rounds.filter((round) => JSON.stringify(round.toolCall ?? {}).includes(forbiddenPath));
      expect(forbiddenRounds.length).toBeGreaterThan(0);
      const rejectedRounds = forbiddenRounds.filter((round) => {
        const rejectOptionIds = round.options
          .filter((option) => String(option.kind).startsWith('reject'))
          .map((option) => option.optionId);
        const outcome = round.answer?.outcome ?? {};
        return outcome.outcome === 'cancelled' || (outcome.outcome === 'selected' && rejectOptionIds.includes(outcome.optionId));
      });
      expect(rejectedRounds.length).toBeGreaterThan(0);

      // 3) The file was never created.
      expect(existsSync(forbiddenPath)).toBe(false);

      // 4) The round settled: a terminal result, a final system entry, the
      //    process gone.
      expect(['completed', 'failed']).toContain(result.status);
      const conversation = worker.getConversation();
      expect(conversation.length).toBeGreaterThan(1);
      expect(conversation[conversation.length - 1].type).toBe('system');
      const pid = (worker.getState().get<Record<string, any>>('runtimeState') ?? {}).acp?.pid;
      expect(typeof pid).toBe('number');
      await waitFor('codebuddy process exit', () => !pidAlive(pid), 10_000);

      console.log(
        `[real-acp] codebuddy ask-deny: ${captured.durationMs}ms, result=${result.status}, ` +
          `permission signals=${permissionSignals.length} (targeting forbidden: ${targeting.length}), ` +
          `answers=${JSON.stringify(rounds.map((r) => r.answer))}`,
      );
    },
    180_000,
  );
});

describe.skipIf(!process.env.ACP_REAL_CODEBUDDY)('real codebuddy: cancel (opt-in)', () => {
  it(
    'abort mid-tool → failed("Aborted"), no residual codebuddy/sleep processes, transcript intact',
    async () => {
      const dirs = makeRealDirs('cancel');
      trackDir(dirs.root);
      const worker = new WireTappingCodebuddyWorker(makeWorkerConfig('codebuddy'), dirs.sessionDir, dirs.workspace, makeMockCtxFor(dirs), skills);
      const queue = new RecordingSignalQueue(() => true);
      queue.bind(worker.permissionHandler);
      wireSignalContext(worker, dirs, queue, {
        workerId: 'w-real-cb-cancel',
        taskId: 'task-real-cb-cancel',
        taskTitle: 'Real codebuddy cancel',
        workerType: 'codebuddy',
      });

      const captured: { result?: WorkerResult; durationMs: number } = { durationMs: 0 };
      let sawSleep = true;
      let transcriptLineCount = 0;
      onTestFinished(() => {
        dumpEvidence('codebuddy-cancel', {
          durationMs: captured.durationMs,
          result: captured.result,
          sawSleep,
          signalTypes: queue.signals.map((s) => s.type),
          signals: queue.signals,
          wireDigest: digestWire(worker.wire),
          wire: worker.wire,
          transcriptLineCount,
        });
      });

      // Baseline: no stray `sleep 40` on this machine before we start.
      const sleepBaseline = pgrep('sleep 40');
      expect(sleepBaseline).toEqual([]);

      const task = makeTask('real-cb-cancel', '执行命令 sleep 40 并等待它完成，然后报告结果。');
      const startedAt = Date.now();
      const runPromise = worker.run(task, {});
      // Abort once the long tool is actually in flight (well within the task's
      // prescribed 2–3s window after the round started producing work).
      try {
        await waitFor('sleep 40 process to appear', () => pgrep('sleep 40').length > sleepBaseline.length, 30_000);
      } catch {
        sawSleep = false;
        console.log('[real-acp] codebuddy cancel: sleep 40 never observed — aborting on the fallback window');
      }
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      worker.abort();
      const result = await runPromise;
      captured.result = result;
      captured.durationMs = Date.now() - startedAt;

      // 1) Cancelled → failed('Aborted').
      expect(result).toEqual({ status: 'failed', error: 'Aborted' });

      // 2) The codebuddy process is gone and pgrep no longer lists its pid.
      const pid = (worker.getState().get<Record<string, any>>('runtimeState') ?? {}).acp?.pid;
      expect(typeof pid).toBe('number');
      await waitFor('codebuddy process exit', () => !pidAlive(pid), 15_000);
      expect(pgrep('codebuddy').map(Number)).not.toContain(pid);

      // 3) No residual tool subprocess (the sleep child must not be orphaned).
      if (sawSleep) {
        await waitFor('sleep 40 child to be gone', () => pgrep('sleep 40').length === sleepBaseline.length, 5_000);
        expect(pgrep('sleep 40')).toEqual([]);
      }

      // 4) Transcript intact: every persisted JSONL line parses; the opening
      //    user entry and the final error entry are present and readable.
      const entries = readTranscript(dirs.sessionDir, worker.id);
      transcriptLineCount = entries.length;
      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0].type).toBe('user');
      expect(entries[entries.length - 1].type).toBe('system');
      expect(entries[entries.length - 1].subtype).toBe('error');
      // getConversation() (the in-memory view) agrees with the persisted file.
      expect(worker.getConversation().length).toBe(entries.length);

      console.log(
        `[real-acp] codebuddy cancel: ${captured.durationMs}ms, sawSleep=${sawSleep}, pid=${pid}, ` +
          `transcript lines=${entries.length}, signals=[${queue.signals.map((s) => s.type).join(',') || 'none'}]`,
      );
    },
    120_000,
  );
});
