/**
 * Bridge side of the per-run Wayang MCP injection (tsup's SECOND entry).
 *
 * The ACP agent spawns this file as a stdio MCP server. stdin/stdout carry
 * NDJSON JSON-RPC (stdout is protocol-only — every log goes to stderr); the
 * main process is reached over the sessionDir Unix socket. The first frame on
 * that socket is `hello{token,workerId,pid}`; after that, agent requests are
 * relayed verbatim and host responses are relayed back by JSON-RPC id.
 *
 * Exit paths: stdin EOF, host socket EOF, 5s no-connection watchdog, SIGTERM.
 * When no host is configured (or the socket is gone) it still answers
 * initialize / tools/list / ping locally so the agent never hangs.
 */

import { connect, type Socket } from 'node:net';
import pkg from '../../../../package.json';
import {
  MCP_ASK_TIMEOUT_MS,
  MCP_ENV_SOCKET,
  MCP_ENV_TOKEN,
  MCP_ENV_WORKER_ID,
  MCP_PROGRESS_TIMEOUT_MS,
  MCP_WATCHDOG_MS,
} from './mcp-schemas';
import {
  createMcpDispatcher,
  type McpRequest,
  type McpResponse,
} from './mcp-protocol';

const SERVER_INFO = { name: 'wayang', version: pkg.version as string };
const RELAY_GRACE_MS = 1_000;

/** NDJSON framing that tolerates split and coalesced writes. */
class NdjsonDecoder {
  private buffer = '';
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) lines.push(line);
    }
    return lines;
  }
  flush(): string[] {
    const line = this.buffer.trim();
    this.buffer = '';
    return line ? [line] : [];
  }
}

const socketPath = process.env[MCP_ENV_SOCKET] ?? '';
const token = process.env[MCP_ENV_TOKEN] ?? '';
const workerId = process.env[MCP_ENV_WORKER_ID] ?? '';
const configured = socketPath.length > 0 && token.length > 0;

let socket: Socket | null = null;
let hostConnected = false;
let awaitingHost = configured;
let stopping = false;
let watchdog: ReturnType<typeof setTimeout> | null = null;
const outbox: string[] = [];
const pending = new Map<number | string, ReturnType<typeof setTimeout>>();

function log(message: string): void {
  process.stderr.write(`[wayang-mcp-bridge] ${message}\n`);
}

function writeStdout(frame: McpResponse): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function errorResponse(id: number | string, text: string): void {
  writeStdout({
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text }], isError: true },
  });
}

/** Standalone invoker: the host is not reachable, but tools never hang. */
const localDispatcher = createMcpDispatcher(
  async () => ({ text: '[UNAVAILABLE] The Wayang MCP host is not connected.', isError: true }),
  SERVER_INFO,
);

async function respondLocally(frame: McpRequest): Promise<void> {
  const response = await localDispatcher(frame);
  if (response) writeStdout(response);
}

function clearPending(sendAborted: boolean): void {
  for (const [id, timer] of pending) {
    clearTimeout(timer);
    if (sendAborted) errorResponse(id, '[ABORTED] Worker is shutting down.');
  }
  pending.clear();
}

function shutdown(code = 0): void {
  if (stopping) return;
  stopping = true;
  if (watchdog) clearTimeout(watchdog);
  clearPending(true);
  if (socket) {
    socket.destroy();
    socket = null;
  }
  hostConnected = false;
  // Let stdout flush, then leave; stdin may still be open on the agent side.
  const exit = setTimeout(() => process.exit(code), 20);
  exit.unref?.();
  process.exitCode = code;
}

/** Stop expecting host responses: serve buffered/later frames locally. */
function fallbackToLocal(reason: string): void {
  if (stopping) return;
  log(`host unavailable (${reason}); serving MCP locally`);
  hostConnected = false;
  awaitingHost = false;
  socket = null;
  if (watchdog) { clearTimeout(watchdog); watchdog = null; }
  clearPending(true);
  const buffered = outbox.splice(0, outbox.length);
  for (const line of buffered) {
    try { void respondLocally(JSON.parse(line) as McpRequest); } catch { /* malformed line */ }
  }
}

function relayToHost(line: string, frame: McpRequest): void {
  if (!socket || !hostConnected) {
    void respondLocally(frame);
    return;
  }
  const id = frame.id;
  if (id !== undefined && id !== null && typeof frame.method === 'string') {
    const params = (frame.params ?? {}) as { name?: unknown };
    const isAsk = frame.method === 'tools/call' && params.name === 'ask_controller';
    const ms = (isAsk ? MCP_ASK_TIMEOUT_MS : MCP_PROGRESS_TIMEOUT_MS) + RELAY_GRACE_MS;
    const timer = setTimeout(() => {
      if (!pending.delete(id)) return;
      errorResponse(id, '[TIMEOUT] The Wayang MCP host did not answer in time.');
    }, ms);
    timer.unref?.();
    pending.set(id, timer);
  }
  socket.write(`${line}\n`); // outbox holds TRIMMED lines; restore NDJSON framing
}

function handleLine(line: string): void {
  if (!line.trim()) return;
  let frame: McpRequest;
  try {
    frame = JSON.parse(line) as McpRequest;
  } catch {
    log('dropping a malformed stdin frame');
    return;
  }
  if (awaitingHost && !stopping) {
    outbox.push(line); // wait for hello/connection, or for local fallback
    return;
  }
  relayToHost(line, frame);
}

function connectToHost(): void {
  const client = connect(socketPath);
  socket = client;
  const codec = new NdjsonDecoder();
  client.setEncoding('utf8');
  client.on('connect', () => {
    hostConnected = true;
    awaitingHost = false;
    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
    // First frame MUST be hello — the host drops the socket otherwise.
    client.write(`${JSON.stringify({
      jsonrpc: '2.0',
      method: 'hello',
      params: { token, workerId, pid: process.pid },
    })}\n`);
    const buffered = outbox.splice(0, outbox.length);
    for (const line of buffered) {
      try { relayToHost(line, JSON.parse(line) as McpRequest); } catch { /* malformed line */ }
    }
  });
  client.on('data', (chunk: string) => {
    for (const line of codec.push(chunk)) {
      let frame: McpResponse;
      try { frame = JSON.parse(line) as McpResponse; } catch { continue; }
      if (frame.id !== undefined && frame.id !== null) {
        const timer = pending.get(frame.id);
        if (timer) { clearTimeout(timer); pending.delete(frame.id); }
      }
      writeStdout(frame);
    }
  });
  client.on('error', (err) => fallbackToLocal((err as NodeJS.ErrnoException).code ?? 'socket-error'));
  client.on('close', () => {
    const wasConnected = hostConnected;
    hostConnected = false;
    if (wasConnected && !stopping) shutdown(0); // host EOF → no orphan bridge
  });
  watchdog = setTimeout(() => {
    if (!hostConnected && !stopping) {
      log('no host connection within the watchdog window');
      shutdown(0);
    }
  }, MCP_WATCHDOG_MS);
  watchdog.unref?.();
}

if (configured) connectToHost();

const stdinCodec = new NdjsonDecoder();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  for (const line of stdinCodec.push(chunk)) handleLine(line);
});
process.stdin.on('end', () => {
  for (const line of stdinCodec.flush()) handleLine(line);
  shutdown(0);
});
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
