import { PassThrough } from 'node:stream';
import { RpcServer } from '@wayang-ai/protocol/rpc/rpc-server';
import { createStreamTransport } from '@wayang-ai/protocol/rpc/transport';
import { messagePortToStreams, type MessagePortLike } from '@wayang-ai/protocol/rpc/message-port';
import { METHOD, NOTIFY } from '@wayang-ai/protocol/rpc/protocol';

/**
 * Shared test harness: a fake UtilityProcess child wired to a real RpcServer
 * over the message-port adapter — the same framing path as production
 * (asMessagePort on the main side, structural port on the server side).
 * Exiting closes the port: a postMessage on a dead child throws, which fails
 * the main-side transport and rejects pending requests exactly like a real
 * UtilityProcess death.
 *
 * Not a test file itself (vitest only collects *.test.ts); imported by the
 * server-process-host and session-service suites.
 */

export interface FakeChild {
  postMessage(data: unknown): void;
  addListener(event: 'message', listener: (message: unknown) => void): void;
  removeListener(event: 'message', listener: (message: unknown) => void): void;
  once(event: 'exit', listener: (code: number | null) => void): void;
  kill(): void;
  stderr: PassThrough;
  stdout: PassThrough;
}

export class LoopbackServer {
  readonly child: FakeChild;
  readonly argv: string[] = [];
  readonly subscribeRequests: Array<{ target: string; path: string }> = [];
  readonly snapshotRequests: Array<{ target: string; path: string }> = [];
  /** Config hot-update RPCs (§2.4 eight fine-grained methods) as received. */
  readonly updateRequests: Array<{ method: string; params: Record<string, unknown> }> = [];
  shutdownRequests = 0;
  private readonly serverListeners = new Set<(event: { data: unknown }) => void>();
  private readonly childListeners = new Set<(message: unknown) => void>();
  private readonly exitListeners: Array<(code: number | null) => void> = [];
  private readonly rpc: RpcServer;
  private exited = false;

  constructor(readonly sessionId: string) {
    const serverPort: MessagePortLike = {
      // child→parent frames arrive as raw payloads on the parent side.
      postMessage: (data) => {
        for (const fn of this.childListeners) fn(data);
      },
      addListener: (_event, fn) => {
        this.serverListeners.add(fn);
      },
      removeListener: (_event, fn) => {
        this.serverListeners.delete(fn);
      },
    };
    this.child = {
      // parent→child frames arrive MessageEvent-shaped on the child side.
      postMessage: (data) => {
        if (this.exited) throw new Error('port closed: child exited');
        for (const fn of this.serverListeners) fn({ data });
      },
      addListener: (_event, fn) => {
        this.childListeners.add(fn);
      },
      removeListener: (_event, fn) => {
        this.childListeners.delete(fn);
      },
      once: (event, listener) => {
        if (event !== 'exit') throw new Error(`unexpected once(${event})`);
        this.exitListeners.push(listener);
      },
      kill: () => this.emitExit(9),
      stderr: new PassThrough(),
      stdout: new PassThrough(),
    };

    const io = messagePortToStreams(serverPort);
    this.rpc = new RpcServer(createStreamTransport(io.stdin, io.stdout));
    this.rpc.register(METHOD.SUBSCRIBE, (params) => {
      this.subscribeRequests.push({ target: String(params.target), path: String(params.path) });
      return { subscriptionId: `sub-${this.subscribeRequests.length}`, data: { fixture: true, target: params.target, path: params.path } };
    });
    this.rpc.register(METHOD.GET_SNAPSHOT, (params) => {
      this.snapshotRequests.push({ target: String(params.target), path: String(params.path) });
      return { data: { fixture: true, target: params.target, path: params.path } };
    });
    this.rpc.register(METHOD.SHUTDOWN, () => {
      this.shutdownRequests += 1;
      // Mirror the real server: a graceful shutdown ends the process.
      setImmediate(() => this.emitExit(0));
      return {};
    });
    // The eight config hot-update methods (§2.4): record and succeed.
    for (const method of [
      METHOD.UPDATE_PROVIDER,
      METHOD.UPDATE_MODEL,
      METHOD.ADD_PROVIDER,
      METHOD.ADD_MODEL,
      METHOD.REMOVE_PROVIDER,
      METHOD.REMOVE_MODEL,
      METHOD.UPDATE_CONTROLLER_MODEL,
      METHOD.UPDATE_WORKER_SETTINGS,
    ]) {
      this.rpc.register(method, (params) => {
        this.updateRequests.push({ method, params: params as Record<string, unknown> });
        return { affected: [] };
      });
    }
  }

  /** Announce readiness; a null id reproduces an id-less ready frame. */
  notifyReady(sessionId: string | null = this.sessionId): void {
    const params: Record<string, unknown> = { sessionDir: `/sessions/${this.sessionId}` };
    if (sessionId !== null) params.sessionId = sessionId;
    this.rpc.notify(NOTIFY.READY, params);
  }

  emitExit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    for (const fn of [...this.exitListeners]) fn(code);
  }

  writeStderr(text: string): void {
    this.child.stderr.write(text);
  }
}
