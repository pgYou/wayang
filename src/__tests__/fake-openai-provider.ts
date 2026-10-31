/**
 * Fake OpenAI-compatible provider — scripted SSE replay for tests/e2e.
 *
 * Serves `POST /v1/chat/completions` in two modes, mirroring the OpenAI API:
 *  - `stream: true`  → text/event-stream replay (streamText path)
 *  - no `stream`     → plain JSON chat.completion (generateText path, e.g.
 *                      the compaction summarizer)
 *
 * Script entries are matched by request content (NOT arrival order), so races
 * between the controller's next step and a freshly spawned worker's first
 * call cannot scramble the script. Each entry is consumed once; requests
 * with no matching entry fail with 500 so tests fail loud instead of hanging.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

/** Chat completions request body (subset the matcher needs). */
export interface ChatRequestBody {
  messages?: Array<{ role: string; content: string }>;
  [key: string]: unknown;
}

export interface ScriptedToolCall {
  name: string;
  /**
   * Static args, or a resolver evaluated at request time (for ids only known
   * at runtime). The resolver may be async — e.g. poll subscribed state until
   * the id appears — which conveniently also holds the HTTP response open.
   */
  args: Record<string, unknown> | (() => Record<string, unknown> | Promise<Record<string, unknown>>);
}

export interface ScriptEntry {
  /** Return true when this entry should serve the given request body. */
  match: (body: ChatRequestBody) => boolean;
  text?: string;
  toolCalls?: ScriptedToolCall[];
}

export interface FakeProvider {
  baseURL: string;
  port: number;
  /** All received request bodies, in order. */
  requests: ChatRequestBody[];
  /** Mark all entries consumed; add new ones. */
  reset(script: ScriptEntry[]): void;
  close(): Promise<void>;
}

/** True when the request's system prompt looks like the Wayang controller. */
export function isControllerRequest(body: ChatRequestBody): boolean {
  return !isWorkerRequest(body) && !isSummarizerRequest(body)
    && typeof body.messages?.[0]?.content === 'string'
    && body.messages[0].content.includes('You are Wayang');
}

/** True when the request's system prompt looks like a Wayang worker. */
export function isWorkerRequest(body: ChatRequestBody): boolean {
  return typeof body.messages?.[0]?.content === 'string'
    && body.messages[0].content.includes('Wayang Worker');
}

/** True when the request is the compaction summarizer. */
export function isSummarizerRequest(body: ChatRequestBody): boolean {
  return typeof body.messages?.[0]?.content === 'string'
    && body.messages[0].content.includes('conversation summarizer');
}

export async function startFakeProvider(script: ScriptEntry[] = []): Promise<FakeProvider> {
  let queue = [...script];
  const requests: ChatRequestBody[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        let body: ChatRequestBody = {};
        try {
          body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : {};
        } catch { /* fall through to 500 */ }
        requests.push(body);

        const index = queue.findIndex((entry) => {
          try {
            return entry.match(body);
          } catch {
            return false;
          }
        });
        if (index < 0) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `fake-provider: no script entry matches (request #${requests.length}, messages[0]=${String(body.messages?.[0]?.content ?? '').slice(0, 80)}...)` } }));
          return;
        }
        const entry = queue.splice(index, 1)[0];

        // Resolve tool-call args first (may be async resolvers polling state).
        const toolCalls = await Promise.all((entry.toolCalls ?? []).map(async (call) => ({
          name: call.name,
          args: await (typeof call.args === 'function' ? call.args() : call.args),
        })));

        // Non-streaming request (generateText): plain JSON chat.completion.
        if (body.stream !== true) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(encodeChatCompletionJson(entry, toolCalls)));
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        for (const frame of encodeChatCompletionSSE(entry, toolCalls)) {
          res.write(frame);
        }
        res.end();
      })().catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `fake-provider: script resolver failed: ${String(err)}` } }));
        }
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    reset(next: ScriptEntry[]) {
      queue = [...next];
    },
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------------------
// Response encoding (OpenAI chat.completions format)
// ---------------------------------------------------------------------------

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** Tool call with its args already resolved (resolver already awaited). */
export interface ResolvedToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** Non-streaming response body for generateText-style requests. */
function encodeChatCompletionJson(entry: ScriptEntry, toolCalls: ResolvedToolCall[]) {
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: 'fake',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: entry.text ?? '',
        ...(toolCalls.length > 0 && {
          tool_calls: toolCalls.map((call, i) => ({
            id: `call-fake-${i + 1}`,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        }),
      },
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  };
}

export function* encodeChatCompletionSSE(entry: ScriptEntry, toolCalls: ResolvedToolCall[]): Generator<string> {
  const base = { id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 1700000000, model: 'fake' };

  yield sseFrame({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });

  if (entry.text) {
    // Chunk the text so streaming paths are exercised.
    for (const piece of entry.text.match(/.{1,8}/gs) ?? []) {
      yield sseFrame({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
    }
  }

  for (let i = 0; i < toolCalls.length; i++) {
    const call = toolCalls[i];
    yield sseFrame({
      ...base,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: i,
            id: `call-fake-${i + 1}`,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          }],
        },
        finish_reason: null,
      }],
    });
  }

  yield sseFrame({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop' }],
  });
  yield sseFrame({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
  yield 'data: [DONE]\n\n';
}
