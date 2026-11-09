/**
 * AcpSessionOpen — the session/new call with its fail-soft and attribution
 * rules, extracted from the run layer (same frozen §3/§2.2 semantics):
 *
 * - stderr auth short-circuit: a stderr line hitting the auth pattern rejects
 *   the session/new race immediately (do not wait out the timeout);
 * - fail-soft: if the call carrying `mcpServers` fails, retry ONCE with []
 *   (the caller degrades MCP first). auth-required / cancelled /
 *   transport-closed are never retried;
 * - every failure is attributed through the run's `isReady` hook (the ready
 *   path) or `normalizeError`.
 */

import type { AcpClient } from '@/services/acp/client';
import type { AcpTransport } from '@/services/acp/transport';
import type { AcpHandshake, AcpMcpServer } from '@/services/acp/types';
import { AcpError } from '@/services/acp/errors';
import type { AcpReadiness, AcpReadyContext } from './base-acp-worker';

export interface AcpSessionOpenDeps {
  client: AcpClient;
  handshake: AcpHandshake;
  transport: AcpTransport;
  /** Working directory for the session (the worker's workspace). */
  cwd: string;
  /** The mcpServers descriptors (empty [] on the degraded path). */
  mcpServers: AcpMcpServer[];
  /** The run's isReady hook (attribution). */
  isReady: (ctx: AcpReadyContext) => AcpReadiness;
  /** The run's normalizeError hook. */
  normalizeError: (err: unknown, phase: 'handshake' | 'session-new' | 'prompt') => AcpError;
  /** Degrade MCP before the [] retry (the host's degrade). */
  degrade: (reason: string, err?: unknown) => Promise<void>;
  /** Wire/clear the stderr auth short-circuit handler. */
  setAuthHit: (handler: ((line: string) => void) | null) => void;
}

/** session/new with the stderr login short-circuit race. */
async function trySessionNew(client: AcpClient, cwd: string, mcpServers: AcpMcpServer[], setAuthHit: AcpSessionOpenDeps['setAuthHit']): Promise<string> {
  const authHit = new Promise<never>((_, reject) => {
    setAuthHit((line) =>
      reject(new AcpError('auth-required', `auth keyword on stderr during session/new: ${line}`, { stderrTail: [line] })));
  });
  // The race loser's rejection must not surface as an unhandled rejection.
  authHit.catch(() => undefined);
  try {
    const { sessionId } = await Promise.race([
      client.sessionNew({ cwd, mcpServers }),
      authHit,
    ]);
    return sessionId;
  } finally {
    setAuthHit(null);
  }
}

function mcpRetryable(err: unknown, deps: AcpSessionOpenDeps): boolean {
  const readiness = deps.isReady({
    handshake: deps.handshake,
    phase: 'session-new',
    error: err,
    stderrTail: deps.transport.stderrTail(),
  });
  if (!readiness.ready) return false;
  if (err instanceof AcpError && ['auth-required', 'cancelled', 'transport-closed'].includes(err.code)) return false;
  return true;
}

function attributeSessionNewError(err: unknown, deps: AcpSessionOpenDeps): never {
  const readiness = deps.isReady({
    handshake: deps.handshake,
    phase: 'session-new',
    error: err,
    stderrTail: deps.transport.stderrTail(),
  });
  if (!readiness.ready) {
    throw new AcpError(readiness.kind ?? 'agent-error', readiness.message ?? 'agent not ready after session/new');
  }
  throw deps.normalizeError(err, 'session-new');
}

/** Open the session; see the module header for the fail-soft and attribution rules. */
export async function openAcpSession(deps: AcpSessionOpenDeps): Promise<string> {
  try {
    return await trySessionNew(deps.client, deps.cwd, deps.mcpServers, deps.setAuthHit);
  } catch (firstError) {
    if (deps.mcpServers.length > 0 && mcpRetryable(firstError, deps)) {
      await deps.degrade('session-new-mcp-error', firstError);
      try {
        return await trySessionNew(deps.client, deps.cwd, [], deps.setAuthHit);
      } catch (secondError) {
        attributeSessionNewError(secondError, deps);
      }
    }
    attributeSessionNewError(firstError, deps);
  }
}
