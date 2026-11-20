/**
 * OpenCodeAcpWorker — OpenCode over native ACP (`opencode acp`).
 *
 * **experimental** — startup/handshake/auth behavior remains UNMEASURED
 * (03 booklet §3): those paths only follow the official docs
 * (https://opencode.ai/docs/acp/) and fail fast, nothing degrades silently.
 * The PERMISSION behavior, however, is measured (2026-11-05, opencode 2.2.5):
 * the default agent permission rules are allow-all (only `.env` reads ask),
 * so `opencode acp` never sends session/request_permission for bash or file
 * writes — including writes outside the workspace — and the wayang permission
 * bridge is inert unless the gate below is injected. Measured with the gate:
 * permission requests appear, a rejection stops the write, and the user's
 * global provider/model config is unaffected (opencode merges OPENCODE_CONFIG
 * over it).
 *
 * A thin class: only three hooks differ —
 *   buildLaunch: `opencode acp` (docs only, unmeasured) + the permission-gate
 *                injection (measured, see applyPermissionGate),
 *   isReady:     the same shape as codebuddy's attribution (stderr keyword +
 *                session/new timeout with authMethods), unmeasured — opencode
 *                has its own auth flow, the message stays generic,
 *   stopPolicy:  cancelGraceMs 5000, sigtermWaitMs 2000,
 *                trustUpdatesAfterCancel FALSE — post-cancel updates are
 *                dropped and counted (never written to the transcript):
 *                with no measured behavior to trust, the conservative
 *                choice is losing wrap-up noise over recording steps that
 *                ran after the user cancelled.
 * mapPermission / normalizeError keep the skeleton defaults.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AcpLaunchConfig } from '@/services/acp/config';
import { AcpError } from '@/services/acp/errors';
import { authAttributingReadiness, type AcpReadiness, type AcpReadyContext, type AcpStopPolicy, type AcpWorkerEnvView } from './base-acp-worker';
import { AcpWorkerRun } from './acp-worker-run';
import { workerDir } from '../worker-state';
import { GATE_ASK_ALL_RULE, GATE_FILE_NAME, validateInheritedGateConfig } from './opencode-gate';

export class OpenCodeAcpWorker extends AcpWorkerRun {
  /** Provider defaults from the official docs (unmeasured). */
  private static readonly DEFAULT_COMMAND = 'opencode';
  private static readonly DEFAULT_ARGS: readonly string[] = ['acp'];

  /** Ask-all permission matrix (measured #25): every tool operation must ask. */
  private static readonly GATE_CONFIG = `${JSON.stringify({ permissions: [GATE_ASK_ALL_RULE] })}\n`;

  /** Gate file of the CURRENT run (worker-scoped); null when nothing was written. */
  private _gateFile: string | null = null;

  protected buildLaunch(view: AcpWorkerEnvView): AcpLaunchConfig {
    const env = { ...view.env };
    this.applyPermissionGate(env);
    return {
      command: view.command ?? OpenCodeAcpWorker.DEFAULT_COMMAND,
      args: view.args ?? OpenCodeAcpWorker.DEFAULT_ARGS,
      env,
      cwd: view.cwd,
      timeouts: view.timeouts,
    };
  }

  /**
   * Undo buildLaunch's side effect once the run's client has closed (#62):
   * remove the gate file. The worker-scoped path (never the shared session
   * root) keeps concurrent opencode workers from deleting each other's gate.
   */
  protected cleanupLaunch(): void {
    const gateFile = this._gateFile;
    if (gateFile === null) return;
    this._gateFile = null;
    try {
      rmSync(gateFile, { force: true });
      this.logger.debug({ provider: this.config.type, gateFile }, 'opencode permission gate file removed');
    } catch (err) {
      // Cleanup must never fail the run; an inert leftover JSON file is acceptable.
      this.logger.debug({ err, gateFile }, 'opencode permission gate file could not be removed');
    }
  }

  /**
   * Inject the wayang permission gate (measured #25): write the ask-all
   * matrix to `<sessionDir>/workers/<workerId>/opencode-acp-gate.json` and
   * point the child env's `OPENCODE_CONFIG` at it. Without this, opencode's
   * allow-all defaults mean the agent never asks and the permission bridge
   * never runs.
   *
   * Skipped (with a warning) when the user opted out
   * (`permissionMode: 'agent'` — takes precedence over gatePermissions — or
   * `protocol.gatePermissions: false`). An inherited parent `OPENCODE_CONFIG`
   * is VALIDATED (#62): kept only when it provably gates tool operations
   * with ask rules (see opencode-gate.ts), otherwise the launch is REFUSED —
   * never a silent ungated run. An unwritable gate file fails the run the
   * same way. The gate file is removed in cleanupLaunch when the run ends.
   */
  private applyPermissionGate(env: Record<string, string>): void {
    const userCfg = this.acpUserConfig();
    if (userCfg.permissionMode === 'agent') {
      this.logger.warn(
        { provider: this.config.type },
        'permissionMode "agent": opencode permission gate not injected — the agent owns its permissions, wayang does not bridge them',
      );
      return;
    }
    if (userCfg.protocol?.gatePermissions === false) {
      this.logger.warn(
        { provider: this.config.type },
        'opencode tool operations bypass the wayang permission gate (protocol.gatePermissions=false) — the agent runs with its own (allow-all by default) permission rules',
      );
      return;
    }
    if (env.OPENCODE_CONFIG !== undefined) {
      const verdict = validateInheritedGateConfig(env.OPENCODE_CONFIG);
      if (!verdict.equivalent) {
        throw new AcpError(
          'agent-error',
          `permission gate refused: inherited OPENCODE_CONFIG does not gate tool operations (${verdict.reason}); `
            + `add an ask-all rule {"action":"*","resource":"*","effect":"ask"} to it, or take the gate over explicitly with permissionMode "agent" / protocol.gatePermissions=false`,
        );
      }
      this.logger.warn(
        { provider: this.config.type, opencodeConfig: env.OPENCODE_CONFIG },
        'OPENCODE_CONFIG already set in the environment — validated as gate-equivalent (ask-all rule present), kept as-is',
      );
      return;
    }
    const dir = workerDir(this.sessionDir, this.id);
    const gatePath = join(dir, GATE_FILE_NAME);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(gatePath, OpenCodeAcpWorker.GATE_CONFIG, 'utf8');
    } catch (err) {
      throw new AcpError(
        'agent-error',
        `permission gate injection failed: could not write ${gatePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this._gateFile = gatePath;
    env.OPENCODE_CONFIG = gatePath;
    this.logger.debug({ provider: this.config.type, gatePath }, 'opencode permission gate injected (ask-all permission matrix)');
  }

  /**
   * Same-shape attribution as codebuddy (unmeasured): auth-required error or
   * auth stderr keyword → auth-required, with a GENERIC login hint (the
   * concrete auth command for opencode has not been verified).
   */
  protected isReady(ctx: AcpReadyContext): AcpReadiness {
    return authAttributingReadiness(ctx, { provider: this.config.type, command: this._launchCommand });
  }

  protected stopPolicy(): AcpStopPolicy {
    return { cancelGraceMs: 5_000, sigtermWaitMs: 2_000, trustUpdatesAfterCancel: false };
  }
}
