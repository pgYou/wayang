/**
 * Shared harness for the real-machine ACP verification tests
 * (`real-codebuddy.test.ts` / `real-opencode.test.ts`) — Refs #25.
 *
 * Test-only fixtures: a wire-tapping transport wrapper (records both
 * directions, changes no behavior), a recording SignalQueue stand-in with a
 * permission auto-answer, temp session/workspace dirs with the package.json
 * fixture the tasks read, evidence dumps into `.agents/tmp/real-evidence/`,
 * and process helpers (pgrep / pid-alive / waitFor) for orphan hunting.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskDetail, WorkerConfig } from '@/types/index';
import { SkillRegistry } from '@/services/skills/registry';
import { createMockCtx } from '@/__tests__/helpers';
import { ApprovalMemory } from '@/services/permission/approval-memory';
import { CodebuddyAcpWorker } from '@/services/agents/acp/codebuddy-acp-worker';
import { OpenCodeAcpWorker } from '@/services/agents/acp/opencode-acp-worker';
import { StdioAcpTransport, type StderrAcpTransport } from '@/services/acp/transport';
import type { AcpLaunchConfig } from '@/services/acp/config';

export const skills = new SkillRegistry([]);

/** Any provider worker (the surface setSignalContext needs). */
export type RealAcpWorker = CodebuddyAcpWorker | OpenCodeAcpWorker;

// --- Wire tap ------------------------------------------------------------------

/** One timestamped wire record: `client` = wayang→agent, `agent` = agent→wayang. */
export interface WireRecord {
  ts: string;
  dir: 'client' | 'agent';
  line: string;
}

/** Wrap the production transport with a both-directions recorder. Behavior-neutral. */
export function tapTransport(inner: StdioAcpTransport, wire: WireRecord[]): StderrAcpTransport {
  const tap = (dir: 'client' | 'agent', line: string): void => {
    wire.push({ ts: new Date().toISOString(), dir, line });
  };
  return {
    start: () => inner.start(),
    write: (line) => {
      tap('client', line);
      inner.write(line);
    },
    close: (opts) => inner.close(opts),
    onMessage: (handler) =>
      inner.onMessage((line) => {
        tap('agent', line);
        handler(line);
      }),
    onClose: (handler) => inner.onClose(handler),
    onError: (handler) => inner.onError(handler),
    onStderr: (handler) => inner.onStderr(handler),
    stderrTail: () => inner.stderrTail(),
    get pid() {
      return inner.pid;
    },
  };
}

/** CodebuddyAcpWorker with the wire tap injected (real StdioAcpTransport). */
export class WireTappingCodebuddyWorker extends CodebuddyAcpWorker {
  readonly wire: WireRecord[] = [];
  /** The launch config the run actually used (command/args evidence). */
  lastLaunch: AcpLaunchConfig | null = null;

  protected createTransport(config: AcpLaunchConfig): StderrAcpTransport {
    this.lastLaunch = config;
    return tapTransport(new StdioAcpTransport(config), this.wire);
  }
}

/** OpenCodeAcpWorker with the wire tap injected (real StdioAcpTransport). */
export class WireTappingOpenCodeWorker extends OpenCodeAcpWorker {
  readonly wire: WireRecord[] = [];
  /** The launch config the run actually used (command/args evidence). */
  lastLaunch: AcpLaunchConfig | null = null;

  protected createTransport(config: AcpLaunchConfig): StderrAcpTransport {
    this.lastLaunch = config;
    return tapTransport(new StdioAcpTransport(config), this.wire);
  }
}

// --- Recording signal queue -----------------------------------------------------

/** Decide one permission_request: true = approve, false = refuse. */
export type PermissionDecision = (payload: Record<string, any>) => boolean;

/** Recording stand-in for the engine's SignalQueue, with a permission auto-answer. */
export class RecordingSignalQueue {
  readonly signals: Array<Record<string, any>> = [];
  private readonly decide?: PermissionDecision;
  private permissionHandler: { resolvePermission: (id: string, approved: boolean, reason?: string) => boolean } | null = null;

  constructor(decide?: PermissionDecision) {
    this.decide = decide;
  }

  /** Wire the worker whose permissionHandler answers the collected requests. */
  bind(handler: RecordingSignalQueue['permissionHandler']): void {
    this.permissionHandler = handler;
  }

