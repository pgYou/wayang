/**
 * Shared constants, tool schemas and the ACP `mcpServers` descriptor for the
 * per-run Wayang MCP bridge. Imported by BOTH sides of the Unix socket: the
 * host (main process) and the bridge (child of the ACP agent). Keep this
 * module free of runtime `@/` imports so the bridge can be bundled alone.
 */

import type { AcpMcpServer } from '@/services/acp/types';

/** Name the ACP agent sees in its tool catalog (`mcp__wayang__*`). */
export const MCP_SERVER_NAME = 'wayang';
/** MCP protocolVersion is a DATE string (ACP's protocolVersion is the number 1). */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

export const MCP_ENV_SOCKET = 'WAYANG_MCP_SOCK';
export const MCP_ENV_TOKEN = 'WAYANG_MCP_TOKEN';
export const MCP_ENV_WORKER_ID = 'WAYANG_MCP_WORKER_ID';

/** Only protects against pathological streaming/paste sizes — never a summary. */
export const MAX_PROGRESS_CHARS = 20_000;
export const MAX_QUESTION_CHARS = 500;
export const MAX_CONTEXT_CHARS = 1_000;
export const TRUNCATION_MARKER = '\n…[truncated]';

/** Idle window before the fallback reports the latest complete reply. */
export const PROGRESS_FALLBACK_MS = 120_000;
/** Host-side invocation ceilings (askAndWait itself times out at 300s). */
export const MCP_PROGRESS_TIMEOUT_MS = 5_000;
export const MCP_ASK_TIMEOUT_MS = 310_000;
/** session/new succeeded with mcpServers, but no bridge hello within 10s. */
export const MCP_HANDSHAKE_TIMEOUT_MS = 10_000;
/** Bridge exits when no host connection appears (orphan protection). */
export const MCP_WATCHDOG_MS = 5_000;
export const MCP_MAX_CONNECTIONS = 4;

export type McpToolName = 'update_progress' | 'ask_controller';

export interface McpToolDescriptor {
  name: McpToolName;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
    additionalProperties: boolean;
  };
}

/**
 * JSON Schemas mirror the puppet tools (`tools/update-progress.ts`,
 * `tools/ask-controller.ts`): same limits, same required fields.
 */
export const MCP_TOOLS: McpToolDescriptor[] = [
  {
    name: 'update_progress',
    description:
      'Report progress for the current task. This is the PRIMARY progress channel: ' +
      'call it when entering a new phase, finishing a sub-deliverable, recovering from an error. ' +
      'Do not rely on session/update text — it is only a degraded fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', maxLength: MAX_PROGRESS_CHARS, description: 'Progress description' },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
  {
    name: 'ask_controller',
    description:
      'Ask the controller a question and WAIT for the answer. Use ONLY when blocked: ' +
      'execution cannot continue as instructed (contradiction, missing resource, unexpected state), ' +
      'or continuing would risk significant wasted work. Do NOT use it for decisions you can make ' +
      'yourself — decide those autonomously and report via update_progress.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', maxLength: MAX_QUESTION_CHARS, description: 'The specific question you need answered to proceed. Be concise and self-contained.' },
        context: { type: 'string', maxLength: MAX_CONTEXT_CHARS, description: 'What you have tried and where you are stuck, so the controller can answer precisely.' },
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
];

export const MCP_TOOL_NAMES: readonly string[] = MCP_TOOLS.map((tool) => tool.name);

/** Cap oversized text with an explicit truncation marker. No summarising. */
export function capText(text: string, max: number = MAX_PROGRESS_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}${TRUNCATION_MARKER}` : text;
}

/** ACP v1 stdio server: `env` is an array of {name,value}, NOT a record. */
export function buildMcpServerDescriptor(opts: {
  socketPath: string;
  token: string;
  workerId: string;
  bridgeEntryPath: string;
  nodeExecutable?: string;
}): AcpMcpServer {
  return {
    name: MCP_SERVER_NAME,
    command: opts.nodeExecutable ?? process.execPath,
    args: [opts.bridgeEntryPath],
    env: [
      { name: MCP_ENV_SOCKET, value: opts.socketPath },
      { name: MCP_ENV_TOKEN, value: opts.token },
      { name: MCP_ENV_WORKER_ID, value: opts.workerId },
    ],
  };
}
