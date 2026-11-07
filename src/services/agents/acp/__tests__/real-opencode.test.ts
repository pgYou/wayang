/**
 * Real-machine opencode ACP verification — Refs #25.
 *
 * Two parts:
 *
 * A. `ACP_REAL_OPENCODE`-guarded real rounds (03 booklet §3 — opencode was
 *    UNMEASURED for 0.9.0; these cases turn the "experimental" row into
 *    measured fact on opencode v2.2.5). Same three scenarios as the codebuddy
 *    file: full turn, permission ask→deny, cancel without residual processes.
 *
 *    ⚠ P0 finding baked into the ask-path case (measured on this machine,
 *    2026-11-05): opencode v2.2.5's DEFAULT agent permissions are
 *    [{action:"*",resource:"*",effect:"allow"}, {read *.env → ask}, …] —
 *    every tool (bash AND file writes, inside OR outside the workspace) runs
 *    with ZERO session/request_permission, completely bypassing the wayang
 *    permission bridge (evidence: a /tmp out-of-workspace write and an
 *    out-of-workspace `touch` both executed ungated, files created). The
 *    gate is only restored by configuring the top-level `permissions`
 *    ruleset to ask-all. The ask-path case injects that config through
 *    OPENCODE_CONFIG (subprocess env pointing into the per-test temp dir —
 *    ~/.config/opencode is never touched); the full-turn and cancel cases
 *    deliberately run WITHOUT it to keep measuring the stock default.
 *
 * B. An always-on controlled fail-fast case: the test points its OWN
 *    process PATH at an empty temp dir (saved/restored in finally — no
 *    lasting change anywhere) so the preflight sees a machine without
 *    opencode, regardless of what is installed. Verifies the cli-missing
 *    wording.
 *
 * Notes measured from this machine (2026-11-05): `opencode --help` lists
 * `acp    Start an Agent Client Protocol server`; `opencode acp --help` shows
 * only `--login`; version v2.2.5 (npm global @opencode/cli, Bun standalone
 * binary, a resident `serve --service` background process may be running —
 * pgrep assertions are therefore pid-scoped, never "no opencode anywhere").
 * The launch assertion below pins the exact command/args each run used.
 *
 * Shared fixtures live in `./real-acp-harness.ts`. Evidence lands in
 * `.agents/tmp/real-evidence/opencode-*.json` via onTestFinished — it
 * survives assertion failures.
 */

