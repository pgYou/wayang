/**
 * ServerProcessHost — the utility-process lifecycle state machine with
 * self-healing (desktop-app-design §2.9, 4.2 域二工作项④).
 *
 * Absorbs the boot loop that used to live in connection.ts and upgrades the
 * domain-one one-shot crash resume into the full state machine:
 *
 *   starting → ready → degraded → restarting → fatal   (+ stopped on quit)
 *
 * - an unexpected exit of a READY server (exit while not stopping/switching)
 *   enters `degraded` (renderer sees `reconnecting`), waits an exponentially
 *   growing backoff, then `restarting` re-forks with `resume:<sessionId>`;
 *   a successful ready resets the attempt counter — consecutive failures up
 *   to `maxAttempts` land on `fatal` (renderer sees `crashed`, with the
 *   stderr tail as diagnostics);
 * - a crash before any ready, or an id-less ready, goes straight to `fatal`
 *   (no session to resume, no blind retries);
 * - the normal exit protocol is unchanged (SHUTDOWN RPC → 5s grace → kill)
 *   and the quit race is defused by the `stopping` flag swallowing exit
 *   events (never a reconnect during before-quit);
 * - the switch path (`switchSession`) gracefully stops the current server
 *   (its session state is preserved and still resumable), then boots with
 *   the given session argument (`new` or `resume:<target>`). A switch is a
 *   user action: it is neither degraded nor fatal and never counts against
 *   the self-heal backoff.
 *
 * Status events keep the legacy vocabulary (connecting / reconnecting /
 * ready / crashed) so the renderer contract is unchanged; the host phases
 * are visible through `phase` for the main-side layers.
 */

import { utilityProcess, type UtilityProcess } from 'electron';
import { join } from 'node:path';
import type { WayangConfig } from '@wayang-ai/protocol';
import { messagePortToStreams, type MessagePortLike } from '@wayang-ai/protocol/rpc/message-port';
import { createStreamTransport } from '@wayang-ai/protocol/rpc/transport';
import { RpcClient, RemoteStateStore } from '@wayang-ai/protocol/rpc/rpc-client';
import { METHOD, NOTIFY } from '@wayang-ai/protocol/rpc/protocol';
import { RemoteSupervisor } from '@wayang-ai/core/client/remote-supervisor';
import { CONFIG_OBJECT_ENV } from '../shared/config-env';
import { STATE_SLICE_PATHS, sliceKey, type StateUpdate } from '../shared/ipc-contract';
import type { MainLogger } from './logger';
import { createLineSplitter } from './log-lines';

const READY_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 5_000;

/** Host lifecycle phases (§2.9); `stopped` is the clean-quit terminal. */
export type HostPhase = 'starting' | 'ready' | 'degraded' | 'restarting' | 'fatal' | 'stopped';

/**
 * Exponential backoff policy for self-healing (§2.9). Defaults are the
 * "reasonable default" the doc allows: 1s → 2s → 4s → … capped at 30s, five
 * consecutive failed attempts before `fatal`. Injectable so tests (and only
 * tests) run tight cycles.
 */
export interface BackoffPolicy {
  /** Delay before the first restart attempt. */
  initialDelayMs: number;
  /** Multiplier between consecutive attempts (2 = exponential). */
  multiplier: number;
  /** Upper bound for a single delay. */
  maxDelayMs: number;
  /** Consecutive failed attempts before `fatal`. */
  maxAttempts: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
  initialDelayMs: 1_000,
  multiplier: 2,
  maxDelayMs: 30_000,
  maxAttempts: 5,
};

/** Host options — the storage/workspace injection values plus boot args (§2.5). */
export interface HostSessionOptions {
  /** Envelope config file (`<userData>/config.json`) — the `--config` argv fallback surface. */
  configPath: string;
  /** storagePaths.dataDir (= userData): sessions live under `<dataDir>/sessions`. */
  dataDir: string;
  /** storagePaths.logDir: the session log lands in the app logs dir (§2.5). */
  logDir: string;
  /** storagePaths.cacheDir: MCP sockets and runtime temp (§2.5). */
  cacheDir: string;
  /** workspacePolicy.controllerWorkspace — also mirrors the legacy --workspace-dir. */
  workspaceDir: string;
  /** workspacePolicy.defaultWorkerWorkspace — the user-visible worker workspace. */
  defaultWorkerWorkspace: string;
  session: string;
  logLevel: string;
}

