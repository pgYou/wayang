/**
 * BaseAcpWorker — the ACP-generic worker skeleton, part 1: hook types, shared
 * attribution helpers, the per-run fields and the `IWorkerInstance` surface
 * (02 booklet §2). The run()/abort() lifecycle lives in `acp-worker-run.ts`
 * (same layering as claude-code-worker/); provider classes extend that.
 *
 * The public surface matches ClaudeCodeWorker (setSignalContext /
 * permissionHandler / acceptMessage / getLiveStatus / …) so the engine treats
 * an ACP worker as just another IWorkerInstance. Providers override only the
 * five hooks — buildLaunch / mapPermission(default: shared bridge) /
 * normalizeError(default: pass-through) / isReady(default: protocol check) /
 * stopPolicy — all of which now carry a default implementation; the skeleton
 * never branches on a provider name.
 */

import type { WorkerResult } from '@/types/index';
import type { TaskDetail } from '@/types/task';
import type { WorkerConfig, ApprovalMemoryMode } from '@/types/config';
import type { WorkerLiveStatus } from '@/types/worker';
import type { Logger } from '@/infra/logger';
import type { StateEvent } from '@/infra/state/base-state';
import type { ConversationEntry, SignalTurnLineage } from '@/types/index';
import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { WorkerState } from '../worker-state';
import { type TurnEnvelope, applyTurnEnvelope } from '../utils/entry-envelope';
import { generateId } from '@/utils/id';
import { SystemContext } from '@/infra/system-context';
import { wayangDirForSessionDir } from '@/infra/session-helpers';
import { resolveWorkspaceRef } from '@/infra/workspace-registry';
import type { WorkspaceRef } from '@/infra/workspace-registry';
import type { SignalQueue } from '@/services/signal/signal-queue';
import {
  permissionStatusFromOutcome,
  type PermissionResolutionStatus,
} from '@/services/permission/permission-transport';
import type { PermissionMiddlewareResult } from '@/services/tools/permission-middleware';
import type { WorkerAccessScope } from '@/services/tools/permission-rules';
import { ApprovalMemory } from '@/services/permission/approval-memory';
import { BlockingRequestMap } from '@/infra/blocking-requests';
import type { SkillRegistry } from '@/services/skills/registry';
import { AcpError, acpUserMessage } from '@/services/acp/errors';
import { AUTH_STDERR_PATTERN } from '@/services/acp/codec';
import { type AcpTimeouts, type AcpLaunchConfig } from '@/services/acp/config';
import type { AcpCapabilities, AcpHandshake, AcpPermissionOutcome, AcpPermissionRequest } from '@/services/acp/types';
import { buildAcpCapabilities } from '@/services/acp/client';
import { createAcpToolAccumulator, type AcpToolAccumulator } from './event-mapper';
import { createAcpPermissionBridge, type AcpDenialInfo, type AcpPermissionAnswer } from './permission-bridge';
import { AcpTurnWriter } from './acp-turn-writer';
import { classifyTurnEnd, denialKey, resetTurnGuard, sanitizeTarget, turnEndErrorText, type TurnDenial, type TurnGuardState } from './turn-attribution';

// --- Hook types (frozen §2 / 02 §2) ---

/** Stop strategy: cancel grace, SIGTERM→SIGKILL gap, late-update trust (02 §2). */
export interface AcpStopPolicy {
  /** Grace after session/cancel waiting for the turn to settle; then SIGTERM. */
  cancelGraceMs: number;
  /** How long after SIGTERM before SIGKILL. */
  sigtermWaitMs: number;
  /** Whether session/updates arriving AFTER a cancel are still trusted (frozen §6.4). */
  trustUpdatesAfterCancel: boolean;
}

/** Input the isReady hook judges from. */
export interface AcpReadyContext {
  handshake: AcpHandshake;
  /** When the judgement runs: right after the handshake, or after session/new failed. */
  phase: 'handshake' | 'session-new';
  /** The original failure for phase 'session-new' (timeout / JSON-RPC error). */
  error?: unknown;
  /** transport.stderrTail() — for keyword attribution. */
  stderrTail: string[];
}

/** Result of the isReady hook (frozen §2.5: `message` is display-ready). */
export interface AcpReadiness {
  ready: boolean;
  /** 0.9.0's only post-handshake attribution need is the login state. */
  kind?: 'auth-required';
  message?: string;
}

