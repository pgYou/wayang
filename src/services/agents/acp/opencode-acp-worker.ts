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

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AcpLaunchConfig } from '@/services/acp/config';
import { AcpError } from '@/services/acp/errors';
import { authAttributingReadiness, type AcpReadiness, type AcpReadyContext, type AcpStopPolicy, type AcpWorkerEnvView } from './base-acp-worker';
import { AcpWorkerRun } from './acp-worker-run';

export class OpenCodeAcpWorker extends AcpWorkerRun {
  /** Provider defaults from the official docs (unmeasured). */
  private static readonly DEFAULT_COMMAND = 'opencode';
  private static readonly DEFAULT_ARGS: readonly string[] = ['acp'];

  /** Gate file written under the session dir; overwritten on every launch. */
  private static readonly GATE_FILE_NAME = 'opencode-acp-gate.json';
  /** Ask-all permission matrix (measured #25): every tool operation must ask. */
  private static readonly GATE_CONFIG = `${JSON.stringify({ permissions: [{ action: '*', resource: '*', effect: 'ask' }] })}\n`;

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
   * Inject the wayang permission gate (measured #25): write the ask-all
   * matrix to `<sessionDir>/opencode-acp-gate.json` and point the child env's
   * `OPENCODE_CONFIG` at it. Without this, opencode's allow-all defaults mean
   * the agent never asks and the permission bridge never runs.
   *
   * Skipped (with a warning) when the user opted out
   * (`protocol.gatePermissions: false`), when the parent env already carries
   * an `OPENCODE_CONFIG` (user config wins — the gate then depends on that
   * file's permission rules), and under `permissionMode: 'agent'` (the agent
   * owns its permissions there; a forced ask would be answered 'cancelled'
   * and block every tool operation). An unwritable gate file fails the run —
   * never a silent ungated launch.
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
      this.logger.warn(
        { provider: this.config.type, opencodeConfig: env.OPENCODE_CONFIG },
        'OPENCODE_CONFIG already set in the environment — kept as-is; whether opencode asks for permission depends on that config',
      );
      return;
    }
    const gatePath = resolve(this.sessionDir, OpenCodeAcpWorker.GATE_FILE_NAME);
    try {
      writeFileSync(gatePath, OpenCodeAcpWorker.GATE_CONFIG, 'utf8');
    } catch (err) {
      throw new AcpError(
        'agent-error',
        `opencode permission gate config could not be written (${gatePath}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
