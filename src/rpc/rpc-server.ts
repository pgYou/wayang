/**
 * RpcServer — dispatches incoming requests to registered handlers and
 * sends notifications. Transport-agnostic.
 */

import type { RpcTransport } from './transport';
import { isRpcRequest, RpcError, RPC_ERROR, type RpcRequest, type RpcResponse } from './protocol';

export type RpcHandler = (params: Record<string, unknown>) => unknown | Promise<unknown>;

export class RpcServer {
  private handlers = new Map<string, RpcHandler>();

  constructor(private readonly transport: RpcTransport) {
    transport.onMessage((msg) => {
      if (isRpcRequest(msg)) void this.handleRequest(msg);
      // Responses from the client are not part of v1 — ignore.
    });
  }

  register(method: string, handler: RpcHandler): void {
    this.handlers.set(method, handler);
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.transport.send({ method, params });
  }

  private async handleRequest(req: RpcRequest): Promise<void> {
    let response: RpcResponse;
    try {
      const handler = this.handlers.get(req.method);
      if (!handler) {
        throw new RpcError(RPC_ERROR.METHOD_NOT_FOUND, `Unknown method: ${req.method}`);
      }
      const result = await handler(req.params ?? {});
      response = { id: req.id, result: result === undefined ? null : result };
    } catch (err) {
      const code = err instanceof RpcError ? err.code : RPC_ERROR.INTERNAL;
      const message = err instanceof Error ? err.message : String(err);
      response = { id: req.id, error: { code, message } };
    }
    this.transport.send(response);
  }
}
