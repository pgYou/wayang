/**
 * connectRemoteServer — spawn the headless `wayang server` child process
 * and attach an RPC client to its stdio.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createStreamTransport } from '@/rpc/transport';
import { RpcClient, RemoteStateStore } from '@/rpc/rpc-client';
import { METHOD, NOTIFY } from '@/rpc/protocol';
import { RemoteSupervisor } from './remote-supervisor';

export interface ConnectOptions {
  configPath: string;
  /** Wayang home dir (the `~/.wayang` equivalent). */
  homeDir: string;
  workspaceDir: string;
  session: 'new' | { resume: string };
  injectPreviousTasks?: boolean;
  logLevel?: string;
  readyTimeoutMs?: number;
}

export interface RemoteConnection {
  remote: RemoteSupervisor;
  /** Graceful stop: shutdown RPC → wait exit → force-kill fallback. */
  stop: () => Promise<void>;
}

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 5_000;

export async function connectRemoteServer(options: ConnectOptions): Promise<RemoteConnection> {
  const entry = process.argv[1];
  if (!entry) throw new Error('Cannot determine CLI entry path for server spawn');

  const sessionArg = options.session === 'new' ? 'new' : `resume:${options.session.resume}`;
  const args = [
    entry,
    'server',
    '--config', options.configPath,
    '--home-dir', options.homeDir,
    '--workspace-dir', options.workspaceDir,
    '--session', sessionArg,
  ];
  if (options.injectPreviousTasks) args.push('--inject-previous-tasks');
  if (options.logLevel) args.push('--log-level', options.logLevel);

  const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });

  let stderrTail = '';
  child.stderr?.setEncoding('utf-8');
  child.stderr?.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-4000);
  });

  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code));
  });

  const transport = createStreamTransport(child.stdout!, child.stdin!);
  const rpc = new RpcClient(transport);

  await waitForReady(child, rpc, exited, stderrTail, options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);

  const store = new RemoteStateStore(rpc);
  let stopping = false;

  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      await Promise.race([
        rpc.request(METHOD.SHUTDOWN),
        new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown timeout')), SHUTDOWN_GRACE_MS)),
      ]);
    } catch {
      // fall through to exit wait / kill
    }
    const exitOrKill = Promise.race([
      exited,
      new Promise<number | null>((resolve) => {
        setTimeout(() => {
          child.kill('SIGKILL');
          resolve(null);
        }, SHUTDOWN_GRACE_MS);
      }),
    ]);
    await exitOrKill;
    rpc.close();
  };

  // Unexpected server death mid-session: surface and exit — the TUI cannot
  // recover from a lost logic process in 0.5.
  void exited.then((code) => {
    if (!stopping) {
      console.error(`Wayang server exited unexpectedly (code ${code}).\n${stderrTail}`);
      process.exit(1);
    }
  });

  const remote = new RemoteSupervisor(rpc, store, options.workspaceDir, { stop });
  return { remote, stop };
}

function waitForReady(
  child: ChildProcess,
  rpc: RpcClient,
  exited: Promise<number | null>,
  stderrTail: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      offReady();
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`Wayang server did not become ready within ${timeoutMs}ms.\n${stderrTail}`));
    }, timeoutMs);
    const offReady = rpc.on(NOTIFY.READY, () => finish());
    void exited.then((code) => {
      finish(new Error(`Wayang server exited before becoming ready (code ${code}).\n${stderrTail}`));
    });
  });
}