  enqueue(sig: Record<string, any>): void {
    this.signals.push(sig);
    if (sig.type !== 'permission_request' || !this.permissionHandler) return;
    const payload = (sig.payload ?? {}) as Record<string, any>;
    const requestId = String(payload.requestId ?? '');
    const approved = this.decide ? this.decide(payload) : true;
    // The bridge parks its BlockingRequestMap.wait right after enqueue();
    // answer on a later macrotask so resolvePermission never races the
    // registration (a resolve-before-wait would be silently dropped).
    setTimeout(() => {
      this.permissionHandler!.resolvePermission(requestId, approved, `real-machine auto ${approved ? 'approve' : 'deny'}`);
    }, 50);
  }

  byType(type: string): Array<Record<string, any>> {
    return this.signals.filter((s) => s.type === type);
  }
}

// --- Temp dirs & cleanup --------------------------------------------------------

export interface RealDirs {
  root: string;
  sessionDir: string;
  workspace: string;
}

const trackedDirs: string[] = [];

/** Track a dir for afterEach cleanup. */
export function trackDir(dir: string): void {
  trackedDirs.push(dir);
}

/** Remove everything tracked so far (call from each test file's afterEach). */
export function cleanupTrackedDirs(): void {
  while (trackedDirs.length > 0) {
    rmSync(trackedDirs.pop()!, { recursive: true, force: true });
  }
}

/** Fresh session dir + workspace (with the package.json fixture the tasks read). */
export function makeRealDirs(caseName: string): RealDirs {
  const root = mkdtempSync(join(tmpdir(), `acp-real-${caseName}-`));
  const sessionDir = join(root, 'session');
  const workspace = join(root, 'workspace');
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    join(workspace, 'package.json'),
    `${JSON.stringify({ name: 'wayang-acp-real-fixture', version: '9.9.9-real' }, null, 2)}\n`,
  );
  mkdirSync(join(workspace, '.agents', 'tmp', 'real'), { recursive: true });
  return { root, sessionDir, workspace };
}

// --- Evidence dumps --------------------------------------------------------------

const EVIDENCE_DIR = join(process.cwd(), '.agents', 'tmp', 'real-evidence');

/** Persist one case's evidence bundle (best effort — diagnostics only). */
export function dumpEvidence(caseName: string, evidence: Record<string, unknown>): void {
  try {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const file = join(EVIDENCE_DIR, `${caseName}.json`);
    writeFileSync(file, JSON.stringify(evidence, null, 2));
    console.log(`[real-acp] evidence → ${file}`);
  } catch (err) {
    console.log(`[real-acp] evidence dump failed: ${String(err)}`);
  }
}

export function parseWire(wire: WireRecord[]): Array<{ dir: string; msg: any }> {
  return wire.flatMap((record) => {
    try {
      return [{ dir: record.dir, msg: JSON.parse(record.line) }];
    } catch {
      return [];
    }
  });
}

/** Compact wire digest: lifecycle, update-variant counts, permission shapes, stopReasons. */
export function digestWire(wire: WireRecord[]): Record<string, unknown> {
  const parsed = parseWire(wire);
  const variantCounts: Record<string, number> = {};
  for (const { msg } of parsed) {
    if (msg?.method === 'session/update') {
      const variant = String(msg.params?.update?.sessionUpdate ?? '???');
      variantCounts[variant] = (variantCounts[variant] ?? 0) + 1;
    }
  }
  const initialize = parsed.find(({ dir, msg }) => dir === 'agent' && msg?.result?.protocolVersion !== undefined)?.msg.result;
  const sessionNew = parsed.find(({ dir, msg }) => dir === 'agent' && msg?.result?.sessionId !== undefined)?.msg.result;
  return {
    initialize:
      initialize && {
        protocolVersion: initialize.protocolVersion,
        authMethods: (initialize.authMethods ?? []).map((m: any) => m.name),
        agentInfo: initialize.agentInfo,
        agentCapabilityKeys: Object.keys(initialize.agentCapabilities ?? {}),
      },
    sessionNew: sessionNew && { sessionId: sessionNew.sessionId, responseKeys: Object.keys(sessionNew) },
    clientCalls: parsed.filter(({ dir, msg }) => dir === 'client' && msg?.method).map(({ msg }) => msg.method),
    updateVariantCounts: variantCounts,
    permissionRequests: parsed
      .filter(({ dir, msg }) => dir === 'agent' && msg?.method === 'session/request_permission')
      .map(({ msg }) => ({
        id: msg.id,
        toolCallKeys: Object.keys(msg.params?.toolCall ?? {}),
        toolCall: msg.params?.toolCall,
        options: (msg.params?.options ?? []).map((o: any) => ({ optionId: o.optionId, kind: o.kind })),
      })),
    permissionAnswers: parsed
      .filter(({ dir, msg }) => dir === 'client' && msg?.id !== undefined && msg?.result?.outcome !== undefined)
      .map(({ msg }) => ({ id: msg.id, result: msg.result })),
    stopReasons: parsed
      .filter(({ dir, msg }) => dir === 'agent' && msg?.result?.stopReason !== undefined)
      .map(({ msg }) => msg.result.stopReason),
    wireLineCount: { client: wire.filter((r) => r.dir === 'client').length, agent: wire.filter((r) => r.dir === 'agent').length },
    unparsedLineCount: wire.length - parseWire(wire).length,
  };
}

