/**
 * SessionService (desktop-app-design §2.9, 4.2 域二工作项②/⑤).
 *
 * Holds the session surface on the main side: config loading (the envelope
 * store, 决策九 — the host never reads config files), the ServerProcessHost
 * lifecycle, state/status forwarding to the renderer, and the typed IPC
 * registration for every contract channel (§2.2) — including the session
 * switching trio (newSession / switchSession / listSessions) and the
 * renderer log bridge sink.
 *
 * Handlers are registered once and route through the host's CURRENT live
 * stack; while the host is mid-cycle (degraded / restarting / switching)
 * invokes fail with a structured "server not ready" error instead of hitting
 * a dead transport.
 */

import type { BrowserWindow, WebContents } from 'electron';
import type { WayangConfig } from '@wayang-ai/protocol';
import { METHOD } from '@wayang-ai/protocol/rpc/protocol';
import type { RpcClient } from '@wayang-ai/protocol/rpc/rpc-client';
import type { RemoteSupervisor } from '@wayang-ai/core/client/remote-supervisor';
import { listSessions, getSession, sessionDisplayTitle, type SessionMeta } from '@wayang-ai/core/infra/session-helpers';
import {
  IPC,
  IPC_INVOKE_CHANNELS,
  IPC_SUBSCRIBE,
  type ConnectionStatus,
  type RendererLogEntry,
  type SessionIndexEntry,
  type StateUpdate,
} from '../shared/ipc-contract';
import { ConfigStore } from './config-store';
import { ServerProcessHost, type HostSessionOptions } from './server-process-host';
import { removeTypedHandler, typedHandle, type IpcRouterDeps } from './ipc/router';
import type { MainLogger } from './logger';
import type { UnifiedLogger } from './unified-logger';

export interface DesktopSessionOptions extends HostSessionOptions {
  /** Legacy CLI config (`~/.wayang.config.json`) — read-only import source (决策九). */
  legacyConfigPath: string;
}

export interface SessionServiceDeps {
  getWindow: () => BrowserWindow | null;
  options: DesktopSessionOptions;
  log: UnifiedLogger;
  /** Sender trust check (§2.2 typedHandle Sender 校验, wired from SecurityGuard). */
  isTrustedSender: (sender: WebContents) => boolean;
}

export class SessionService {
  private readonly log: MainLogger;
  private host: ServerProcessHost | null = null;
  private config: WayangConfig | null = null;

  constructor(private readonly deps: SessionServiceDeps) {
    this.log = deps.log.child('session');
  }

  /**
   * Session startup: the initial `connecting` status goes out before config
   * loading (the old connection sequence), then the config resolves, the
   * host boots and takes over status reporting. A config failure lands on
   * `crashed` here; a boot failure is reported by the host itself (§2.9).
   */
  async start(): Promise<void> {
    this.emitStatus({ phase: 'connecting' });

    let config: WayangConfig;
    try {
      config = await this.loadSessionConfig();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error('connect failed', { error: message });
      this.emitStatus({ phase: 'crashed', detail: message });
      return;
    }
    this.config = config;

    const host = new ServerProcessHost({
      options: this.hostOptions(),
      config,
      onStatus: (phase, detail, sessionId) => this.emitStatus({ phase, detail, sessionId }),
      sendState: (payload) => this.sendState(payload),
      log: this.deps.log,
    });
    this.host = host;
    this.registerIpc();
    try {
      await host.start();
    } catch (err) {
      // The host already settled on fatal and reported `crashed` (§2.9);
      // the shell just records the failure.
      const message = err instanceof Error ? err.message : String(err);
      this.log.error('server boot failed', { error: message });
    }
  }

  /** Full snapshot pull for the renderer's first paint / refresh (§2.7). */
  async getInitialState(): Promise<Record<string, unknown>> {
    const host = this.host;
    if (!host) throw new Error('session service has not started');
    return host.getSnapshotSlices();
  }

  /** Refresh replay (§2.7): re-push the main-side cache to the renderer. */
  resendSnapshot(): void {
    this.host?.resendSnapshot();
  }

  /** Session index (§4.2 工作项⑤): core's conversation index, time + summary. */
  listSessions(): SessionIndexEntry[] {
    const metas = listSessions(this.deps.options.dataDir);
    return metas.map((meta: SessionMeta) => ({
      sessionId: meta.sessionId,
      title: sessionDisplayTitle(meta),
      createdAt: meta.createdAt,
      lastActiveAt: meta.lastActiveAt,
    }));
  }

  /** New session (§2.2): graceful stop → fresh boot. */
  async newSession(): Promise<{ sessionId: string }> {
    const host = this.requireHost();
    await host.switchSession('new');
    return { sessionId: this.requireSessionId() };
  }