import { describe, it, expect, afterEach, onTestFinished } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkerResult } from '@/types/worker';
import { OpenCodeAcpWorker } from '@/services/agents/acp/opencode-acp-worker';
import {
  WireTappingOpenCodeWorker,
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

/** Distinct from the codebuddy file's `sleep 40` — the two real test files may
 *  run in parallel workers, and the cancel cases pgrep for their own marker. */
const SLEEP_MARKER = 'sleep 41';

afterEach(cleanupTrackedDirs);

// --- A. Real rounds (opt-in) ----------------------------------------------------

describe.skipIf(!process.env.ACP_REAL_OPENCODE)('real opencode: full turn — DEFAULT permissions (opt-in)', () => {
  it(
    'runs a real task end-to-end (read package.json, write out.txt, echo hi, pwd) → completed',
    async () => {
      const dirs = makeRealDirs('opencode-full-turn');
      trackDir(dirs.root);
      const worker = new WireTappingOpenCodeWorker(makeWorkerConfig('opencode'), dirs.sessionDir, dirs.workspace, makeMockCtxFor(dirs), skills);
      const queue = new RecordingSignalQueue(() => true); // safety net: approve any policy ask
      queue.bind(worker.permissionHandler);
      wireSignalContext(worker, dirs, queue, {
        workerId: 'w-real-oc-full',
        taskId: 'task-real-oc-full',
        taskTitle: 'Real opencode full turn',
        workerType: 'opencode',
      });

      const captured: { result?: WorkerResult; durationMs: number } = { durationMs: 0 };
      onTestFinished(() => {
        dumpEvidence('opencode-full-turn', {
          durationMs: captured.durationMs,
          result: captured.result,
          launch: worker.lastLaunch && { command: worker.lastLaunch.command, args: worker.lastLaunch.args },
          signalTypes: queue.signals.map((s) => s.type),
          signals: queue.signals,
          wireDigest: digestWire(worker.wire),
          wire: worker.wire,
        });
      });

      const task = makeTask(
        'real-oc-full',
        '读取 package.json 里的 name 与 version 并回答；然后创建 .agents/tmp/real/out.txt 内容为 OK；然后执行 echo hi 与 pwd 两条命令',
      );
      const startedAt = Date.now();
      const result = await worker.run(task, {});
      captured.result = result;
      captured.durationMs = Date.now() - startedAt;

      // 0) The launch command actually used (the ACP entry point evidence).
      expect(worker.lastLaunch).not.toBeNull();
      expect(worker.lastLaunch!.command).toBe('opencode');
      expect(worker.lastLaunch!.args).toEqual(['acp']);

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
      expect(runtime.acp?.command).toBe('opencode');

      // 5) The opencode process is gone (reaped); pgrep never asserts "no
      //    opencode anywhere" — a resident `serve --service` may be running —
      //    only that OUR pid is gone.
      const pid = runtime.acp?.pid as number;
      await waitFor('opencode process exit', () => !pidAlive(pid), 10_000);
      expect(pgrep('opencode').map(Number)).not.toContain(pid);

      console.log(
        `[real-acp] opencode full turn (default permissions): ${captured.durationMs}ms, ` +
          `signals=[${queue.signals.map((s) => s.type).join(',') || 'none'}], ` +
          `tools=[${toolCalls.map((c) => `${c.toolName}/${c.status}`).join(', ')}]`,
      );
    },
    180_000,
  );
});

describe.skipIf(!process.env.ACP_REAL_OPENCODE)('real opencode: permission ask path — permissions=ask injected (opt-in)', () => {
  it(
    'with permissions ask-all injected via OPENCODE_CONFIG, an out-of-workspace write asks; a refusal stops it',
    async () => {
      const dirs = makeRealDirs('opencode-ask-deny');
      trackDir(dirs.root);
      const forbiddenPath = `/tmp/wayang-acp-should-not-exist-${randomUUID()}.txt`;
      // P0 remediation under test (see the file header): opencode's stock
      // default allows every tool silently. The top-level `permissions`
      // ruleset set to ask-all restores the gate. Injected via OPENCODE_CONFIG
      // (subprocess env, per-test temp file — ~/.config/opencode untouched).
      const askConfigPath = join(dirs.root, 'opencode-ask.json');
      writeFileSync(
        askConfigPath,
        `${JSON.stringify({ permissions: [{ action: '*', resource: '*', effect: 'ask' }] }, null, 2)}\n`,
      );
      const worker = new WireTappingOpenCodeWorker(
        { ...makeWorkerConfig('opencode'), env: { OPENCODE_CONFIG: askConfigPath } } as any,
        dirs.sessionDir,
        dirs.workspace,
        makeMockCtxFor(dirs),
        skills,
      );
      // Refuse the requests that would WRITE the forbidden path; approve
      // read-only existence probes so the actual write request (the
      // interesting evidence) is reached. NOTE: match on "read-only"/command
      // shape only — never on words like "exist": the forbidden path itself
      // contains "should-not-exist".
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
        workerId: 'w-real-oc-ask',
        taskId: 'task-real-oc-ask',
        taskTitle: 'Real opencode permission ask',
        workerType: 'opencode',
      });

      const captured: { result?: WorkerResult; durationMs: number } = { durationMs: 0 };
      onTestFinished(() => {
        dumpEvidence('opencode-ask-deny', {
          durationMs: captured.durationMs,
          result: captured.result,
          forbiddenPath,
          askConfigPath,
          launch: worker.lastLaunch && { command: worker.lastLaunch.command, args: worker.lastLaunch.args },
          signalTypes: queue.signals.map((s) => s.type),
          signals: queue.signals,
          permissionRounds: permissionRounds(worker.wire),
          wireDigest: digestWire(worker.wire),
          wire: worker.wire,
        });
      });

      const task = makeTask(
        'real-oc-ask',
        `请把字符串 DENIED 写入文件 ${forbiddenPath}（这个路径在当前 workspace 之外）。尝试写入，然后报告结果。`,
      );
      const startedAt = Date.now();
      const result = await worker.run(task, {});
      captured.result = result;
      captured.durationMs = Date.now() - startedAt;

      // 0) The launch command actually used (with the env override, still
      //    `opencode acp`).
      expect(worker.lastLaunch).not.toBeNull();
      expect(worker.lastLaunch!.command).toBe('opencode');
      expect(worker.lastLaunch!.args).toEqual(['acp']);

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
      await waitFor('opencode process exit', () => !pidAlive(pid), 10_000);

      console.log(
        `[real-acp] opencode ask-deny (permissions=ask): ${captured.durationMs}ms, result=${result.status}, ` +
          `permission signals=${permissionSignals.length} (targeting forbidden: ${targeting.length}), ` +
          `answers=${JSON.stringify(rounds.map((r) => r.answer))}`,
      );
    },
    240_000,
  );
});

