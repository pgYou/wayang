/**
 * GenericAcpWorker — the config-driven ACP worker for the `type: 'acp'` row.
 *
 * No provider-specific knowledge lives here: the launch comes entirely from
 * `workers.<id>` (command required, args/env optional) via the skeleton's
 * default buildLaunch; readiness keeps the skeleton default (protocolVersion
 * === 1 — no CLI-specific probing); the only override is stopPolicy, whose
 * `trustUpdatesAfterCancel` is the new config field (default false). The
 * dedicated codebuddy/opencode classes keep their measured overrides — the
 * cbc fallback, the 8000ms grace, and the opencode permission gate belong
 * there, not here.
 */

import type { AcpStopPolicy } from './base-acp-worker';
import { AcpWorkerRun } from './acp-worker-run';

export class GenericAcpWorker extends AcpWorkerRun {
  /** Neutral grace ladder (see the base default); trust is config-driven. */
  protected stopPolicy(): AcpStopPolicy {
    return { cancelGraceMs: 5_000, sigtermWaitMs: 2_000, trustUpdatesAfterCancel: this.config.trustUpdatesAfterCancel ?? false };
  }
}
