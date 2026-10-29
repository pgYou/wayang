/**
 * E2E harness — spawn the real `wayang server` binary (dist/cli.js),
 * drive it over stdio RPC, assert on live state.
 *
 * Requires `npm run build` first (harness runs dist/cli.js).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RpcClient, RemoteStateStore } from '@/rpc/rpc-client';
import { createStreamTransport } from '@/rpc/transport';
import { METHOD, NOTIFY } from '@/rpc/protocol';
import {
  startFakeProvider,
  type FakeProvider,
  type ScriptEntry,
} from '@/__tests__/fake-openai-provider';
import type { ControllerSignal, TaskDetail, ActiveWorkerInfo } from '@/types/index';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI_ENTRY = join(ROOT, 'dist', 'cli.js');

export interface E2EState {
  signals: ControllerSignal[];
  pending: TaskDetail[];
  running: TaskDetail[];
  history: TaskDetail[];
  activeWorkers: ActiveWorkerInfo[];
  /** Latest controller conversation entries (rendered view of all runs). */
  conversation: unknown[];
}

export interface E2ESetup {
  provider: FakeProvider;
  client: RpcClient;
  workspaceDir: string;
  homeDir: string;
  /** E2E root dir (holds home/, workspace/ and config.json); reusable across setups. */
  root: string;
  /** Session id reported by the server's ready notification. */
  sessionId: string;
  /** Session dir reported by the server's ready notification. */
  sessionDir: string;
  state: E2EState;
  /** Latest workerId from `completed` signals (for assignToWorker scripts). */
  lastCompletedWorkerId(): string | undefined;
  submit(text: string): Promise<void>;
  waitFor(what: string, predicate: (state: E2EState) => boolean, timeoutMs?: number): Promise<void>;
  /**
   * Graceful shutdown + cleanup. Pass `keep` to preserve the tmp root and/or
   * the fake provider for a follow-up setup (e.g. resume across restarts).
   */
  dispose(keep?: { root?: boolean; provider?: boolean }): Promise<void>;
}

export interface E2EOptions {
  /**
   * Value for the server's `--session` flag: 'new' (default) or
   * 'resume:<id>' — mirrors what the TUI client spawns.
   */
  session?: string;
  /** Reuse an existing e2e root (config.json + home/ with prior sessions). */
  root?: string;
  /** Reuse a fake provider so the endpoint in the reused config stays valid. */
  provider?: FakeProvider;
}

export async function setupE2E(script: ScriptEntry[], options: E2EOptions = {}): Promise<E2ESetup> {
  const provider = options.provider ?? await startFakeProvider(script);

  const root = options.root ?? mkdtempSync(join(tmpdir(), 'wayang-e2e-'));
  const homeDir = join(root, 'home');
  const workspaceDir = join(root, 'workspace');
  const configPath = join(root, 'config.json');
  if (!options.root) {
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      providers: { fake: { endpoint: provider.baseURL, apiKey: 'e2e-key', modelName: 'fake-model' } },
      controller: { provider: 'fake' },
      worker: { provider: 'fake', maxConcurrency: 1 },
    }));
  }

  const child: ChildProcess = spawn(process.execPath, [
    CLI_ENTRY,
    'server',
    '--config', configPath,
    '--home-dir', homeDir,
    '--workspace-dir', workspaceDir,
    '--session', options.session ?? 'new',
    '--log-level', 'silent',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  let stderrTail = '';
  child.stderr?.setEncoding('utf-8');
  child.stderr?.on('data', (c: string) => {
    stderrTail = (stderrTail + c).slice(-3000);
  });

  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code));
  });

  const transport = createStreamTransport(child.stdout! as never, child.stdin! as never);
  const client = new RpcClient(transport);
  const store = new RemoteStateStore(client);

  const ready = new Promise<Record<string, unknown>>((resolve) => {
    client.on(NOTIFY.READY, (params) => resolve(params));
  });
  const readyParams = await Promise.race([
    ready,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`server not ready. stderr:\n${stderrTail}`)), 30_000)),
  ]);

  // Collect live state via remote subscriptions.
  const state: E2EState = {
    signals: [],
    pending: [],
    running: [],
    history: [],
    activeWorkers: [],
    conversation: [],
  };
  store.subscribe('signalQueue', 'signals', (e) => { state.signals = (e.data as ControllerSignal[]) ?? []; });
  store.subscribe('engine', 'tasks.pending', (e) => { state.pending = (e.data as TaskDetail[]) ?? []; });
  store.subscribe('engine', 'tasks.running', (e) => { state.running = (e.data as TaskDetail[]) ?? []; });
  store.subscribe('engine', 'tasks.history', (e) => { state.history = (e.data as TaskDetail[]) ?? []; });
  store.subscribe('engine', 'activeWorkers', (e) => { state.activeWorkers = (e.data as ActiveWorkerInfo[]) ?? []; });
  store.subscribe('controllerAgent', 'conversation', (e) => { state.conversation = (e.data as unknown[]) ?? []; });

  let disposed = false;
  const setup: E2ESetup = {
    provider,
    client,
    workspaceDir,
    homeDir,
    root,
    sessionId: String(readyParams.sessionId ?? ''),
    sessionDir: String(readyParams.sessionDir ?? ''),
    state,
    lastCompletedWorkerId() {
      const completed = state.signals.filter((s) => s.type === 'completed');
      return completed.at(-1)?.payload?.workerId;
    },
    async submit(text: string): Promise<void> {
      await client.request(METHOD.SUBMIT_INPUT, { text });
    },
    async waitFor(what, predicate, timeoutMs = 30_000): Promise<void> {
      const start = Date.now();
      while (!predicate(state)) {
        if (Date.now() - start > timeoutMs) {
          const requestSummaries = provider.requests.map((r, i) => {
            const msgs = r.messages ?? [];
            const last = msgs.at(-1);
            return `#${i + 1} [${msgs[0]?.role}:${String(msgs[0]?.content ?? '').slice(0, 30)}] last=${last?.role}:${String(last?.content ?? '').slice(0, 150)}`;
          }).join('\n');
          const stateSummary = `history=[${state.history.map((t) => `${t.id}:${t.status}`).join(', ')}] `
            + `pending=${state.pending.length} running=${state.running.length} `
            + `signals=[${state.signals.map((s) => s.type).join(',')}] `
            + `workers=[${state.activeWorkers.map((w) => `${w.workerId}:${w.status}`).join(',')}]`;
          throw new Error(`waitFor timeout: ${what}\n--- state: ${stateSummary}\n--- provider requests (${provider.requests.length}):\n${requestSummaries}\n--- stderr tail:\n${stderrTail}`);
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    async dispose(keep?: { root?: boolean; provider?: boolean }): Promise<void> {
      if (disposed) return;
      disposed = true;
      try {
        await client.request(METHOD.SHUTDOWN);
      } catch { /* best effort */ }
      await Promise.race([
        exited,
        new Promise((resolve) => {
          setTimeout(() => {
            child.kill('SIGKILL');
            resolve(null);
          }, 5_000);
        }),
      ]);
      client.close();
      if (!keep?.provider) await provider.close();
      if (!keep?.root) rmSync(root, { recursive: true, force: true });
    },
  };

  return setup;
}