describe.skipIf(!process.env.ACP_REAL_OPENCODE)('real opencode: cancel (opt-in)', () => {
  it(
    'abort mid-tool → failed("Aborted"), no residual opencode/sleep processes, transcript intact',
    async () => {
      const dirs = makeRealDirs('opencode-cancel');
      trackDir(dirs.root);
      const worker = new WireTappingOpenCodeWorker(makeWorkerConfig('opencode'), dirs.sessionDir, dirs.workspace, makeMockCtxFor(dirs), skills);
      const queue = new RecordingSignalQueue(() => true);
      queue.bind(worker.permissionHandler);
      wireSignalContext(worker, dirs, queue, {
        workerId: 'w-real-oc-cancel',
        taskId: 'task-real-oc-cancel',
        taskTitle: 'Real opencode cancel',
        workerType: 'opencode',
      });

      const captured: { result?: WorkerResult; durationMs: number } = { durationMs: 0 };
      let sawSleep = true;
      let transcriptLineCount = 0;
      onTestFinished(() => {
        dumpEvidence('opencode-cancel', {
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

      // Baseline: no stray marker sleep on this machine before we start.
      const sleepBaseline = pgrep(SLEEP_MARKER);
      expect(sleepBaseline).toEqual([]);

      const task = makeTask('real-oc-cancel', `执行命令 ${SLEEP_MARKER} 并等待它完成，然后报告结果。`);
      const startedAt = Date.now();
      const runPromise = worker.run(task, {});
      // Abort once the long tool is actually in flight (the task's prescribed
      // 2–3s window after the round started producing work).
      try {
        await waitFor(`${SLEEP_MARKER} process to appear`, () => pgrep(SLEEP_MARKER).length > sleepBaseline.length, 45_000);
      } catch {
        sawSleep = false;
        console.log(`[real-acp] opencode cancel: ${SLEEP_MARKER} never observed — aborting on the fallback window`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      worker.abort();
      const result = await runPromise;
      captured.result = result;
      captured.durationMs = Date.now() - startedAt;

      // 1) Cancelled → failed('Aborted').
      expect(result).toEqual({ status: 'failed', error: 'Aborted' });

      // 2) The opencode process is gone (pid-scoped — a resident background
      //    service may legitimately keep running).
      const pid = (worker.getState().get<Record<string, any>>('runtimeState') ?? {}).acp?.pid;
      expect(typeof pid).toBe('number');
      await waitFor('opencode process exit', () => !pidAlive(pid), 15_000);
      expect(pgrep('opencode').map(Number)).not.toContain(pid);

      // 3) No residual tool subprocess (the sleep child must not be orphaned).
      if (sawSleep) {
        await waitFor(`${SLEEP_MARKER} child to be gone`, () => pgrep(SLEEP_MARKER).length === sleepBaseline.length, 5_000);
        expect(pgrep(SLEEP_MARKER)).toEqual([]);
      }

      // 4) Transcript intact: every persisted JSONL line parses; the opening
      //    user entry and the final error entry are present and readable.
      const entries = readTranscript(dirs.sessionDir, worker.id);
      transcriptLineCount = entries.length;
      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0].type).toBe('user');
      expect(entries[entries.length - 1].type).toBe('system');
      expect(entries[entries.length - 1].subtype).toBe('error');
      expect(worker.getConversation().length).toBe(entries.length);

      console.log(
        `[real-acp] opencode cancel: ${captured.durationMs}ms, sawSleep=${sawSleep}, pid=${pid}, ` +
          `transcript lines=${entries.length}, signals=[${queue.signals.map((s) => s.type).join(',') || 'none'}]`,
      );
    },
    150_000,
  );
});

// --- B. Controlled fail-fast (always on) -----------------------------------------

describe('opencode fail-fast (controlled PATH — no CLI reachable)', () => {
  it(
    'a PATH without opencode fails fast with the install-hint wording',
    async () => {
      const dirs = makeRealDirs('opencode-failfast');
      trackDir(dirs.root);
      // Controlled environment: point THIS process's PATH at an empty temp dir
      // (saved/restored in finally — no lasting change anywhere) so the
      // worker preflight sees a machine without opencode, regardless of what
      // is installed on the real machine.
      const emptyPathDir = join(dirs.root, 'empty-path');
      mkdirSync(emptyPathDir, { recursive: true });
      const savedPath = process.env.PATH;
      process.env.PATH = emptyPathDir;
      try {
        const worker = new OpenCodeAcpWorker(
          makeWorkerConfig('opencode'),
          dirs.sessionDir,
          dirs.workspace,
          makeMockCtxFor(dirs),
          skills,
        );
        const result = await worker.run(makeTask('oc-failfast', 'do something'), {});
        expect(result.status).toBe('failed');
        expect(result.error).toContain('opencode');
        expect(result.error).toContain('https://opencode.ai/docs/acp/');
      } finally {
        process.env.PATH = savedPath;
      }
    },
    15_000,
  );
});