/**
 * Every session/request_permission the agent sent, joined with the answer
 * wayang wrote back — the wire-level truth of the permission round.
 */
export function permissionRounds(wire: WireRecord[]): Array<{ requestId: unknown; toolCall: any; options: any[]; answer: any }> {
  const parsed = parseWire(wire);
  const requests = new Map<unknown, any>();
  for (const { dir, msg } of parsed) {
    if (dir === 'agent' && msg?.method === 'session/request_permission') requests.set(msg.id, msg);
  }
  const rounds: Array<{ requestId: unknown; toolCall: any; options: any[]; answer: any }> = [];
  for (const { dir, msg } of parsed) {
    if (dir !== 'client' || msg?.id === undefined || !requests.has(msg.id)) continue;
    const request = requests.get(msg.id);
    rounds.push({
      requestId: msg.id,
      toolCall: request.params?.toolCall,
      options: request.params?.options ?? [],
      answer: msg.result,
    });
  }
  return rounds;
}

// --- Process helpers --------------------------------------------------------------

/** pgrep -f with a safe no-match → [] (pgrep exits 1 when nothing matches). */
export function pgrep(pattern: string): string[] {
  try {
    return execSync(`pgrep -f '${pattern}'`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function pidAlive(pid: number | null | undefined): boolean {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitFor(what: string, predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for: ${what} (waited ${Date.now() - start}ms)`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// --- Fixtures -----------------------------------------------------------------------

export function makeTask(id: string, description: string): TaskDetail & { workerId: string } {
  return {
    id,
    title: `Real ${id}`,
    description,
    priority: 'normal',
    status: 'pending',
    createdAt: Date.now(),
    workerId: `w-${id}`,
    executionTurnId: `turn-${id}`,
  };
}

/** Standard engine-style signal wiring for a real-machine case. */
export function wireSignalContext(
  worker: RealAcpWorker,
  dirs: RealDirs,
  queue: RecordingSignalQueue,
  ids: { workerId: string; taskId: string; taskTitle: string; workerType: string },
): void {
  worker.setSignalContext({
    signalQueue: queue as any,
    workerId: ids.workerId,
    taskId: ids.taskId,
    taskTitle: ids.taskTitle,
    workerType: ids.workerType,
    accessScope: { userHome: homedir(), workspace: dirs.workspace },
    grants: new ApprovalMemory(),
    approvalMemory: 'task',
  });
}

export function makeWorkerConfig(type: string): WorkerConfig {
  return { type, description: 'real-machine verification' } as WorkerConfig;
}

export function makeMockCtxFor(dirs: RealDirs) {
  return createMockCtx({ sessionDir: dirs.sessionDir, workspaceDir: dirs.workspace } as any);
}

/** Path of the persisted transcript of one worker run. */
export function transcriptPathOf(sessionDir: string, workerId: string): string {
  return join(sessionDir, 'workers', workerId, 'conversation.jsonl');
}

/** Read the persisted transcript, parsing every line (throws on a torn line). */
export function readTranscript(sessionDir: string, workerId: string): Array<Record<string, any>> {
  const file = transcriptPathOf(sessionDir, workerId);
  expectFileExists(file);
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function expectFileExists(file: string): void {
  if (!existsSync(file)) throw new Error(`transcript missing: ${file}`);
}
