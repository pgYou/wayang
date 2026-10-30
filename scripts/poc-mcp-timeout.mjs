/**
 * PoC 2 (v0.6 design §6.2): an in-process SDK MCP tool whose handler blocks
 * longer than the default stream-close timeout (60s, per the createSdkMcpServer
 * doc note). Wayang's ask_controller blocks up to 5 minutes — this PoC
 * confirms (a) the default really cuts long calls and (b) the
 * CLAUDE_CODE_STREAM_CLOSE_TIMEOUT override really raises the ceiling.
 *
 * Run locally (needs a working claude CLI login):
 *   node scripts/poc-mcp-timeout.mjs              # control: no override, sleeps 63s
 *   node scripts/poc-mcp-timeout.mjs --override   # override set, sleeps 90s
 *
 * Expected: control run's sleep_tool result errors out around ~60s (or the
 * call dies); override run completes cleanly at 90s.
 */
import { query, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const withOverride = process.argv.includes('--override');
const SLEEP_MS = withOverride ? 90_000 : 63_000; // just over the 60s default

const sleepTool = {
  name: 'sleep_tool',
  description: 'Sleeps for the given milliseconds, then returns a confirmation. Use exactly as instructed.',
  inputSchema: { ms: z.number().describe('milliseconds to sleep') },
  handler: async ({ ms }) => {
    console.log(`[poc] sleep_tool handler START (${ms}ms)`);
    await new Promise((r) => setTimeout(r, ms));
    console.log('[poc] sleep_tool handler END — returning result');
    return { content: [{ type: 'text', text: `slept ${ms}ms` }] };
  },
};

const startedAt = Date.now();
console.log(`[poc] mode=${withOverride ? 'OVERRIDE' : 'CONTROL'} sleep=${SLEEP_MS}ms`);

const stream = query({
  prompt: [{
    type: 'user',
    message: { role: 'user', content: `Call the sleep_tool tool with ms=${SLEEP_MS}. Then reply with exactly: DONE <the tool's text>.` },
    parent_tool_use_id: null,
  }],
  options: {
    cwd: process.cwd(),
    permissionMode: 'bypassPermissions',
    ...(withOverride && { env: { CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: String(SLEEP_MS + 30_000) } }),
    mcpServers: {
      poc: createSdkMcpServer({ name: 'poc', version: '1.0.0', tools: [sleepTool] }),
    },
  },
});

for await (const msg of stream) {
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  if (msg.type === 'assistant') {
    const text = (msg.message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join(' ');
    if (text) console.log(`[poc] +${elapsed}s assistant: ${text.slice(0, 160)}`);
  } else if (msg.type === 'result') {
    console.log(`[poc] +${elapsed}s result subtype=${msg.subtype} errors=${JSON.stringify(msg.errors ?? [])} result=${String(msg.result ?? '').slice(0, 120)}`);
  }
}

console.log(`[poc] stream ended at +${Math.round((Date.now() - startedAt) / 1000)}s`);
process.exit(0);
