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

import { dialog, type BrowserWindow, type WebContents } from 'electron';
import type { WayangConfig } from '@wayang-ai/protocol';
import { parseConfigUpdateRequest, type ConfigUpdateResult } from '@wayang-ai/protocol';
import { METHOD } from '@wayang-ai/protocol/rpc/protocol';
import type { RpcClient } from '@wayang-ai/protocol/rpc/rpc-client';
import type { RemoteSupervisor } from '@wayang-ai/core/client/remote-supervisor';
import { listSessions, getSession, sessionDisplayTitle, type SessionMeta } from '@wayang-ai/core/infra/session-helpers';
import {
  IPC,
  IPC_INVOKE_CHANNELS,
  IPC_SUBSCRIBE,
  type ChooseDirectoryResult,
  type ConnectionStatus,
  type InitialStateSnapshot,
  type OnboardState,
  type ReadConfigResult,
  type RendererLogEntry,
  type SaveConfigResult,
  type SessionIndexEntry,
  type StateUpdate,
} from '../shared/ipc-contract';
import { checkCoreCompleteness, resolveOnboardState } from '../shared/onboard';
import { planConfigUpdates } from '../shared/config-update-plan';
import { assertCanonicalConfig, makeEnvelope, validateOrReject, type ConfigEnvelope } from '../shared/config-envelope';
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
  /**
   * Custom-header window controls (§2.1): the WindowManager face behind
   * `wayang:windowControl` — registered here so every contract channel keeps
   * its single registration point (and the bulk teardown symmetry).
   */
  windowControls: {
    minimize(): void;
    toggleZoom(): void;
    close(): void;
  };
}

export class SessionService {
  private readonly log: MainLogger;
  private host: ServerProcessHost | null = null;
  private config: WayangConfig | null = null;
  /** The persisted desktop prefs (envelope `desktop` section). */
  private desktopPrefs: Record<string, unknown> = {};
  /** Last emitted connection status — the snapshot's status source (§2.7). */
  private lastStatus: ConnectionStatus = { phase: 'connecting' };

  constructor(private readonly deps: SessionServiceDeps) {
    this.log = deps.log.child('session');
  }

  /**
   * Session startup. `config` comes from the envelope the Application layer
   * loaded (决策九): null = onboard mode — no server, the IPC surface stays
   * registered so the welcome page can import/create a config and boot via
   * `saveConfig`. With a config the host boots and takes over status
   * reporting (§2.9).
   */
  async start(config: WayangConfig | null): Promise<void> {
    this.emitStatus({ phase: 'connecting' });

    if (config === null) {
      this.log.info('onboard mode: no server until the welcome page saves a config');
      this.registerIpc();
      return;
    }
    this.config = config;
    this.createHost(this.hostOptions(), config);
    this.registerIpc();
    try {
      await this.host?.start();
    } catch (err) {
      // The host already settled on fatal and reported `crashed` (§2.9);
      // the shell just records the failure.
      const message = err instanceof Error ? err.message : String(err);
      this.log.error('server boot failed', { error: message });
    }
  }

