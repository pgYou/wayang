/**
 * ACP launch configuration and timeout matrix.
 *
 * Contract: docs/design/acp/00-interface-freeze.md §2.1. Pure functions over
 * plain objects — this module never reads `WayangConfig` (merging with
 * `process.env` and provider defaults is the worker layer's job).
 */

import { AcpError } from './errors';

export interface AcpTimeouts {
  /** Upper bound for the initialize response. Default 15000. */
  handshakeMs: number;
  /** Upper bound for the session/new response. Default 30000. */
  sessionNewMs: number;
  /** Per-turn upper bound. 0 = unlimited; > 0 walks the §6 cancel path on expiry. Default 0. */
  promptMs: number;
  /** Upper bound for a permission_request to be answered. Default 300000. */
  permissionMs: number;
  /** Grace after session/cancel before SIGTERM. Default 5000. */
  cancelGraceMs: number;
  /** Grace after SIGTERM before SIGKILL. Default 2000. */
  sigtermWaitMs: number;
}

export interface AcpLaunchConfig {
  /** Executable name; if not on PATH the worker-layer preflight reports 'cli-missing'. */
  command: string;
  /** Provider defaults (codebuddy ['--acp'] / opencode ['acp']), overridable by user config. */
  args: readonly string[];
  /** Final environment already merged with process.env (merging done by the worker layer). */
  env: Record<string, string>;
  /** Absolute path = task workspace, also the cwd for session/new. */
  cwd: string;
  timeouts: AcpTimeouts;
  /**
   * Beyond freeze (see delivery report): per-line byte cap for ndjson framing
   * (oversized frames are rejected as 'protocol-mismatch'). Default 10 MiB.
   */
  maxLineBytes?: number;
}

export const DEFAULT_ACP_TIMEOUTS: AcpTimeouts = {
  handshakeMs: 15_000,
  sessionNewMs: 30_000,
  promptMs: 0,
  permissionMs: 300_000,
  cancelGraceMs: 5_000,
  sigtermWaitMs: 2_000,
};

/** JSON-RPC error codes the protocol layer produces or matches on. */
export const ACP_JSONRPC_ERROR = {
  requestCancelled: -32800,
  methodNotFound: -32601,
  internal: -32603,
} as const;

/** The timeout fields `resolveAcpTimeouts` reads; anything else in `partial` is ignored. */
const ACP_TIMEOUT_KEYS = ['handshakeMs', 'sessionNewMs', 'promptMs', 'permissionMs', 'cancelGraceMs', 'sigtermWaitMs'] as const;

/**
 * Merge a partial timeout matrix over the defaults and validate it:
 * `promptMs` must be >= 0, every other field > 0, all finite numbers.
 * Violations throw `AcpError('protocol-mismatch')`.
 *
 * Callers pass whole `AcpProtocolConfig` objects (which also carry
 * non-timeout fields such as `capabilities` / `gatePermissions`); only the
 * six timeout fields above are read — a non-timeout key must never leak into
 * the merged matrix (it would fail the numeric validation below).
 */
export function resolveAcpTimeouts(partial?: Partial<AcpTimeouts>): AcpTimeouts {
  const merged: AcpTimeouts = { ...DEFAULT_ACP_TIMEOUTS };
  if (partial) {
    for (const key of ACP_TIMEOUT_KEYS) {
      const value = partial[key];
      if (value !== undefined) merged[key] = value;
    }
  }
  for (const key of ACP_TIMEOUT_KEYS) {
    const value = merged[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new AcpError('protocol-mismatch', `invalid AcpTimeouts.${key}: ${String(value)}`);
    }
    const ok = key === 'promptMs' ? value >= 0 : value > 0;
    if (!ok) {
      throw new AcpError('protocol-mismatch', `invalid AcpTimeouts.${key}: ${value}`);
    }
  }
  return merged;
}