/** 05 §3 protocol overrides as the worker layer reads them (C2 lands them in WorkerConfig). */
export interface AcpProtocolOverrides extends Partial<AcpTimeouts> {
  capabilities?: Partial<Pick<AcpCapabilities, 'permissionRequests' | 'toolCalls'>>;
  /** opencode only: inject the ask-all permission gate (default true). See `AcpProtocolConfig`. */
  gatePermissions?: boolean;
}

/** 05 §2 `*-acp` config row fields (C2 lands them in WorkerConfig). */
export interface AcpWorkerUserConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  protocol?: AcpProtocolOverrides;
  permissionMode?: 'client' | 'agent';
  /** Per-run MCP injection; enabled by default, `fallbackMs` overrides 120s. */
  mcp?: { enabled?: boolean; fallbackMs?: number };
}

/** What the buildLaunch hook receives (env already merged with process.env, frozen §2.1). */
export interface AcpWorkerEnvView {
  env: Record<string, string>;
  command?: string;
  args?: readonly string[];
  timeouts: AcpTimeouts;
  cwd: string;
}

/** Context the default mapPermission implementation needs (assembled per run). */
export interface AcpPermissionContext {
  accumulator: AcpToolAccumulator;
  scope: WorkerAccessScope;
  signalQueue: SignalQueue;
  runContext: { workerId: string; taskId: string; taskTitle: string; workerType?: string; emoji?: string };
  turnLineage?: SignalTurnLineage;
  grants: ApprovalMemory;
  approvalMemory: ApprovalMemoryMode;
  permissionMs?: number;
}

// --- Shared helpers ---