export interface ServerProcessHostDeps {
  options: HostSessionOptions;
  /** Validated wayang config (loaded by SessionService, 决策九 envelope store). */
  config: WayangConfig;
  /** Connection status machine events (legacy vocabulary, §2.9). */
  onStatus: (phase: 'connecting' | 'reconnecting' | 'ready' | 'crashed', detail?: string, sessionId?: string) => void;
  /** State event forwarding to the renderer (`wayang:state` payload). */
  sendState: (payload: StateUpdate) => void;
  log: MainLogger;
  /** Self-heal policy; defaults to DEFAULT_BACKOFF. */
  backoff?: BackoffPolicy;
}

/**
 * One live server attachment: the forked utility child plus the client stack
 * wired to it (rpc, state store, supervisor) and its exit signal. Rebuilt
 * from scratch on every (re)boot — a resume is a full re-fork, never a
 * half-repaired connection.
 */
interface ServerWiring {
  child: UtilityProcess;
  rpc: RpcClient;
  store: RemoteStateStore;
  exited: Promise<number | null>;
  ready: { sessionId?: string; sessionDir?: string };
  supervisor: RemoteSupervisor;
  /** Latest stderr tail (crash/timeout diagnostics). */
  stderrTail: () => string;
}

/**
 * Electron's message direction is asymmetric: parent→child delivers
 * MessageEvent-shaped events, but child→parent (UtilityProcess 'message')
 * delivers the payload directly. The port adapter speaks the MessageEvent
 * shape, so translate here — protocol stays shape-agnostic.
 */
function asMessagePort(child: UtilityProcess): MessagePortLike {
  const shims = new Map<(event: { data: unknown }) => void, (message: unknown) => void>();
  return {
    postMessage: (data) => child.postMessage(data),
    addListener: (event, listener) => {
      const shim = (message: unknown): void => listener({ data: message });
      shims.set(listener, shim);
      child.addListener(event, shim);
    },
    removeListener: (event, listener) => {
      const shim = shims.get(listener);
      if (shim) {
        child.removeListener(event, shim);
        shims.delete(listener);
      }
    },
  };
}

export class ServerProcessHost {
  private readonly options: HostSessionOptions;
  private readonly config: WayangConfig;
  private readonly onStatus: ServerProcessHostDeps['onStatus'];
  private readonly sendState: ServerProcessHostDeps['sendState'];
  private readonly log: MainLogger;
  private readonly backoff: BackoffPolicy;

  private hostLog: MainLogger;
  private serverLog: MainLogger;

  /** Clean-quit flag: exits caused by (or landing during) stop/switch are swallowed. */
  private stopping = false;
  /** User-initiated session switch in progress (not a crash, no backoff). */
  private switching = false;
  /** Consecutive failed self-heal attempts; reset by a successful ready. */
  private attempts = 0;
  private readySessionId: string | undefined;
  private wiring: ServerWiring | null = null;
  private phase: HostPhase = 'starting';

  constructor(deps: ServerProcessHostDeps) {
    this.options = deps.options;
    this.config = deps.config;
    this.onStatus = deps.onStatus;
    this.sendState = deps.sendState;
    this.log = deps.log;
    this.backoff = deps.backoff ?? DEFAULT_BACKOFF;
    this.hostLog = deps.log.child('host');
    this.serverLog = deps.log.child('server');
  }

  /** Current lifecycle phase (§2.9 state machine, main-side visibility). */
  get currentPhase(): HostPhase {
    return this.phase;
  }

  /** Session id of the live (or last) ready server, when known. */
  get currentSessionId(): string | undefined {
    return this.readySessionId;
  }

  /** Live client stack; undefined unless a boot reached ready. */
  get supervisor(): RemoteSupervisor | undefined {
    return this.phase === 'ready' ? (this.wiring?.supervisor) : undefined;
  }

  /** Live RPC client (respondPermission forward); undefined unless ready. */
  get rpc(): RpcClient | undefined {
    return this.phase === 'ready' ? (this.wiring?.rpc) : undefined;
  }

