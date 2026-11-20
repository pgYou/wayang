/**
 * AcpMcpHost — the per-run lifecycle of the injected Wayang MCP server: spawn
 * the stdio bridge transport, watch its handshake, degrade fail-soft, and own
 * the transport until the run closes it.
 *
 * Injection is fail-soft by design (02 §5): a failed transport start, a
 * session/new rejection carrying `mcpServers` (the run layer retries ONCE
 * with [] and calls `degrade`), or a handshake that never completes within
 * MCP_HANDSHAKE_TIMEOUT_MS all degrade to "no MCP" — after which
 * `session/update` text is the only progress source and the caller keeps the
 * idle fallback armed (`onDegraded` restarts its window).
 *
 * The transport FACTORY stays a run-layer seam (`spawnTransport` below) so
 * provider classes and tests keep overriding one method instead of the whole
 * host; the tool semantics (`update_progress` / `ask_controller` invoker)
 * live in mcp-tools.ts, not here.
 */

import type { Logger } from '@/infra/logger';
import type { AcpMcpServer } from '@/services/acp/types';
import { AcpError } from '@/services/acp/errors';
import { MCP_HANDSHAKE_TIMEOUT_MS, type McpTransport, type StartMcpTransportOptions } from './mcp-transport';
import { createWayangMcpToolInvoker } from './mcp-tools';
import pkg from '@/../package.json';

export interface AcpMcpHostDeps {
  workerId: string;
  provider: string;
  sessionDir: string;
  logger: Logger;
  /** Whether injection is enabled (config `mcp.enabled`, default true). */
  enabled: () => boolean;
  /** Run-layer transport factory (protected hook — tests override it). */
  spawnTransport: (opts: StartMcpTransportOptions) => Promise<McpTransport>;
  /** `update_progress` tool → the progress choke point. */
  onProgress: (message: string) => void;
  /** `ask_controller` tool implementation (the run layer's mcpAsk). */
  ask: (question: string, context?: string) => Promise<string>;
  /** Merge keys into runtimeState.acp (mcpAvailable evidence). */
  recordRuntime: (fields: Record<string, unknown>) => void;
  /** Degraded → restart the fallback idle window (session/update is the net). */
  onDegraded: () => void;
}

export class AcpMcpHost {
  private readonly deps: AcpMcpHostDeps;
  private transport: McpTransport | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private available = false;
  private warned = false;
  /** Set by close(): a watchdog already on the timer queue must stay inert. */
  private stopped = false;

  constructor(deps: AcpMcpHostDeps) {
    this.deps = deps;
  }

  /** Whether the injected server is live this run (false once degraded). */
  get mcpAvailable(): boolean { return this.available; }

  /**
   * Spawn the bridge transport (unless disabled) and return the mcpServers
   * descriptor for session/new. A failed start degrades immediately and
   * returns [] — session/new must still happen.
   */
  async prepare(): Promise<AcpMcpServer[]> {
    if (!this.deps.enabled()) return [];
    const invoker = createWayangMcpToolInvoker({
      workerId: this.deps.workerId,
      logger: this.deps.logger,
      onProgress: (message) => this.deps.onProgress(message),
      ask: (question, context) => this.deps.ask(question, context),
    });
    try {
      const transport = await this.deps.spawnTransport({
        sessionDir: this.deps.sessionDir,
        workerId: this.deps.workerId,
        invoker,
        logger: this.deps.logger,
        serverInfo: { name: 'wayang', version: pkg.version },
      });
      this.transport = transport;
      this.available = true;
      this.armHandshakeWatchdog(transport);
      this.deps.recordRuntime({ mcpAvailable: true });
      this.deps.logger.debug({ workerId: this.deps.workerId, reason: 'mcp-injected' }, 'ACP MCP server injected');
      return [transport.descriptor];
    } catch (err) {
      this.warnDegraded('transport-start-failed', err);
      return [];
    }
  }

  /**
   * Disable MCP, stop the watchdog and shut the transport (and thus the
   * bridge) down. The idle fallback stays armed: after degradation
   * session/update text is the only progress source.
   */
  async degrade(reason: string, err?: unknown): Promise<void> {
    if (this.stopped) return;
    if (this.available) {
      this.available = false;
      this.deps.onDegraded();
      this.deps.recordRuntime({ mcpAvailable: false });
    }
    await this.close();
    this.warnDegraded(reason, err);
  }

  /** Close the transport (idempotent) and stop the handshake watchdog. */
  async close(): Promise<void> {
    this.stopped = true;
    this.stopWatchdog();
    const transport = this.transport;
    this.transport = null;
    if (!transport) return;
    try {
      await transport.close();
    } catch (err) {
      this.deps.logger.debug({ workerId: this.deps.workerId, err, reason: 'mcp-transport-close' }, 'ACP MCP transport close failed');
    }
  }

  /** Stop the handshake watchdog (run finally / abort path). */
  stopWatchdog(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  /** A session/new that succeeded with injection but no hello within 10s degrades. */
  private armHandshakeWatchdog(transport: McpTransport): void {
    this.stopWatchdog();
    const timer = setTimeout(() => {
      this.handshakeTimer = null;
      if (this.stopped || !this.available || transport.isReady()) return;
      void this.degrade('handshake-timeout');
    }, MCP_HANDSHAKE_TIMEOUT_MS);
    timer.unref?.();
    this.handshakeTimer = timer;
  }

  /** Metadata-only warning: no token, path, question, answer or reply text. */
  private warnDegraded(reason: string, err?: unknown): void {
    if (this.warned) return;
    this.warned = true;
    const rpcCode = err instanceof AcpError ? err.detail?.rpc?.code : undefined;
    this.deps.logger.warn(
      { provider: this.deps.provider, workerId: this.deps.workerId, reason, ...(rpcCode !== undefined && { rpcCode }), mcpAvailable: false },
      'ACP MCP injection degraded — session/update progress is the fallback',
    );
  }
}