/** Locate an executable: paths are checked directly, bare names on PATH. */
export function findExecutableOnPath(command: string): string | undefined {
  const candidates = command.includes('/')
    ? [command]
    : (process.env.PATH ?? '')
        .split(':')
        .map((dir) => (dir ? join(dir, command) : ''));
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Shared session-new attribution for providers whose isReady covers the login
 * state (codebuddy measured 03 §2.2; opencode same shape, unmeasured): an
 * auth-required error from the protocol layer, or an auth keyword on stderr,
 * is attributed as auth-required; everything else stays on its original path.
 */
export function authAttributingReadiness(
  ctx: AcpReadyContext,
  opts: { provider: string; command?: string },
): AcpReadiness {
  if (ctx.phase === 'handshake') {
    return { ready: ctx.handshake.protocolVersion === 1 };
  }
  const authMethods = ctx.handshake.authMethods.map((method) => method.name).filter((name) => name.length > 0);
  const authRequired = (): AcpReadiness => ({
    ready: false,
    kind: 'auth-required',
    message: acpUserMessage('auth-required', { provider: opts.provider, command: opts.command, authMethods }),
  });
  if (ctx.error instanceof AcpError && ctx.error.code === 'auth-required') return authRequired();
  // stderr keyword short-circuit: judge on the hit, do not wait for the timeout.
  if (ctx.stderrTail.some((line) => AUTH_STDERR_PATTERN.test(line))) return authRequired();
  return { ready: true };
}

// --- The skeleton (fields, hooks, IWorkerInstance surface) ---
// `implements IWorkerInstance` lands on AcpWorkerRun (the layer that owns
// run/abort), mirroring the claude-code-worker layering.
export abstract class BaseAcpWorker {
  readonly id: string;
  protected readonly config: WorkerConfig;
  protected readonly state: WorkerState;
  readonly workspaceDir: string;
  /** Wayang session directory (provider hooks write per-run side files here, e.g. the opencode gate). */
  protected readonly sessionDir: string;
  protected readonly logger: Logger;
  protected readonly abortController = new AbortController();
  protected _terminalResult: WorkerResult | null = null;
  protected _streamEnded = false;
  /** stopReason of the in-flight/last turn has arrived (getLiveStatus). */
  protected _resultReceived = false;

  // --- Controller messaging (turn-boundary delivery) ---
  protected _messageQueue: string[] = [];
  protected _runInFlight = false;
  protected _inputClosed = false;

  // --- Permission plumbing (same shape as ClaudeCodeWorker.permissionHandler) ---
  protected readonly _pendingPermissions = new BlockingRequestMap<AcpPermissionAnswer>();
  /**
   * Structured permission refusals in the CURRENT turn (#56): the run layer
   * takes and clears this ledger at every turn end. A denial means the
   * user/policy refused or the approval timed out — not that the run aborted.
   * Kept in arrival order.
   */
  protected _turnDenials: TurnDenial[] = [];
  /** Turn-loop guard (#56): reset at run start, advanced once per finished turn. */
  protected _turnGuard: TurnGuardState = resetTurnGuard(0);
  readonly permissionHandler: PermissionMiddlewareResult = {
    resolvePermission: (
      requestId: string,
      approved: boolean,
      reason?: string,
    ): PermissionResolutionStatus => {
      if (this._pendingPermissions.resolve(requestId, { approved, reason })) return 'resolved';
      // Distinguishable terminal states for a miss (#69): duplicate answer,
      // timed-out request, or worker already gone.
      return permissionStatusFromOutcome(this._pendingPermissions.outcomeOf(requestId));
    },
    cleanup: () => {
      this._pendingPermissions.cleanupAll(() => ({ approved: false, reason: 'Worker aborted' }));
    },
    wrappedTools: {}, // not used for ACP workers
  };

  // --- Signal context, set by the engine before run() ---
  protected _signalQueue: SignalQueue | null = null;
  protected _runContext: { workerId: string; taskId: string; taskTitle: string; workerType?: string; emoji?: string } | null = null;
  protected _accessScope: WorkerAccessScope | null = null;
  protected _turnLineage: SignalTurnLineage = {};
  protected _grants: ApprovalMemory = new ApprovalMemory();
  protected _approvalMemory: ApprovalMemoryMode = 'task';
  protected _currentTurnEnv: TurnEnvelope | null = null;

  // --- Progress (update_progress is primary; the idle tracker is the net) ---
  protected _onProgress: ((msg: string) => void) | null = null;
  /** Engine-backed inquiry channel, exposed to the agent as ask_controller. */
  protected _askController: ((question: string, context?: string) => Promise<string>) | null = null;

  // --- ACP runtime (per run) ---
  protected _accumulator: AcpToolAccumulator = createAcpToolAccumulator();
  protected readonly _turnWriter: AcpTurnWriter;
  /** The run's client (spawned in run(), closed in its finally). */
  protected _client: import('@/services/acp/client').AcpClient | null = null;
  protected _sessionId: string | null = null;
  /** Set the moment a cancel goes out — gates late updates (frozen §6.4). */
  protected _cancelledAt: number | null = null;
  protected _discardedAfterCancel = 0;
  /** cancelGraceMs timer armed by abort() (frozen §6.3). */
  protected _cancelGraceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Rejects session/new on an auth-keyword stderr line (03 §2.2 short-circuit). */
  protected _sessionAuthHit: ((line: string) => void) | null = null;
  /** Ring buffer of recent stderr lines (attribution, 02 §3 step 6). */
  protected _stderrLines: string[] = [];
  protected _handshake: AcpHandshake | null = null;
  protected _launchCommand: string | undefined;
  /** Capability observation (02 §6): what this run actually saw. */
  protected _sawToolCall = false;
  protected _sawPermissionRequest = false;

  protected readonly ctx: SystemContext;
  protected readonly skills: SkillRegistry;
  private readonly workspaceRef?: WorkspaceRef;

  constructor(
    config: WorkerConfig,
    sessionDir: string,
    workspaceDir: string,
    ctx: SystemContext,
    skills: SkillRegistry,
  ) {
    this.id = generateId('aw');
    this.ctx = ctx;
    this.config = config;
    this.workspaceDir = workspaceDir;
    this.sessionDir = sessionDir;
    this.logger = ctx.logger;
    this.skills = skills;
    this.workspaceRef = resolveWorkspaceRef(wayangDirForSessionDir(sessionDir), workspaceDir);
    this.state = new WorkerState(sessionDir, this.id, ctx.logger, this.workspaceRef);
    this._turnWriter = new AcpTurnWriter(
      (entry) => this.state.append('conversation', applyTurnEnvelope(entry, this._currentTurnEnv ?? undefined)),
      ctx.sessionId,
    );
  }

  // --- Five hooks (02 §2) — all defaulted, override optional ---

  /**
   * 1) Launch: command/args (user overrides win), env merged, cwd. The
   * default is the config-driven pass-through: `workers.<id>.command` /
   * `.args` (empty when unset). No default executable exists — a missing
   * command fails fast here so the run layer surfaces an explicit error
   * instead of spawning an empty argv. Missing CLI on PATH is preflighted by
   * the skeleton. Provider subclasses keep overriding with their measured
   * default executable and fallbacks.
   */
  protected buildLaunch(view: AcpWorkerEnvView): AcpLaunchConfig {
    if (!view.command) {
      throw new AcpError('agent-error', 'workers.<id>.command is required for the generic "acp" worker type (no default executable)');
    }
    return { command: view.command, args: view.args ?? [], env: view.env, cwd: view.cwd, timeouts: view.timeouts };
  }

  /**
   * 1b) Launch cleanup: undo buildLaunch's side effects once the run's
   * client has closed (per-run files written for the child env, e.g. the
   * opencode gate file, #62). The run layer calls this in its finally;
   * providers override only when buildLaunch left something behind. Cleanup
   * must never throw — an inert leftover beats a failed teardown.
   */
  protected cleanupLaunch(): void {}

  /**
   * 2) Permission: the default implementation walks the shared bridge
   * (04 booklet); providers override only when they must not.
   */
  protected mapPermission(req: AcpPermissionRequest, acpCtx: AcpPermissionContext): Promise<AcpPermissionOutcome> {
    return createAcpPermissionBridge(
      {
        accumulator: acpCtx.accumulator,
        scope: acpCtx.scope,
        signalQueue: acpCtx.signalQueue,
        runContext: acpCtx.runContext,
        turnLineage: acpCtx.turnLineage,
        grants: acpCtx.grants,
        approvalMemory: acpCtx.approvalMemory,
        logger: this.logger,
        provider: this.config.type,
        permissionMs: acpCtx.permissionMs,
        onDenial: (info) => this.notePermissionDenial(info),
      },
      this._pendingPermissions,
    )(req);
  }

  /** Bridge callback (#56): record one structured refusal in the current turn. */
  protected notePermissionDenial(info: AcpDenialInfo): void {
    const sanitizedTarget = sanitizeTarget(info.target, { workspace: this.workspaceDir });
    const key = denialKey({ source: info.source, toolName: info.toolName, sanitizedTarget });
    this._turnDenials.push({
      source: info.source,
      toolName: info.toolName,
      reason: info.reason,
      sanitizedTarget,
      key,
      injectable: info.injectable ?? (info.source !== 'controller'),
    });
  }

  /** Take and clear the current turn's refusal ledger (#56). */
  protected takeTurnDenials(): TurnDenial[] {
    const denials = this._turnDenials;
    this._turnDenials = [];
    return denials;
  }

  /**
   * Compatibility facade (#56): the three denial wordings now come from
   * turnEndErrorText, so there is a single source of truth. Returns null when
   * the current turn holds no refusal (a real cancel/abort → 'Aborted').
   */
  protected denialFailureError(): string | null {
    const denials = this._turnDenials;
    if (denials.length === 0) return null;
    const category = classifyTurnEnd({ stopReason: 'cancelled', cancelFact: null, denials, hasQueuedMessages: false });
    return turnEndErrorText(category, denials) || null;
  }

  /** 3) Error normalization: fold a phase failure into an AcpError. Default: AcpErrors pass, everything else is agent-error. */
  protected normalizeError(err: unknown, _phase: 'handshake' | 'session-new' | 'prompt'): AcpError {
    if (err instanceof AcpError) return err;
    return new AcpError('agent-error', err instanceof Error ? err.message : String(err));
  }

  /** 4) Readiness: default only trusts protocolVersion === 1 (the client already rejects other versions). */
  protected isReady(ctx: AcpReadyContext): AcpReadiness {
    if (ctx.handshake.protocolVersion === 1) return { ready: true };
    return { ready: false, message: acpUserMessage('protocol-mismatch', { command: this._launchCommand }) };
  }

  /**
   * 5) Stop strategy — provider-measured values override (03 booklet). The
   * default is CLI-neutral and conservative, chosen because no specific CLI
   * behavior backs anything wider: cancelGraceMs 5000 / sigtermWaitMs 2000 /
   * trustUpdatesAfterCancel FALSE — post-cancel updates are dropped and
   * counted rather than written, so steps that ran after a user cancel are
   * never recorded as if they were sanctioned.
   */
  protected stopPolicy(): AcpStopPolicy {
    return { cancelGraceMs: 5_000, sigtermWaitMs: 2_000, trustUpdatesAfterCancel: false };
  }

  // --- IWorkerInstance surface (aligned with ClaudeCodeWorker) ---

  /** Wire signal context. Called by the engine before run(); grants/approvalMemory are the 04 §3 additions. */
  setSignalContext(deps: {
    signalQueue: SignalQueue;
    workerId: string;
    taskId: string;
    taskTitle: string;
    workerType?: string;
    emoji?: string;
    turnLineage?: SignalTurnLineage;
    accessScope?: WorkerAccessScope;
    grants?: ApprovalMemory;
    approvalMemory?: ApprovalMemoryMode;
  }): void {
    this._signalQueue = deps.signalQueue;
    this._runContext = deps;
    this._turnLineage = deps.turnLineage ?? {};
    this._accessScope = deps.accessScope ?? null;
    this._grants = deps.grants ?? new ApprovalMemory();
    this._approvalMemory = deps.approvalMemory ?? 'task';
  }

  /**
   * Wire the engine-backed ask_controller implementation. The per-run Wayang
   * MCP bridge serves it over a Unix socket (member presence is what the
   * engine's `wireWorker` probe detects, as with ClaudeCodeWorker).
   */
  setInquirySupport(ask: (question: string, context?: string) => Promise<string>): void {
    this._askController = ask;
  }

  getState(): WorkerState {
    return this.state;
  }

  getLiveStatus(): WorkerLiveStatus {
    return { resultReceived: this._resultReceived, streamEnded: this._streamEnded };
  }

  getConversation(): ConversationEntry[] {
    return this.state.get<ConversationEntry[]>('conversation') ?? [];
  }

  subscribe(path: string, callback: (event: StateEvent) => void): () => void {
    return this.state.on(path, callback);
  }

  getSnapshot<T>(path: string): T {
    return this.state.get(path);
  }

  /**
   * Queue a controller message for delivery at the next TURN boundary (ACP has
   * no mid-turn injection — 01 §2.4). Returns false once the run's input has
   * closed; idle multi-stage workers keep accepting (folded into the next
   * stage's opening prompt).
   */
  acceptMessage(message: string): boolean {
    if (this.abortController.signal.aborted) return false;
    if (this._runInFlight && this._inputClosed) return false;
    this._messageQueue.push(message);
    this.logger.info({ workerId: this.id }, 'Controller message accepted');
    return true;
  }

  pendingMessages(): string[] {
    return [...this._messageQueue];
  }

  /** Stable capability view (02 §6): observed-this-run, overridable by config. */
  getCapabilities(): AcpCapabilities | null {
    if (!this._handshake) return null;
    const overrides = this.acpUserConfig().protocol?.capabilities;
    return buildAcpCapabilities(this.config.type, this._handshake, {
      toolCalls: overrides?.toolCalls ?? this._sawToolCall,
      permissionRequests: overrides?.permissionRequests ?? this._sawPermissionRequest,
    });
  }

  // --- Shared internals ---

  /** The `*-acp` config row as this worker reads it (fields land in WorkerConfig with C2). */
  protected acpUserConfig(): AcpWorkerUserConfig {
    return this.config as WorkerConfig & AcpWorkerUserConfig;
  }

  /** Turn identity: one worker run = one turn (aligned with the claude-code worker). */
  protected buildTurnEnv(task: TaskDetail & { workerId: string }): TurnEnvelope {
    const workspaceSlug = task.workspace?.slug ?? this.workspaceRef?.slug;
    const rootTurnId = task.rootTurnId ?? task.turnId;
    return {
      turnId: task.executionTurnId ?? generateId('turn'),
      ...(rootTurnId !== undefined && { rootTurnId }),
      causationId: task.id,
      actor: { kind: 'worker', id: task.workerId, taskId: task.id },
      ...(workspaceSlug !== undefined && { workspaceSlug }),
    };
  }

  /** Merge keys into runtimeState.acp (pid/command/provider, plan, usage). */
  protected recordAcpRuntime(fields: Record<string, unknown>): void {
    const prev = this.state.get<Record<string, unknown>>('runtimeState') ?? {};
    this.state.set('runtimeState', { ...prev, acp: { ...((prev.acp as Record<string, unknown>) ?? {}), ...fields } });
  }
}