  /** True while a user-initiated session switch is in flight. */
  get isSwitching(): boolean {
    return this.switching;
  }

  /**
   * Initial boot. Emits no `connecting` status — the caller (SessionService)
   * owns that emission because config loading precedes the host. Resolves
   * once ready; rejects (after settling on `fatal` + `crashed`) when the
   * first boot dies before ready.
   */
  async start(): Promise<void> {
    this.setPhase('starting');
    this.hostLog.info('connecting', { ...this.options, session: this.options.session });
    try {
      await this.boot(this.options.session, false);
    } catch (err) {
      // Pre-ready crash / timeout: fatal, no blind retries (§2.9).
      const message = err instanceof Error ? err.message : String(err);
      this.enterFatal(message);
      throw err;
    }
  }

  /**
   * Session switch (§2.9 switch path): gracefully stop the current server
   * (its session state is preserved and remains resumable), then boot with
   * `sessionArg` (`new` for a fresh session, `resume:<id>` for a target).
   * A user action — never degraded/fatal semantics, never counted against
   * the self-heal backoff. Resolves once the new session is ready.
   */
  async switchSession(sessionArg: string): Promise<void> {
    if (this.stopping) throw new Error('host is stopping');
    if (this.switching) throw new Error('a session switch is already in progress');
    if (this.phase === 'fatal' || this.phase === 'stopped') {
      throw new Error(`cannot switch sessions from phase ${this.phase}`);
    }
    this.switching = true;
    this.hostLog.info('switching session', { sessionArg });
    try {
      // The victim's exit is owned by the graceful stop (swallowed above), so
      // the current session's state is left intact on disk.
      const victim = this.wiring;
      if (victim) await this.gracefulStop(victim);
      if (this.stopping) return;
      this.setPhase('starting');
      this.onStatus('connecting', `switching session (${sessionArg})`);
      await this.boot(sessionArg, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failure = new Error(`session switch to ${sessionArg} failed: ${message}`);
      this.enterFatal(failure.message);
      throw failure;
    } finally {
      this.switching = false;
    }
  }

  /** Full snapshot sweep over the subscribed slices (§2.7 getInitialState). */
  async getSnapshotSlices(): Promise<Record<string, unknown>> {
    const wiring = this.wiring;
    if (this.phase !== 'ready' || !wiring) {
      throw new Error(`no live server for a snapshot (phase: ${this.phase})`);
    }
    const entries = await Promise.all(
      STATE_SLICE_PATHS.map(async ([target, path]) => {
        const res = await wiring.rpc.request<{ data: unknown }>(METHOD.GET_SNAPSHOT, { target, path });
        return [sliceKey(target, path), res.data] as const;
      }),
    );
    return Object.fromEntries(entries);
  }

  /**
   * Full resend of the main-side cache (§2.7 refresh replay): every slice the
   * RemoteStateStore has a value for is pushed once more through the state
   * channel. Used on `did-finish-load` so a refreshed window has content
   * immediately.
   */
  resendSnapshot(): void {
    const wiring = this.wiring;
    if (!wiring) return;
    for (const [target, path] of STATE_SLICE_PATHS) {
      const data = wiring.store.getSnapshot(target, path);
      if (data !== undefined) {
        this.sendState({ target, path, data });
      }
    }
  }

  /**
   * Clean shutdown: idempotent quit flag first (before-quit can re-enter and
   * an in-flight restart boot checks the same flag), then the graceful exit
   * protocol against the live child.
   */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.hostLog.info('stopping server');
    const victim = this.wiring;
    if (victim) await this.gracefulStop(victim);
    this.setPhase('stopped');
  }

  /* ------------------------- internals ------------------------- */

  private setPhase(phase: HostPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.hostLog.debug(`phase → ${phase}`);
  }

  private enterFatal(detail: string): void {
    this.setPhase('fatal');
    this.hostLog.error('server host fatal', { detail: detail.slice(0, 2000) });
    this.onStatus('crashed', detail);
  }