  /** Full snapshot pull for the renderer's first paint / refresh (§2.7). */
  async getInitialState(): Promise<InitialStateSnapshot> {
    const host = this.host;
    if (!host) throw new Error('session service has not started');
    const slices = await host.getSnapshotSlices();
    return { status: this.lastStatus, slices };
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

  /** Build and attach a host (first boot, post-save boot, restart). */
  private createHost(options: HostSessionOptions, config: WayangConfig): ServerProcessHost {
    const host = new ServerProcessHost({
      options,
      config,
      onStatus: (phase, detail, sessionId) => this.emitStatus({ phase, detail, sessionId }),
      sendState: (payload) => this.sendState(payload),
      log: this.deps.log,
    });
    this.host = host;
    this.config = config;
    return host;
  }

  private configStore(): ConfigStore {
    return new ConfigStore(this.deps.options.configPath);
  }

  /**
   * §2.11 welcome-page state: re-read the envelope so the answer reflects
   * the CURRENT disk state (the save path writes before this is re-asked).
   */
  async getOnboardState(): Promise<OnboardState> {
    const store = this.configStore();
    let envelope: ConfigEnvelope | null = null;
    let loadError: string | null = null;
    try {
      envelope = await store.load();
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    }
    return resolveOnboardState(envelope, loadError);
  }

  /** §2.11「导入 CLI 配置」: read-only import + validate, error surfaces to UI. */
  async importCliConfig(): Promise<{ config: WayangConfig }> {
    const store = this.configStore();
    const config = await store.importFrom(this.deps.options.legacyConfigPath);
    return { config };
  }

  /**
   * §2.11 最终确认页 / §2.4 设置页 save — the shared write path (同源同校验):
   * validate (protocol + necessary-core) → write envelope → boot when no
   * server is live / hot-update the running one via the eight fine-grained
   * methods. Restart-only fields are reported; they take effect on the next
   * boot (`restartServer`).
   */
  async saveConfig(config: WayangConfig, desktop?: Record<string, unknown>): Promise<SaveConfigResult> {
    // 严格门槛：桌面配置只存规范格式（旧版写法已在导入入口翻译），renderer
    // 侧若还带废弃键直接报错，不做静默兼容。
    assertCanonicalConfig(config, 'config from renderer');
    validateOrReject(config, 'config from renderer');
    const coreProblem = checkCoreCompleteness(config);
    if (coreProblem) throw new Error(coreProblem);

    const prev = this.config;
    const store = this.configStore();
    // onboard 模式下 desktopPrefs 没装载过（「修改现有配置」后重新写入）：
    // 以信封里已有的桌面偏好为底，不让一次重新 onboard 把它们抹掉。
    const stored = await store.load().catch(() => null);
    const nextPrefs = { ...(stored?.desktop ?? {}), ...(this.desktopPrefs ?? {}), ...(desktop ?? {}) };
    await store.save(makeEnvelope(config, nextPrefs));
    this.desktopPrefs = nextPrefs;
    this.log.info('config envelope saved', { hotPath: prev !== null });

    const host = this.host;
    const running = host !== null && host.supervisor !== null;
    if (!running) {
      // First boot (onboard) or a dead server: boot with the new config.
      if (host && host.currentPhase !== 'fatal' && host.currentPhase !== 'stopped') {
        throw new Error(`server 正在自愈（phase: ${host.currentPhase}），请稍候再保存`);
      }
      const bootOptions = { ...this.hostOptions() };
      if (host?.currentSessionId) bootOptions.session = `resume:${host.currentSessionId}`;
      this.createHost(bootOptions, config);
      try {
        await this.host?.start();
      } catch (err) {
        // Host settled on fatal + crashed status; the save itself succeeded
        // (envelope written) — surface the boot failure to the caller.
        throw new Error(`配置已写入，但 server 启动失败：${err instanceof Error ? err.message : String(err)}`);
      }
      return { applied: [], restartRequired: [], booted: true };
    }

    // Hot path: plan the diff against the RUNNING config, pre-validate every
    // op with protocol's parser, then apply in order. The envelope is already
    // written — ops that fail reject with the server's structured error.
    const plan = planConfigUpdates(prev ?? config, config);
    for (const op of plan.ops) {
      parseConfigUpdateRequest(op.method, op.params); // throws on whitelist violations
      await this.requireRpc().request<ConfigUpdateResult>(op.method, op.params);
    }
    this.config = config;
    if (plan.ops.length > 0 || plan.restartRequired.length > 0) {
      this.log.info('config hot-updated', { applied: plan.ops.map((op) => op.method), restartRequired: plan.restartRequired });
    }
    return { applied: plan.ops.map((op) => op.method), restartRequired: plan.restartRequired, booted: false };
  }

  /** Settings-page read (§4.3 工作项②): the current envelope. */
  async readConfig(): Promise<ReadConfigResult> {
    const envelope = await this.configStore().load();
    if (!envelope) throw new Error('尚未保存任何配置（config.json 不存在）');
    this.desktopPrefs = envelope.desktop;
    return { config: envelope.wayangConfig, desktop: envelope.desktop };
  }

  /** Workspace picker (§4.3 工作项②): dialog.showOpenDialog, null on cancel. */
  async chooseDirectory(): Promise<ChooseDirectoryResult> {
    const window = this.deps.getWindow();
    const options: Electron.OpenDialogOptions = { properties: ['openDirectory'] };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    return { path: result.canceled ? null : (result.filePaths[0] ?? null) };
  }

  /**
   * Restart the server with the envelope config (§2.4 restart-needed fields
   * take effect here): graceful stop (session preserved) → re-read envelope →
   * resume the CURRENT session with the new config.
   */
  async restartServer(): Promise<{ sessionId: string }> {
    const host = this.requireHost();
    const sessionId = host.currentSessionId;
    const envelope = await this.configStore().load();
    if (!envelope) throw new Error('config.json 不存在，无法重启');
    validateOrReject(envelope.wayangConfig, 'envelope wayangConfig');
    const coreProblem = checkCoreCompleteness(envelope.wayangConfig);
    if (coreProblem) throw new Error(coreProblem);

    this.log.info('restarting server with envelope config', { sessionId });
    await host.stop();
    this.emitStatus({ phase: 'connecting', detail: 'restarting server with saved config' });
    const bootOptions = { ...this.hostOptions(), session: sessionId ? `resume:${sessionId}` : 'new' };
    const nextHost = this.createHost(bootOptions, envelope.wayangConfig);
    try {
      await nextHost.start();
    } catch (err) {
      throw new Error(`重启失败：${err instanceof Error ? err.message : String(err)}`);
    }
    return { sessionId: this.requireSessionId() };
  }

  private emitStatus(status: ConnectionStatus): void {
    this.lastStatus = status;
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
    typedHandle(IPC.getOnboardState, router, () => this.getOnboardState());
    typedHandle(IPC.importCliConfig, router, () => this.importCliConfig());
    typedHandle(IPC.saveConfig, router, ([config, desktop]) => this.saveConfig(config, desktop));
    typedHandle(IPC.readConfig, router, () => this.readConfig());
    typedHandle(IPC.chooseDirectory, router, () => this.chooseDirectory());
    typedHandle(IPC.restartServer, router, () => this.restartServer());
    typedHandle(IPC.windowControl, router, ([action]) => {
      const controls = this.deps.windowControls;
      if (action === 'minimize') controls.minimize();
      else if (action === 'toggleZoom') controls.toggleZoom();
      else controls.close();
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
