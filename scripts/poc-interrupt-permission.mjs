/**
 * PoC 1 (v0.6 design §6.1): call interrupt() while a canUseTool permission
 * is pending. Observes whether the SDK leaves an orphaned tool_use, whether
 * the pending permission promise settles, and how the next turn behaves.
 *
 * Run locally (needs a working claude CLI login):
 *   node scripts/poc-interrupt-permission.mjs
 *
 * Watch for:
 *   - the interrupt racing the pending canUseTool promise
 *   - an error / "tool_use ids were found without tool_result blocks" style
 *     failures on the follow-up turn (the orphaned-tool_use hazard)
 *   - whether resolving the permission after the interrupt still reaches the
 *     CLI (our production guard defers the interrupt until it settles — this
 *   PoC tells us whether that guard is load-bearing or merely cautious)
 */
import { query } from '@anthropic-ai/claude-agent-sdk';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function* promptStream() {
  yield {
    type: 'user',
    message: { role: 'user', content: 'Run this exact command with the Bash tool: sudo ls /tmp — do nothing else first.' },
    parent_tool_use_id: null,
  };
  // Bounded park: keep the session open for follow-up input, but end it after
  // a grace period so the PoC always exits (an infinite park would hang the
  // stream open after the final result).
  await new Promise((r) => setTimeout(r, 90_000));
}

let pendingResolve = null;
let streamRef = null;

const stream = query({
  prompt: promptStream(),
  options: {
    cwd: process.cwd(),
    // 'default', NOT 'bypassPermissions': under bypass the SDK never calls
    // canUseTool (verified against the real CLI — dangerous commands would
    // execute unchecked). 'default' routes tool permission checks here.
    permissionMode: 'default',
    canUseTool: async (toolName, input) => {
      console.log(`[poc] canUseTool called: ${toolName} ${String(input.command).slice(0, 60)}`);
      return await new Promise((resolve) => {
        pendingResolve = resolve;
        setTimeout(async () => {
          console.log('[poc] >>> calling interrupt() WHILE permission pending...');
          try {
            await streamRef.interrupt();
            console.log('[poc] interrupt() resolved while permission still pending');
          } catch (err) {
            console.log('[poc] interrupt() THREW while permission pending:', String(err));
          }
          // Settle the permission 2s after the interrupt, like a slow human.
          await sleep(2000);
          if (pendingResolve) {
            pendingResolve({ behavior: 'allow' });
            pendingResolve = null;
            console.log('[poc] permission resolved (allow) AFTER interrupt');
          }
        }, 2000);
      });
    },
  },
});
streamRef = stream;

for await (const msg of stream) {
  const bits = [];
  if (msg.type === 'assistant') {
    bits.push(...(msg.message?.content ?? []).map(b => b.type === 'text' ? `text:${b.text.slice(0, 120)}` : `${b.type}:${b.id ?? ''}`));
  } else if (msg.type === 'result') {
    bits.push(`subtype=${msg.subtype}`, `errors=${JSON.stringify(msg.errors ?? [])}`);
  }
  console.log(`[poc] message ${msg.type}${msg.subtype ? `/${msg.subtype}` : ''} ${bits.join(' | ')}`);
}

console.log('[poc] stream ended.');
console.log('[poc] OBSERVE ABOVE: orphaned tool_use? error subtype on result? did the turn survive?');
process.exit(0);