  private async boot(sessionArg: string, replay: boolean): Promise<ServerWiring> {
    const child = utilityProcess.fork(join(__dirname, 'utility-entry.js'), [
      '--config', this.options.configPath,
      '--data-dir', this.options.dataDir,
      '--workspace-dir', this.options.workspaceDir,
      // Explicit injection surface (§2.5): the utility entry turns these into
      // StoragePaths / WorkspacePolicy for serverMain; the legacy pair above
      // mirrors contract members so there is no second semantic source.
      '--log-dir', this.options.logDir,
      '--cache-dir', this.options.cacheDir,
      '--default-worker-workspace', this.options.defaultWorkerWorkspace,
      '--session', sessionArg,
      '--log-level', this.options.logLevel,
    ], {
      stdio: 'pipe',
      serviceName: 'wayang-server',
      env: { ...process.env, [CONFIG_OBJECT_ENV]: JSON.stringify(this.config) },
    });

    // The wayang server logs to its log dir, so its stdio carries only fatal
    // output — echo to the console and persist to main.log. The tail feeds
    // crash/timeout diagnostics.
    let stderrTail = '';
    const stderrLines = createLineSplitter((line) => this.serverLog.error(line));
    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', (chunk: string) => {
      process.stderr.write(`[server] ${chunk}`);
      stderrTail = (stderrTail + chunk).slice(-4000);
      stderrLines(chunk);
    });
    const stdoutLines = createLineSplitter((line) => this.serverLog.debug(line));
    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => {
      process.stdout.write(`[server] ${chunk}`);
      stdoutLines(chunk);
    });

    // The UtilityProcess object is structurally a message port for our framing,
    // modulo Electron's event-shape asymmetry (see asMessagePort).
    const io = messagePortToStreams(asMessagePort(child));
    const rpc = new RpcClient(createStreamTransport(io.stdin, io.stdout));

    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => resolve(code));
    });

    // Register before awaiting ready so a quit racing the boot can still
    // reach (and stop) the freshly forked child.
    const wiring: ServerWiring = {
      child,
      rpc,
      store: undefined as unknown as RemoteStateStore,
      exited,
      ready: {},
      supervisor: undefined as unknown as RemoteSupervisor,
      stderrTail: () => stderrTail,
    };
    this.wiring = wiring;

    // A boot death before ready is owned by the boot promise (it rejects);
    // the exit listener only self-heals exits of servers that HAD reached
    // ready, and never the ones owned by stop/switch.
    let reachedReady = false;
    void exited.then((code) => {
      if (this.stopping || this.switching) return;
      if (!reachedReady) return;
      this.onUnexpectedExit(wiring, code);
    });

    const ready = await this.waitForReady(rpc, exited, wiring.stderrTail, child, this.options.logDir);
    reachedReady = true;
    wiring.ready = ready;
    this.readySessionId = ready.sessionId;
    this.attempts = 0;

    this.hostLog.info('server ready', {
      sessionId: ready.sessionId,
      sessionDir: ready.sessionDir,
      serverLog: join(ready.sessionDir ?? '', 'wayang.log'),
    });
    // The renderer status bar waits for this to show 已连接 — without it the
    // connection stays "connecting" forever even though the server is up.
    this.setPhase('ready');
    this.onStatus('ready', undefined, ready.sessionId);

    const store = new RemoteStateStore(rpc);
    wiring.store = store;
    const supervisor = new RemoteSupervisor(rpc, store, this.options.workspaceDir, {
      stop: () => this.gracefulStop(wiring),
    });
    wiring.supervisor = supervisor;

    for (const [target, path] of STATE_SLICE_PATHS) {
      store.subscribe(target, path, (event) => {
        this.sendState({ target, path, data: (event as { data?: unknown }).data });
      });
    }

    // Snapshot replay after a resume/switch boot (§2.7 replay, one source):
    // the SUBSCRIBE handshake already carries each path's current value, but
    // a server-side null fires no event — a GET_SNAPSHOT sweep pushes every
    // slice once more through the same wayang:state channel so the renderer
    // converges on the resumed session's state.
    if (replay) {
      for (const [target, path] of STATE_SLICE_PATHS) {
        void rpc.request<{ data: unknown }>(METHOD.GET_SNAPSHOT, { target, path })
          .then((res) => this.sendState({ target, path, data: res.data }))
          .catch(() => { /* server gone: the exit path takes over */ });
      }
    }

    return wiring;
  }

  private onUnexpectedExit(wiring: ServerWiring, code: number | null): void {
    const tail = wiring.stderrTail();
    // Crash before any ready (or an id-less ready): no session to resume, no
    // blind retries — straight to fatal (§2.9).
    if (this.readySessionId === undefined) {
      this.enterFatal(`server exited without a usable session (code ${code})\n${tail}`);
      return;
    }
    void this.selfHeal(code, tail);
  }

  /**
   * The self-heal cycle: degrade → backoff → restart fork, repeated until a
   * ready resets the counter or `maxAttempts` consecutive failures land on
   * fatal. Each cycle emits exactly one `reconnecting` status.
   */
  private async selfHeal(code: number | null, tail: string): Promise<void> {
    const sessionId = this.readySessionId as string;
    let lastFailure = '';
    for (;;) {
      if (this.stopping || this.switching) return;
      if (this.attempts >= this.backoff.maxAttempts) {
        this.enterFatal(
          `server exited again after ${this.attempts} restart attempts (code ${code})` +
          (lastFailure ? `; last failure: ${lastFailure}` : '') + `\n${tail}`,
        );
        return;
      }
      this.attempts += 1;
      const attempt = this.attempts;
      this.setPhase('degraded');
      this.hostLog.warn('server exited unexpectedly — resuming session', { code, sessionId, attempt });
      this.onStatus(
        'reconnecting',
        `server exited (code ${code}) — resuming session ${sessionId} (attempt ${attempt}/${this.backoff.maxAttempts})`,
      );
      this.wiring?.rpc.close();

      await this.delay(this.backoffDelayMs(attempt));
      if (this.stopping || this.switching) return;
      this.setPhase('restarting');
      try {
        await this.boot(`resume:${sessionId}`, true);
        return; // ready: the counter was reset inside boot.
      } catch (err) {
        if (this.stopping || this.switching) return;
        const message = err instanceof Error ? err.message : String(err);
        lastFailure = message;
        this.hostLog.warn('restart attempt failed', { attempt, error: message });
        // Loop: the next iteration checks the attempt budget.
      }
    }
  }

  /** Backoff delay for the n-th attempt: initial · multiplier^(n-1), capped. */
  private backoffDelayMs(attempt: number): number {
    const raw = this.backoff.initialDelayMs * Math.pow(this.backoff.multiplier, attempt - 1);
    return Math.min(raw, this.backoff.maxDelayMs);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async gracefulStop(wiring: ServerWiring): Promise<void> {
    try {
      await Promise.race([
        wiring.rpc.request(METHOD.SHUTDOWN),
        new Promise((_r, reject) => setTimeout(() => reject(new Error('shutdown timeout')), SHUTDOWN_GRACE_MS)),
      ]);
    } catch {
      /* fall through to exit wait / kill */
    }
    await Promise.race([
      wiring.exited,
      new Promise<number | null>((resolve) => {
        setTimeout(() => {
          wiring.child.kill();
          resolve(null);
        }, SHUTDOWN_GRACE_MS);
      }),
    ]);
    wiring.rpc.close();
  }

  private waitForReady(
    rpc: RpcClient,
    exited: Promise<number | null>,
    stderrTail: () => string,
    child: UtilityProcess,
    logDir: string,
  ): Promise<{ sessionId?: string; sessionDir?: string }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let readyInfo: { sessionId?: string; sessionDir?: string } = {};
      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(readyInfo);
      };
      const timer = setTimeout(() => {
        child.kill();
        // The injected logDir (§2.5) is where the server's session log lands
        // — point whoever reads this at both evidence sources (stderr tail +
        // the log file).
        finish(new Error(
          `server did not become ready within ${READY_TIMEOUT_MS}ms.\n${stderrTail()}` +
          `\nServer-side logs (if it booted): ${join(logDir, 'wayang.log')}`,
        ));
      }, READY_TIMEOUT_MS);
      rpc.on(NOTIFY.READY, (params) => {
        readyInfo = {
          sessionId: typeof params.sessionId === 'string' ? params.sessionId : undefined,
          sessionDir: typeof params.sessionDir === 'string' ? params.sessionDir : undefined,
        };
        finish();
      });
      void exited.then((code) => {
        setImmediate(() => finish(new Error(`server exited before becoming ready (code ${code}).\n${stderrTail()}`)));
      });
    });
  }
}
