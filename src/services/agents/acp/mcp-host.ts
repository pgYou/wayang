/**
 * Host side of the per-run Wayang MCP bridge.
 *
 * One ACP worker run owns one Unix socket inside the session directory
 * (dedicated 0700 dir, 0600 socket). The bridge — spawned by the ACP agent as
 * a stdio MCP server — connects and MUST send a `hello` first frame carrying
 * the one-shot token and its pid. Every later NDJSON frame is a JSON-RPC
 * request handled by the shared MCP dispatcher; responses go back on the same
 * socket. Logs carry metadata only (no token, question, answer or reply text).
 */

import { createServer, type Socket } from 'node:net';
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Logger } from '@/infra/logger';
import { LineCodec } from '@/rpc/transport';
import {
  MAX_CONTEXT_CHARS,
  MAX_QUESTION_CHARS,
  MCP_ASK_TIMEOUT_MS,
  MCP_HANDSHAKE_TIMEOUT_MS,
  MCP_MAX_CONNECTIONS,
  MCP_PROGRESS_TIMEOUT_MS,
  capText,
} from './mcp-schemas';
import {
  createMcpDispatcher,
  DEFAULT_MCP_SERVER_INFO,
  type McpCallResult,
  type McpRequest,
  type McpServerInfo,
} from './mcp-protocol';

export interface McpHostOptions {
  socketPath: string;
  token: string;
  workerId: string;
  onProgress: (message: string) => void | Promise<void>;
  ask: (question: string, context?: string) => Promise<string>;
  logger: Logger;
  serverInfo?: McpServerInfo;
  handshakeTimeoutMs?: number;
  progressTimeoutMs?: number;
  askTimeoutMs?: number;
}

export interface McpHost {
  /** Resolves true on a valid hello, false on close or handshake timeout. */
  readonly ready: Promise<boolean>;
  isReady(): boolean;
  close(): Promise<void>;
}

export function generateMcpToken(): string {
  return randomBytes(32).toString('hex');
}

/** Socket lives in a dedicated 0700 directory — never chmod the session dir. */
export function mcpSocketPathFor(sessionDir: string, workerId: string, suffix: string): string {
  return join(sessionDir, '.mcp', `acp-mcp-${workerId}-${suffix}.sock`);
}

/**
 * Resolve the built bridge entry next to the running bundle. tsup emits both
 * entries flat in dist/; the extra candidates cover a source/test run and
 * older nested-output builds.
 */
export function resolveMcpBridgeEntryPath(importMetaUrl: string): string {
  const dir = dirname(fileURLToPath(importMetaUrl));
  const candidates = [
    join(dir, 'mcp-bridge-entry.js'),
    join(dir, 'services/agents/acp/mcp-bridge-entry.js'),
    join(dir, 'mcp-bridge-entry.ts'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

const TIMED_OUT = Symbol('mcp-host-timeout');
const ABORTED = Symbol('mcp-host-aborted');

/** Pending calls are settled on close so no invocation is left hanging. */
function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  pending: Set<() => void>,
): Promise<T | typeof TIMED_OUT | typeof ABORTED> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (value: T | typeof TIMED_OUT | typeof ABORTED): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      pending.delete(cancel);
      resolve(value);
    };
    const fail = (err: unknown): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      pending.delete(cancel);
      reject(err);
    };
    const timer = setTimeout(() => finish(TIMED_OUT), ms);
    timer.unref?.();
    const cancel = () => finish(ABORTED);
    pending.add(cancel);
    work.then(finish, fail);
  });
}

