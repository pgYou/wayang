/**
 * CodebuddyAcpWorker — Tencent CodeBuddy Code over native ACP (`codebuddy
 * --acp`), the MAIN path, measured on the real CLI (2026-11-05, codebuddy
 * 2.167.0; see 03 booklet §2.1 and the freeze page §9).
 *
 * A thin class (03 §3): it only overrides the hooks where codebuddy's
 * measured behavior differs from the skeleton defaults —
 *   buildLaunch: `codebuddy --acp` (falls back to the `cbc` alias when only
 *               that is on PATH; a user-configured command always wins),
 *   isReady:    session/new timeout with declared authMethods, or an auth
 *               keyword on stderr, is attributed as auth-required (03 §2.2 —
 *               a successful handshake does NOT prove a usable agent),
 *   stopPolicy: cancelGraceMs 8000 (wider than the default — the CLI may be
 *               waiting on the network), sigtermWaitMs 2000,
 *               trustUpdatesAfterCancel true (its late updates are
 *               wrap-up-only in the measured run, dropping them would lose
 *               data).
 * mapPermission / normalizeError keep the skeleton defaults (the shared
 * permission bridge covers the measured request shape; no malformed-exit
 * forms were observed). Everything else is the generic skeleton.
 */

import type { AcpLaunchConfig } from '@/services/acp/config';
import { authAttributingReadiness, findExecutableOnPath, type AcpReadiness, type AcpReadyContext, type AcpStopPolicy, type AcpWorkerEnvView } from './base-acp-worker';
import { AcpWorkerRun } from './acp-worker-run';

export class CodebuddyAcpWorker extends AcpWorkerRun {
  /** Measured provider defaults (03 §2.3); user config overrides win. */
  private static readonly DEFAULT_COMMAND = 'codebuddy';
  private static readonly DEFAULT_ARGS: readonly string[] = ['--acp'];
  /** Alias seen in the wild when only the short name is installed. */
  private static readonly FALLBACK_COMMAND = 'cbc';

  protected buildLaunch(view: AcpWorkerEnvView): AcpLaunchConfig {
    return {
      command: view.command ?? this.defaultCommand(),
      args: view.args ?? CodebuddyAcpWorker.DEFAULT_ARGS,
      env: view.env,
      cwd: view.cwd,
      timeouts: view.timeouts,
    };
  }

  /**
   * `codebuddy` when it is on PATH; `cbc` when only the alias exists; the
   * plain default (so preflight reports cli-missing with the install hint)
   * when neither is found.
   */
  private defaultCommand(): string {
    if (findExecutableOnPath(CodebuddyAcpWorker.DEFAULT_COMMAND) !== undefined) {
      return CodebuddyAcpWorker.DEFAULT_COMMAND;
    }
    if (findExecutableOnPath(CodebuddyAcpWorker.FALLBACK_COMMAND) !== undefined) {
      return CodebuddyAcpWorker.FALLBACK_COMMAND;
    }
    return CodebuddyAcpWorker.DEFAULT_COMMAND;
  }

  /**
   * Handshake success does not prove a usable agent (measured: an
   * uninitialized login parks session/new with no output at all). The shared
   * attribution covers both signals: the protocol layer's auth-required
   * timeout error, and an auth keyword on stderr (short-circuit, no timeout
   * wait). Everything else stays on its original error path.
   */
  protected isReady(ctx: AcpReadyContext): AcpReadiness {
    return authAttributingReadiness(ctx, { provider: this.config.type, command: this._launchCommand });
  }

  protected stopPolicy(): AcpStopPolicy {
    return { cancelGraceMs: 8_000, sigtermWaitMs: 2_000, trustUpdatesAfterCancel: true };
  }
}
