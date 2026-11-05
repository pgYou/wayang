/**
 * OpenCodeAcpWorker — OpenCode over native ACP (`opencode acp`).
 *
 * **experimental — UNMEASURED** (03 booklet §3): the CLI is not installed on
 * the reference machine; the ONLY basis is the official docs
 * (https://opencode.ai/docs/acp/). 0.9.0 makes NO behavioral assumption about
 * this provider: startup failures, handshake failures and auth failures all
 * fail fast, nothing degrades silently. Every behavioral override below is
 * marked unmeasured.
 *
 * A thin class: only three hooks differ —
 *   buildLaunch: `opencode acp` (docs only, unmeasured),
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

import type { AcpLaunchConfig } from '@/services/acp/config';
import { authAttributingReadiness, type AcpReadiness, type AcpReadyContext, type AcpStopPolicy, type AcpWorkerEnvView } from './base-acp-worker';
import { AcpWorkerRun } from './acp-worker-run';

export class OpenCodeAcpWorker extends AcpWorkerRun {
  /** Provider defaults from the official docs (unmeasured). */
  private static readonly DEFAULT_COMMAND = 'opencode';
  private static readonly DEFAULT_ARGS: readonly string[] = ['acp'];

  protected buildLaunch(view: AcpWorkerEnvView): AcpLaunchConfig {
    return {
      command: view.command ?? OpenCodeAcpWorker.DEFAULT_COMMAND,
      args: view.args ?? OpenCodeAcpWorker.DEFAULT_ARGS,
      env: view.env,
      cwd: view.cwd,
      timeouts: view.timeouts,
    };
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
