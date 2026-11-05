/**
 * Pure ACP protocol parsing/construction helpers.
 *
 * Internal module split out of client.ts (500-line hard limit; split sanctioned
 * by the freeze page's §1 note on #50 pure moves). Stateless only — no
 * transport, no timers, no maps. The frozen §2.4 helper exports
 * (buildAcpCapabilities / selectAllowOption / selectRejectOption) live here
 * and are re-exported from client.ts so the frozen import surface is
 * unchanged.
 */

import { AcpError } from './errors';
import type {
  AcpAgentCapabilities,
  AcpAuthMethod,
  AcpCapabilities,
  AcpClientCapabilities,
  AcpHandshake,
  AcpPermissionOption,
  AcpPermissionOutcome,
  AcpStopReason,
  AcpTurnResult,
} from './types';

export const ACP_PROTOCOL_VERSION = 1;

/** The 14 official v1 sessionUpdate variants; anything else is a vendor/unknown variant. */
export const KNOWN_SESSION_UPDATE_VARIANTS: ReadonlySet<string> = new Set([
  'user_message_chunk',
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'usage_update',
  'available_commands_update',
  'current_mode_update',
  'config_option_update',
  'session_info_update',
  'notice',
  'compaction_update',
  'compaction_summary_chunk',
]);

export const STOP_REASONS: ReadonlySet<AcpStopReason> = new Set([
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
]);

/** §4 auth-required: a stderr hit short-circuits without waiting for the timeout. */
export const AUTH_STDERR_PATTERN = /login|auth|unauthor|token|401/i;

/** All-false default per §2.4: fs{readTextFile,writeTextFile:false}, terminal:false, auth{terminal:false}. */
export function normalizeClientCapabilities(input?: AcpClientCapabilities): AcpClientCapabilities {
  return {
    fs: {
      readTextFile: input?.fs?.readTextFile === true,
      writeTextFile: input?.fs?.writeTextFile === true,
    },
    terminal: input?.terminal === true,
    auth: { terminal: input?.auth?.terminal === true },
  };
}

/** Validate an initialize result. Throws AcpError('protocol-mismatch') when the version is not 1. */
export function parseHandshake(raw: unknown): AcpHandshake {
  const obj = (raw ?? {}) as Record<string, unknown>;
  if (obj.protocolVersion !== ACP_PROTOCOL_VERSION) {
    throw new AcpError(
      'protocol-mismatch',
      `agent protocolVersion ${JSON.stringify(obj.protocolVersion)} !== ${ACP_PROTOCOL_VERSION}`,
    );
  }
  const capsRaw = (obj.agentCapabilities ?? {}) as Record<string, unknown>;
  const agentCapabilities: AcpAgentCapabilities = {
    loadSession: capsRaw.loadSession === true,
    promptCapabilities: (capsRaw.promptCapabilities ?? null) as AcpAgentCapabilities['promptCapabilities'],
    mcpCapabilities: (capsRaw.mcpCapabilities ?? null) as AcpAgentCapabilities['mcpCapabilities'],
    raw: obj.agentCapabilities,
  };
  const authMethods: AcpAuthMethod[] = Array.isArray(obj.authMethods)
    ? obj.authMethods.filter(
        (method): method is AcpAuthMethod =>
          method !== null &&
          typeof method === 'object' &&
          typeof (method as { id?: unknown }).id === 'string' &&
          typeof (method as { name?: unknown }).name === 'string',
      )
    : [];
  const agentInfoRaw = obj.agentInfo as unknown;
  const agentInfo =
    agentInfoRaw !== null &&
    typeof agentInfoRaw === 'object' &&
    typeof (agentInfoRaw as { name?: unknown }).name === 'string'
      ? (agentInfoRaw as AcpHandshake['agentInfo'])
      : null;
  return { protocolVersion: ACP_PROTOCOL_VERSION, agentCapabilities, authMethods, agentInfo };
}

/** Validate a session/prompt result. Throws AcpError('protocol-mismatch') without a valid stopReason. */
export function parseTurnResult(raw: unknown): AcpTurnResult {
  const obj = (raw ?? null) as { stopReason?: unknown } | null;
  const stopReason = obj && typeof obj === 'object' ? obj.stopReason : undefined;
  if (typeof stopReason !== 'string' || !STOP_REASONS.has(stopReason as AcpStopReason)) {
    throw new AcpError(
      'protocol-mismatch',
      `session/prompt settled without a valid stopReason: ${JSON.stringify(stopReason)}`,
    );
  }
  return { stopReason: stopReason as AcpStopReason, raw };
}

/** Fail-closed: anything that is not a well-formed outcome becomes 'cancelled'. */
export function normalizePermissionOutcome(outcome: AcpPermissionOutcome | undefined | null): AcpPermissionOutcome {
  if (outcome?.outcome === 'selected' && typeof outcome.optionId === 'string') return outcome;
  if (outcome?.outcome === 'cancelled') return outcome;
  return { outcome: 'cancelled' };
}

/** Build the stable capability view for upper layers from a handshake. */
export function buildAcpCapabilities(
  provider: string,
  handshake: AcpHandshake,
  overrides?: Partial<Pick<AcpCapabilities, 'permissionRequests' | 'toolCalls'>>,
): AcpCapabilities {
  return {
    provider,
    protocolVersion: handshake.protocolVersion,
    streaming: true,
    toolCalls: overrides?.toolCalls ?? true,
    permissionRequests: overrides?.permissionRequests ?? true,
    loadSession: handshake.agentCapabilities?.loadSession === true,
    midTurnInject: false,
    inquiry: false,
    authMethods: handshake.authMethods,
  };
}

/** Prefer 'allow_once', then 'allow_always'; undefined when neither is offered. */
export function selectAllowOption(options: AcpPermissionOption[]): AcpPermissionOption | undefined {
  return (
    options.find((option) => option.kind === 'allow_once') ??
    options.find((option) => option.kind === 'allow_always')
  );
}

/** Prefer 'reject_once', then 'reject_always'; undefined when neither is offered. */
export function selectRejectOption(options: AcpPermissionOption[]): AcpPermissionOption | undefined {
  return (
    options.find((option) => option.kind === 'reject_once') ??
    options.find((option) => option.kind === 'reject_always')
  );
}
