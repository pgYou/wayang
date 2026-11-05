import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import pino from 'pino';
import { homedir } from 'node:os';
import {
  buildLlmCallStartPayload,
  debugLoggingEnabled,
  promptsLoggingEnabled,
  sanitizeForLog,
  sanitizeTextForLog,
} from '@/services/agents/utils/llm-call-logging';
import type { ModelMessage } from 'ai';

beforeEach(() => {
  vi.stubEnv('WAYANG_LOG_PROMPTS', '');
  delete process.env.WAYANG_LOG_PROMPTS;
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.WAYANG_LOG_PROMPTS;
});

const messages: ModelMessage[] = [
  { role: 'user', content: `please read ${homedir()}/project/README.md` },
  { role: 'assistant', content: 'opening the file with apiKey: sk-ant-0123456789abcdef' },
  {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: 'tc1', toolName: 'read_file', output: { type: 'text', value: 'file body' } }],
  },
];

describe('promptsLoggingEnabled', () => {
  it('is off by default and accepts 1/true (case-insensitive)', () => {
    delete process.env.WAYANG_LOG_PROMPTS;
    expect(promptsLoggingEnabled()).toBe(false);

    process.env.WAYANG_LOG_PROMPTS = '0';
    expect(promptsLoggingEnabled()).toBe(false);

    process.env.WAYANG_LOG_PROMPTS = '1';
    expect(promptsLoggingEnabled()).toBe(true);

    process.env.WAYANG_LOG_PROMPTS = 'TRUE';
    expect(promptsLoggingEnabled()).toBe(true);
  });
});

describe('debugLoggingEnabled', () => {
  it('reflects the real pino level', () => {
    expect(debugLoggingEnabled(pino({ level: 'info' }))).toBe(false);
    expect(debugLoggingEnabled(pino({ level: 'debug' }))).toBe(true);
  });

  it('treats loggers without the level helper (test doubles) as enabled', () => {
    expect(debugLoggingEnabled({ debug: () => {} } as never)).toBe(true);
  });
});

describe('buildLlmCallStartPayload (default: metadata only)', () => {
  it('carries model, message count and a token estimate — no message content', () => {
    const payload = buildLlmCallStartPayload(messages, 3, 'test-model');

    expect(payload).toMatchObject({ agent: 'controller', model: 'test-model', messageCount: 3 });
    expect(typeof payload.estimatedTokens).toBe('number');
    expect(payload.estimatedTokens).toBeGreaterThan(0);
    // No prompt text leaks into the default payload.
    expect(payload.messages).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('README.md');
    expect(JSON.stringify(payload)).not.toContain('file body');
    expect(JSON.stringify(payload)).not.toContain('sk-ant-');
  });

  it('estimates tokens for string and part-array content alike', () => {
    const withParts: ModelMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'abc' },
          { type: 'tool-call', toolCallId: 't', toolName: 'bash', input: { command: 'ls' } },
        ],
      },
    ];
    const payload = buildLlmCallStartPayload(withParts, 1, 'm');
    expect(payload.estimatedTokens).toBeGreaterThan(0);
  });
});

describe('buildLlmCallStartPayload (WAYANG_LOG_PROMPTS=1)', () => {
  it('adds the full sanitized messages', () => {
    process.env.WAYANG_LOG_PROMPTS = '1';
    const payload = buildLlmCallStartPayload(messages, 3, 'test-model');

    expect(Array.isArray(payload.messages)).toBe(true);
    const dumped = JSON.stringify(payload.messages);
    // Structure survives…
    expect(dumped).toContain('please read');
    expect(dumped).toContain('file body');
    // …but secrets and the absolute home path do not.
    expect(dumped).not.toContain('sk-ant-0123456789abcdef');
    expect(dumped).toContain('apiKey: [REDACTED]');
    expect(dumped).not.toContain(`${homedir()}/project`);
    expect(dumped).toContain('~/project/README.md');
  });

  it('is not enabled by the switch alone when the env is unset', () => {
    delete process.env.WAYANG_LOG_PROMPTS;
    expect(buildLlmCallStartPayload(messages, 3, 'm').messages).toBeUndefined();
  });
});

describe('sanitizeTextForLog', () => {
  const home = '/home/tester';

  it('collapses the home directory to ~', () => {
    expect(sanitizeTextForLog(`cat /home/tester/code/main.go && cat /home/tester/x`, home))
      .toBe('cat ~/code/main.go && cat ~/x');
  });

  it('redacts labeled credentials, keeping the key name', () => {
    expect(sanitizeTextForLog('apiKey: sk-ant-0123456789abcdef', home)).toBe('apiKey: [REDACTED]');
    expect(sanitizeTextForLog('"api_key":"sk-ant-0123456789abcdef"', home)).toBe('"api_key":"[REDACTED]"');
    expect(sanitizeTextForLog('token=ghp_0123456789abcdef0123', home)).toBe('token=[REDACTED]');
    expect(sanitizeTextForLog('password=hunter-secret-2', home)).toBe('password=[REDACTED]');
    expect(sanitizeTextForLog('Authorization: Bearer eyJhbGciOi.payload.sig', home))
      .toBe('Authorization: Bearer [REDACTED]');
    expect(sanitizeTextForLog('Authorization: Basic dXNlcjpwYXNz', home))
      .toBe('Authorization: Basic [REDACTED]');
  });

  it('redacts bare provider key material with no label', () => {
    expect(sanitizeTextForLog('leaked sk-ant-0123456789abcdef in output', home))
      .toBe('leaked [REDACTED] in output');
    expect(sanitizeTextForLog('key tvly-0123456789abcdef', home)).toBe('key [REDACTED]');
    expect(sanitizeTextForLog('AKIAIOSFODNN7EXAMPLE', home)).toBe('[REDACTED]');
  });

  it('leaves ordinary token-count fields alone', () => {
    expect(sanitizeTextForLog('maxTokens: 4096, outputTokens: 120', home))
      .toBe('maxTokens: 4096, outputTokens: 120');
  });
});

describe('sanitizeForLog (deep walk)', () => {
  const home = '/home/tester';

  it('sanitizes strings nested in arrays and objects, keeps other types', () => {
    const input = {
      role: 'user',
      content: [
        { type: 'text', text: 'path /home/tester/x and apiKey: sk-ant-0123456789abcdef' },
        { type: 'tool-call', input: { env: { TOKEN: 'abcdef123456' }, count: 3, ok: true } },
      ],
    };
    const out = sanitizeForLog(input, home, new Set()) as typeof input;
    expect(out.content[0]!.text).toBe('path ~/x and apiKey: [REDACTED]');
    const env = ((out.content[1] as { input: { env: Record<string, unknown> } }).input).env;
    expect(env.TOKEN).toBe('[REDACTED]');
    const toolInput = out.content[1] as { input: { count: number; ok: boolean } };
    expect(toolInput.input.count).toBe(3);
    expect(toolInput.input.ok).toBe(true);
  });

  it('is cycle-safe', () => {
    const a: Record<string, unknown> = { name: '/home/tester/n' };
    a.self = a;
    const out = sanitizeForLog(a, home, new Set()) as Record<string, unknown>;
    expect(out.name).toBe('~/n');
    expect(out.self).toBe('[Circular]');
  });
});