  /** Switch to a target session (§2.2): validated, then `resume:<id>` boot. */
  async switchSession(sessionId: string): Promise<{ sessionId: string }> {
    const host = this.requireHost();
    const found = getSession(this.deps.options.dataDir, sessionId);
    if (!found) {
      throw new Error(`unknown session ${sessionId} — nothing to switch to under ${this.deps.options.dataDir}`);
    }
    await host.switchSession(`resume:${sessionId}`);
    return { sessionId: this.requireSessionId() };
  }

  /** Renderer log bridge sink (§2.9 UnifiedLogger). */
  rendererLog(entry: RendererLogEntry): void {
    this.deps.log.renderer(entry);
  }

  /** Graceful stop; also drops the IPC surface (invokes fail fast afterwards). */
  async stop(): Promise<void> {
    this.unregisterIpc();
    await this.host?.stop();
  }

  /** The effective config (boot source of truth), once loaded. */
  get loadedConfig(): WayangConfig | null {
    return this.config;
  }

  /* ------------------------- internals ------------------------- */

  private hostOptions(): HostSessionOptions {
    const { configPath, dataDir, logDir, cacheDir, workspaceDir, defaultWorkerWorkspace, session, logLevel } = this.deps.options;
    return { configPath, dataDir, logDir, cacheDir, workspaceDir, defaultWorkerWorkspace, session, logLevel };
  }

  /**
   * Host-side config load (design 2.4 / 决策九): read the desktop envelope
   * store at `options.configPath` (`<userData>/config.json`). The store
   * validates the embedded `wayangConfig` with protocol's `validateConfig`.
   * A missing envelope triggers the store's transitional one-time import
   * from the CLI config (read-only, marked for removal once the explicit
   * import action lands); beyond that import the desktop never touches CLI
   * files at runtime.
   */
  private async loadSessionConfig(): Promise<WayangConfig> {
    const store = new ConfigStore(this.deps.options.configPath);
    return store.loadOrImport(this.deps.options.legacyConfigPath);
  }

  private emitStatus(status: ConnectionStatus): void {
    if (status.phase === 'crashed') {
      this.log.error('connection crashed', { detail: status.detail?.slice(0, 2000) });
    } else {
      this.log.info(`connection ${status.phase}`, status.sessionId !== undefined ? { sessionId: status.sessionId } : undefined);
    }
    this.deps.getWindow()?.webContents.send(IPC_SUBSCRIBE.status, status);
  }

  private sendState(payload: StateUpdate): void {
    this.deps.getWindow()?.webContents.send(IPC_SUBSCRIBE.state, payload);
  }

  private registerIpc(): void {
    const router: IpcRouterDeps = { isTrustedSender: this.deps.isTrustedSender };

    typedHandle(IPC.sendInput, router, ([text]) => {
      this.requireSupervisor().signalQueue.enqueue({ source: 'user', type: 'input', payload: { text } });
    });
    typedHandle(IPC.abort, router, () => {
      this.requireSupervisor().controllerAgent.abort();
    });
    typedHandle(IPC.answerInquiry, router, ([answer]) => {
      this.requireSupervisor().resolveInquiry(answer);
    });
    typedHandle(IPC.respondPermission, router, ([request]) => {
      // Declared-but-unwired UI-wise (§2.2): the forward exists, the worker
      // level permission card is future work.
      return this.requireRpc().request(METHOD.RESPOND_PERMISSION, request);
    });
    typedHandle(IPC.listTasks, router, ([status]) => this.requireSupervisor().engine.list(status));
    typedHandle(IPC.cancelTask, router, ([taskId]) => this.requireSupervisor().engine.cancel(taskId));
    typedHandle(IPC.contextUsage, router, () => this.requireSupervisor().getContextUsage());
    typedHandle(IPC.getInitialState, router, () => this.getInitialState());
    typedHandle(IPC.newSession, router, () => this.newSession());
    typedHandle(IPC.switchSession, router, ([sessionId]) => this.switchSession(sessionId));
    typedHandle(IPC.listSessions, router, () => this.listSessions());
    typedHandle(IPC.rendererLog, router, ([entry]) => {
      this.rendererLog(entry);
    });
  }

  private unregisterIpc(): void {
    for (const channel of IPC_INVOKE_CHANNELS) {
      removeTypedHandler(channel);
    }
  }

  private requireHost(): ServerProcessHost {
    if (!this.host) throw new Error('server not ready (no session host)');
    return this.host;
  }

  private requireSupervisor(): RemoteSupervisor {
    const host = this.requireHost();
    const supervisor = host.supervisor;
    if (!supervisor) {
      throw new Error(`server not ready (phase: ${host.currentPhase})`);
    }
    return supervisor;
  }

  private requireRpc(): RpcClient {
    const host = this.requireHost();
    const rpc = host.rpc;
    if (!rpc) {
      throw new Error(`server not ready (phase: ${host.currentPhase})`);
    }
    return rpc;
  }

  private requireSessionId(): string {
    const sessionId = this.host?.currentSessionId;
    if (!sessionId) throw new Error('no live session id after boot');
    return sessionId;
  }
}
