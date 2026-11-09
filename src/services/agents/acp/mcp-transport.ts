/**
 * TRANSPORT LAYER (stdio bridge / Unix socket) — the ONE place where socket
 * paths, one-shot tokens, the bridge process, spawn descriptors, hello/pid
 * handling and NDJSON framing live. `startStdioMcpTransport` is the only
 * surface the worker run layer touches; tool semantics are injected via an
 * `McpToolInvoker` from mcp-tools.ts.
 *
 * Future ACP v2 `McpServerAcp` (type 'acp', MCP tunnelled over `mcp/message`)
 * needs ONLY a second implementation of `McpTransport` plus capability
 * detection in the worker layer — no change to the tool registry, the tool
 * invoker, the schemas or the progress fallback timer.
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
import type { AcpMcpServer } from '@/services/acp/types';
import { LineCodec } from '@/rpc/transport';
import { MCP_SERVER_NAME } from './mcp-schemas';
import type { McpToolInvoker } from './mcp-tools';
import {
  createMcpDispatcher,
  DEFAULT_MCP_SERVER_INFO,
  type McpRequest,
  type McpServerInfo,
} from './mcp-protocol';

// --- Transport-only constants (shared with the bridge child process) ---
export const MCP_ENV_SOCKET = 'WAYANG_MCP_SOCK';
export const MCP_ENV_TOKEN = 'WAYANG_MCP_TOKEN';
export const MCP_ENV_WORKER_ID = 'WAYANG_MCP_WORKER_ID';
/** session/new succeeded with injection, but no bridge hello within 10s. */
export const MCP_HANDSHAKE_TIMEOUT_MS = 10_000;
/** Bridge exits when no host connection appears (orphan protection). */
export const MCP_WATCHDOG_MS = 5_000;
export const MCP_MAX_CONNECTIONS = 4;
/** Safety net for a relayed call; real per-tool ceilings live in the tool layer. */
export const MCP_RELAY_TIMEOUT_MS = 315_000;

export interface McpHostOptions {
  socketPath: string;
  token: string;
  workerId: string;
  /** Tool semantics injected by the tool layer; transport never inspects them. */
  invoker: McpToolInvoker;
  logger: Logger;
  serverInfo?: McpServerInfo;
  handshakeTimeoutMs?: number;
}

/** The transport contract the run layer depends on — no spawn/socket details. */
export interface McpTransport {
  /** Descriptor injected into session/new ([] on degrade). */
  readonly descriptor: AcpMcpServer;
  /** Resolves true on a valid hello, false on close or handshake timeout. */
  readonly ready: Promise<boolean>;
  isReady(): boolean;
  close(): Promise<void>;
}

export interface StartMcpTransportOptions {
  sessionDir: string;
  workerId: string;
  invoker: McpToolInvoker;
  logger: Logger;
  serverInfo?: McpServerInfo;
}

export interface McpHost {
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

  const handshakeTimer = setTimeout(() => {
    if (!closed && !ready) {
      opts.logger.warn({ workerId: opts.workerId, reason: 'mcp-handshake-timeout' }, 'ACP MCP bridge did not connect');
      resolveReady(false);
    }
  }, opts.handshakeTimeoutMs ?? MCP_HANDSHAKE_TIMEOUT_MS);
  handshakeTimer.unref?.();

  // Tool semantics are injected — the transport only routes frames to them.
  const dispatcher = createMcpDispatcher(
    (name, args) => opts.invoker.invoke(name, args),
    opts.serverInfo ?? DEFAULT_MCP_SERVER_INFO,
  );

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
    opts.invoker.settlePending();
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

/** ACP v1 stdio server descriptor: `env` is an ARRAY of {name,value}. */
export function buildMcpServerDescriptor(opts: {
  socketPath: string;
  token: string;
  workerId: string;
  bridgeEntryPath: string;
  nodeExecutable?: string;
}): AcpMcpServer {
  return {
    name: MCP_SERVER_NAME,
    command: opts.nodeExecutable ?? process.execPath,
    args: [opts.bridgeEntryPath],
    env: [
      { name: MCP_ENV_SOCKET, value: opts.socketPath },
      { name: MCP_ENV_TOKEN, value: opts.token },
      { name: MCP_ENV_WORKER_ID, value: opts.workerId },
    ],
  };
}

/**
 * The single transport implementation used today. Everything about the stdio
 * bridge (socket, token, spawn path, hello, pid cleanup) stays behind this
 * function; callers see only `McpTransport`. Swapping in ACP v2's `acp`
 * transport means adding a sibling `startAcpTunnelMcpTransport` with the same
 * return type — the tool layer and the worker run need no schema/tool changes.
 */
export async function startStdioMcpTransport(opts: StartMcpTransportOptions): Promise<McpTransport> {
  const socketPath = mcpSocketPathFor(opts.sessionDir, opts.workerId, generateMcpToken().slice(0, 12));
  const token = generateMcpToken();
  const bridgeEntryPath = resolveMcpBridgeEntryPath(import.meta.url);
  const host = await startMcpHost({
    socketPath,
    token,
    workerId: opts.workerId,
    invoker: opts.invoker,
    logger: opts.logger,
    serverInfo: opts.serverInfo,
  });
  return {
    descriptor: buildMcpServerDescriptor({ socketPath, token, workerId: opts.workerId, bridgeEntryPath }),
    ready: host.ready,
    isReady: host.isReady,
    close: host.close,
  };
}