function safeEqualToken(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** SIGTERM → 2s → SIGKILL for an orphaned bridge. All failures are ignored. */
function stopBridgeProcesses(pids: Set<number>, logger: Logger, workerId: string): void {
  const alive = [...pids].filter((pid) => pid > 0 && pid !== process.pid);
  if (alive.length === 0) return;
  for (const pid of alive) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  const ladder = setTimeout(() => {
    for (const pid of alive) {
      try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }, 2_000);
  ladder.unref?.();
  logger.debug({ workerId, count: alive.length, reason: 'bridge-cleanup' }, 'ACP MCP bridge processes signalled');
}

export async function startMcpHost(opts: McpHostOptions): Promise<McpHost> {
  const dir = dirname(opts.socketPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  try {
    unlinkSync(opts.socketPath); // stale socket from a crashed run
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  let closed = false;
  let ready = false;
  let resolveReady: (value: boolean) => void = () => undefined;
  const readyPromise = new Promise<boolean>((resolve) => { resolveReady = resolve; });
  const connections = new Set<Socket>();
  const bridgePids = new Set<number>();
  const pendingCalls = new Set<() => void>();

  const handshakeTimer = setTimeout(() => {
    if (!closed && !ready) {
      opts.logger.warn({ workerId: opts.workerId, reason: 'mcp-handshake-timeout' }, 'ACP MCP bridge did not connect');
      resolveReady(false);
    }
  }, opts.handshakeTimeoutMs ?? MCP_HANDSHAKE_TIMEOUT_MS);
  handshakeTimer.unref?.();

  const invokeTool = async (name: string, args: Record<string, unknown>): Promise<McpCallResult> => {
    const started = Date.now();
    if (name === 'update_progress') {
      if (typeof args.message !== 'string' || args.message.length === 0) {
        return { text: '[MCP ERROR] update_progress requires a non-empty string "message"', isError: true };
      }
      const message = capText(args.message);
      const settled = await withTimeout(
        Promise.resolve().then(() => opts.onProgress(message)),
        opts.progressTimeoutMs ?? MCP_PROGRESS_TIMEOUT_MS,
        pendingCalls,
      );
      if (settled === ABORTED) return { text: '[ABORTED] Worker is shutting down.', isError: true };
      if (settled === TIMED_OUT) {
        return { text: '[TIMEOUT] The progress report was not delivered within 5s.', isError: true };
      }
      opts.logger.debug(
        { workerId: opts.workerId, toolName: name, charLen: message.length, durationMs: Date.now() - started, mcpAvailable: true, reason: 'progress' },
        'ACP MCP tool served',
      );
      return { text: `Progress reported: ${message}` };
    }
    if (name === 'ask_controller') {
      const question = capText(typeof args.question === 'string' ? args.question : '', MAX_QUESTION_CHARS);
      if (!question) return { text: '[MCP ERROR] ask_controller requires a non-empty string "question"', isError: true };
      const context = args.context === undefined ? undefined : capText(String(args.context), MAX_CONTEXT_CHARS);
      const settled = await withTimeout(opts.ask(question, context), opts.askTimeoutMs ?? MCP_ASK_TIMEOUT_MS, pendingCalls);
      const answer = settled === TIMED_OUT
        ? '[TIMEOUT] No answer from the controller within 5 minutes. Use your best judgment to continue.'
        : settled === ABORTED
          ? '[ABORTED] Worker is shutting down.'
          : settled;
      opts.logger.debug(
        { workerId: opts.workerId, toolName: name, charLen: answer.length, durationMs: Date.now() - started, mcpAvailable: true, reason: 'ask' },
        'ACP MCP tool served',
      );
      return { text: answer, isError: settled === TIMED_OUT || settled === ABORTED };
    }
    return { text: `Unknown tool: ${name}`, isError: true };
  };

  const dispatcher = createMcpDispatcher(invokeTool, opts.serverInfo ?? DEFAULT_MCP_SERVER_INFO);

  const handleFrame = async (frame: McpRequest, socket: Socket): Promise<void> => {
    if (closed || typeof frame.method !== 'string') return;
    try {
      const response = await dispatcher(frame);
      // `closed` is intentionally NOT checked here: close() settles pending
      // calls with [ABORTED] and must still deliver that final response.
      if (response && !socket.destroyed) {
        socket.write(`${JSON.stringify(response)}\n`);
      }
    } catch (err) {
      opts.logger.debug({ workerId: opts.workerId, err, reason: 'mcp-dispatch' }, 'ACP MCP request failed');
    }
  };

  const accept = (socket: Socket): void => {
    if (closed || connections.size >= MCP_MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    connections.add(socket);
    socket.unref?.();
    const codec = new LineCodec();
    let helloChecked = false;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      const frames = codec.push(chunk) as unknown as McpRequest[];
      for (const frame of frames) {
        if (!helloChecked) {
          helloChecked = true;
          const params = (frame?.params ?? {}) as Record<string, unknown>;
          const valid = frame?.method === 'hello'
            && params.workerId === opts.workerId
            && safeEqualToken(opts.token, params.token);
          if (!valid) {
            opts.logger.warn({ workerId: opts.workerId, reason: 'mcp-hello-rejected' }, 'ACP MCP bridge hello rejected');
            socket.destroy();
            return;
          }
          const pid = Number(params.pid);
          if (Number.isInteger(pid) && pid > 0) bridgePids.add(pid);
          ready = true;
          clearTimeout(handshakeTimer);
          resolveReady(true);
          continue;
        }
        void handleFrame(frame, socket);
      }
    });
    socket.on('close', () => connections.delete(socket));
    socket.on('error', () => { /* destroyed on close; never crash the run */ });
  };

  const server = createServer(accept);
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(opts.socketPath, () => {
      server.off('error', onError);
      resolve();
    });
  });
  chmodSync(opts.socketPath, 0o600);
  server.unref();

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearTimeout(handshakeTimer);
    if (!ready) resolveReady(false);
    for (const cancel of [...pendingCalls]) cancel();
    pendingCalls.clear();
    // Let settled invocations write their final (aborted) response before the
    // sockets go away — no call is left hanging on the agent side.
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const socket of connections) socket.destroy();
    connections.clear();
    await new Promise<void>((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
    });
    try { unlinkSync(opts.socketPath); } catch { /* already removed */ }
    stopBridgeProcesses(bridgePids, opts.logger, opts.workerId);
  };

  return { ready: readyPromise, isReady: () => ready && !closed, close };
}
