/**
 * TOOL LAYER — the semantics of `update_progress` and `ask_controller`.
 *
 * This module knows NOTHING about how a request arrives: no Unix socket, no
 * bridge process, no token, no spawn descriptor, no ACP version. The
 * transport hands it (name, arguments) and gets back a tool result. That is
 * what makes swapping the stdio bridge for ACP v2's `McpServerAcp` tunnel
 * (MCP over `mcp/message`) a transport-only change: this file, the tool
 * registry in mcp-schemas.ts and the fallback timer stay untouched.
 */

import type { Logger } from '@/infra/logger';
import {
  MAX_CONTEXT_CHARS,
  MAX_QUESTION_CHARS,
  MCP_ASK_TIMEOUT_MS,
  MCP_PROGRESS_TIMEOUT_MS,
  capText,
} from './mcp-schemas';
import type { McpCallResult } from './mcp-protocol';

export interface McpToolInvoker {
  invoke(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
  /** Transport close: settle in-flight calls so nothing hangs on the agent. */
  settlePending(): void;
}

export interface WayangMcpToolDeps {
  workerId: string;
  logger: Logger;
  onProgress: (message: string) => void | Promise<void>;
  ask: (question: string, context?: string) => Promise<string>;
  progressTimeoutMs?: number;
  askTimeoutMs?: number;
}

const TIMED_OUT = Symbol('wayang-mcp-tool-timeout');
const ABORTED = Symbol('wayang-mcp-tool-aborted');

/** Pending calls are settled by `settlePending()` when the transport closes. */
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

export function createWayangMcpToolInvoker(deps: WayangMcpToolDeps): McpToolInvoker {
  const pending = new Set<() => void>();

  const invoke = async (name: string, args: Record<string, unknown>): Promise<McpCallResult> => {
    const started = Date.now();
    if (name === 'update_progress') {
      if (typeof args.message !== 'string' || args.message.length === 0) {
        return { text: '[MCP ERROR] update_progress requires a non-empty string "message"', isError: true };
      }
      const message = capText(args.message);
      const settled = await withTimeout(
        Promise.resolve().then(() => deps.onProgress(message)),
        deps.progressTimeoutMs ?? MCP_PROGRESS_TIMEOUT_MS,
        pending,
      );
      if (settled === ABORTED) return { text: '[ABORTED] Worker is shutting down.', isError: true };
      if (settled === TIMED_OUT) {
        return { text: '[TIMEOUT] The progress report was not delivered within 5s.', isError: true };
      }
      deps.logger.debug(
        { workerId: deps.workerId, toolName: name, charLen: message.length, durationMs: Date.now() - started, mcpAvailable: true, reason: 'progress' },
        'ACP MCP tool served',
      );
      return { text: `Progress reported: ${message}` };
    }
    if (name === 'ask_controller') {
      const question = capText(typeof args.question === 'string' ? args.question : '', MAX_QUESTION_CHARS);
      if (!question) return { text: '[MCP ERROR] ask_controller requires a non-empty string "question"', isError: true };
      const context = args.context === undefined ? undefined : capText(String(args.context), MAX_CONTEXT_CHARS);
      const settled = await withTimeout(
        deps.ask(question, context),
        deps.askTimeoutMs ?? MCP_ASK_TIMEOUT_MS,
        pending,
      );
      const answer = settled === TIMED_OUT
        ? '[TIMEOUT] No answer from the controller within 5 minutes. Use your best judgment to continue.'
        : settled === ABORTED
          ? '[ABORTED] Worker is shutting down.'
          : settled;
      deps.logger.debug(
        { workerId: deps.workerId, toolName: name, charLen: answer.length, durationMs: Date.now() - started, mcpAvailable: true, reason: 'ask' },
        'ACP MCP tool served',
      );
      return { text: answer, isError: settled === TIMED_OUT || settled === ABORTED };
    }
    return { text: `Unknown tool: ${name}`, isError: true };
  };

  return {
    invoke,
    settlePending: () => {
      for (const cancel of [...pending]) cancel();
      pending.clear();
    },
  };
}
