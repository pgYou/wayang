/**
 * Minimal MCP (JSON-RPC over NDJSON) request dispatcher, shared by the host's
 * Unix-socket endpoint and the bridge's standalone mode. Keeping one
 * implementation means `initialize` / `tools/list` answer identically whether
 * the bridge is connected to a live host or run on its own for diagnostics.
 *
 * Only the `tools` capability is exposed — no resources/prompts, no http/sse.
 */

import {
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_TOOL_NAMES,
  MCP_TOOLS,
  type McpToolName,
} from './mcp-schemas';

export interface McpRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
}

export interface McpError {
  code: number;
  message: string;
}

export interface McpResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: McpError;
}

export interface McpCallResult {
  text: string;
  isError?: boolean;
}

/** Invoked for `tools/call`; the host executes it, the bridge relays it. */
export type McpToolInvoker = (
  name: string,
  args: Record<string, unknown>,
) => Promise<McpCallResult>;

export interface McpServerInfo {
  name: string;
  version: string;
}

export function mcpResult(id: number | string | null, result: unknown): McpResponse {
  return { jsonrpc: '2.0', id, result };
}

export function mcpError(id: number | string | null, code: number, message: string): McpResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** MCP tool-result payload: always one text content block. */
export function mcpToolResultPayload(call: McpCallResult): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: call.text }],
    ...(call.isError ? { isError: true } : {}),
  };
}

/** Extract `{text,isError}` from a host-side MCP tool result for relaying. */
export function parseMcpToolResult(response: McpResponse): McpCallResult {
  if (response.error) {
    return { text: `[MCP ERROR ${response.error.code}] ${response.error.message}`, isError: true };
  }
  const result = response.result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean } | null;
  const text = result?.content?.find((block) => block.type === 'text')?.text;
  return {
    text: typeof text === 'string' ? text : 'The Wayang MCP host returned no text',
    isError: result?.isError === true,
  };
}

/**
 * Build a request handler. Returns `null` for notifications (no response),
 * and a JSON-RPC response for every request. Unknown methods get -32601.
 */
export function createMcpDispatcher(invoker: McpToolInvoker, serverInfo: McpServerInfo) {
  return async (frame: McpRequest): Promise<McpResponse | null> => {
    const method = typeof frame.method === 'string' ? frame.method : '';
    // Notifications (including `notifications/initialized`) never get a reply.
    if (frame.id === undefined || frame.id === null || method.startsWith('notifications/')) return null;
    const id = frame.id;

    switch (method) {
      case 'initialize':
        return mcpResult(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo,
        });
      case 'ping':
        return mcpResult(id, {});
      case 'tools/list':
        return mcpResult(id, { tools: MCP_TOOLS });
      case 'tools/call': {
        const params = (frame.params ?? {}) as { name?: unknown; arguments?: unknown };
        const name = typeof params.name === 'string' ? params.name : '';
        if (!MCP_TOOL_NAMES.includes(name)) {
          return mcpError(id, -32602, `unknown tool "${name}" (available: ${MCP_TOOL_NAMES.join(', ')})`);
        }
        const args = (params.arguments && typeof params.arguments === 'object'
          ? params.arguments
          : {}) as Record<string, unknown>;
        try {
          const call = await invoker(name as McpToolName, args);
          return mcpResult(id, mcpToolResultPayload(call));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return mcpResult(id, mcpToolResultPayload({ text: `[MCP ERROR] ${message}`, isError: true }));
        }
      }
      default:
        return mcpError(id, -32601, `method not found: ${method || '(missing)'}`);
    }
  };
}

export const DEFAULT_MCP_SERVER_INFO: McpServerInfo = { name: MCP_SERVER_NAME, version: 'wayang' };
