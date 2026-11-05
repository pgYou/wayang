/**
 * End-to-end behaviour of the controller's LLM-call logging (issue #52):
 * what actually lands in <sessionDir>/wayang.log, using a REAL SystemContext
 * (real pino + rotating sink) and a mocked LLM.
 *
 * Acceptance covered here (issue #52):
 *  - default config: a multi-turn session's wayang.log contains no full
 *    messages — only call metadata;
 *  - the full prompt appears only after WAYANG_LOG_PROMPTS=1 — and sanitized.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ControllerSignal } from '@/types/index';
import { ControllerAgent } from '@/services/agents/controller-agent';
import { ControllerAgentState } from '@/services/agents/controller-state';
import { SkillRegistry } from '@/services/skills/registry';
import { SystemContext } from '@/infra/system-context';
import { mockProvider } from '@/__tests__/helpers';
import type { WayangConfig } from '@/types/index';

// Mock model-factory / streamText to avoid real LLM calls.
vi.mock('../model-factory.js', () => ({
  createModel: () => ({}),
}));
vi.mock('ai', () => ({
  streamText: vi.fn(),
  generateText: vi.fn(),
  stepCountIs: vi.fn((n: number) => n),
  hasToolCall: vi.fn((name: string) => name),
}));
import { streamText } from 'ai';

const config: WayangConfig = {
  providers: {
    default: { endpoint: 'http://localhost:1', apiKey: 'test-key', modelName: 'test-model' },
  },
  controller: { provider: 'default' },
  worker: { provider: 'default', maxConcurrency: 1 },
};

const PROMPT_MARKER = 'USER-PROMPT-MARKER-9d3f-do-not-log';
const SECRET_IN_PROMPT = 'apiKey=sk-test-0123456789abcdef';

function mockStreamResponse(text: string) {
  vi.mocked(streamText).mockReturnValue({
    textStream: (async function* () {
      yield text;
    })(),
    text: Promise.resolve(text),
    reasoningText: Promise.resolve(undefined),
    toolResults: Promise.resolve([]),
    usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
    finishReason: Promise.resolve('stop'),
    steps: Promise.resolve([]),
  } as any);
}

function inputSignal(id: string, text: string): ControllerSignal {
  return {
    id,
    source: 'user',
    type: 'input',
    payload: { text },
    timestamp: Date.now(),
    status: 'unread',
  };
}

/** One controller turn inside a fresh real session directory. */
async function runTurn(sessionDir: string, logLevel: string, promptText: string): Promise<string> {
  const ctx = new SystemContext(config, 's', sessionDir, sessionDir, logLevel);
  const state = new ControllerAgentState(ctx);
  const agent = new ControllerAgent(ctx, state, mockProvider, {}, new SkillRegistry([]));
  mockStreamResponse('mock answer');
  await agent.run([inputSignal('sig-log-1', promptText)]);
  await ctx.closeLogger();
  const logPath = join(sessionDir, 'wayang.log');
  return existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
}

let topDir: string;

beforeEach(() => {
  topDir = mkdtempSync(join(tmpdir(), 'wayang-ctrl-log-'));
  mockStreamResponse('mock answer');
});

afterEach(() => {
  rmSync(topDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  delete process.env.WAYANG_LOG_PROMPTS;
});

describe('controller LLM call logging (issue #52)', () => {
  it('default level logs metadata only — no prompt content in wayang.log', async () => {
    const log = await runTurn(join(topDir, 's1'), 'info', `${PROMPT_MARKER} ${SECRET_IN_PROMPT}`);

    expect(log).toContain('LLM call done');
    expect(log).not.toContain('LLM call start');
    expect(log).not.toContain(PROMPT_MARKER);
    expect(log).not.toContain('sk-test-');
  });

  it('debug level logs the call metadata but still no message content', async () => {
    const log = await runTurn(join(topDir, 's2'), 'debug', `${PROMPT_MARKER} ${SECRET_IN_PROMPT}`);

    expect(log).toContain('LLM call start');
    expect(log).toContain('messageCount');
    expect(log).toContain('estimatedTokens');
    expect(log).not.toContain(PROMPT_MARKER);
    expect(log).not.toContain('sk-test-');
  });

  it('WAYANG_LOG_PROMPTS=1 logs the full prompt, sanitized', async () => {
    vi.stubEnv('WAYANG_LOG_PROMPTS', '1');
    const log = await runTurn(join(topDir, 's3'), 'debug', `${PROMPT_MARKER} ${SECRET_IN_PROMPT}`);

    expect(log).toContain('LLM call start');
    // The full prompt is there — but the credential is not.
    expect(log).toContain(PROMPT_MARKER);
    expect(log).not.toContain('sk-test-0123456789abcdef');
    expect(log).toContain('[REDACTED]');
  });

  it('a long conversation still keeps each debug line small without the switch', async () => {
    // Regression shape of the 41MB log: the same history re-dumped per call.
    // Simulate a fat context by running several turns and checking that the
    // per-call debug line stays metadata-sized.
    const sessionDir = join(topDir, 's4');
    const ctx = new SystemContext(config, 's', sessionDir, sessionDir, 'debug');
    const state = new ControllerAgentState(ctx);
    const agent = new ControllerAgent(ctx, state, mockProvider, {}, new SkillRegistry([]));
    for (let i = 0; i < 4; i++) {
      mockStreamResponse(`answer ${i}`);
      await agent.run([inputSignal(`sig-log-multi-${i}`, `${PROMPT_MARKER} round ${i}`)]);
    }
    await ctx.closeLogger();

    const log = readFileSync(join(sessionDir, 'wayang.log'), 'utf8');
    const startLines = log.split('\n').filter((l) => l.includes('LLM call start'));
    expect(startLines).toHaveLength(4);
    // Each line is metadata-sized (hundreds of bytes, not context-sized).
    for (const line of startLines) {
      expect(line.length).toBeLessThan(400);
      expect(line).not.toContain(PROMPT_MARKER);
    }
    // And the file as a whole stayed tiny: 4 turns of metadata.
    expect(Buffer.byteLength(log, 'utf8')).toBeLessThan(16 * 1024);
  });
});
