import { describe, it, expect } from 'vitest';
import { validateConfig, collectWorkerWarnings, WORKER_TYPES, type WayangConfig, type WorkerConfig } from '@/types/config';

/** Fresh minimal valid config per call — no shared mutable fixture. */
function makeConfig(contextWindowTokens?: unknown): WayangConfig {
  return {
    providers: {
      p: {
        endpoint: 'http://localhost',
        apiKey: 'k',
        modelName: 'm',
        ...(contextWindowTokens !== undefined && { contextWindowTokens: contextWindowTokens as number }),
      },
    },
    controller: { provider: 'p' },
    worker: { provider: 'p', maxConcurrency: 1 },
  };
}

describe('validateConfig: contextWindowTokens', () => {
  it('accepts an omitted or positive integer window', () => {
    expect(validateConfig(makeConfig())).toBeNull();
    expect(validateConfig(makeConfig(128_000))).toBeNull();
  });

  it.each([0, -1, 1.5, Number.NaN, '128000'])('rejects %s', (bad) => {
    const err = validateConfig(makeConfig(bad));
    expect(err).toContain('providers.p.contextWindowTokens must be a positive integer');
  });
});

/** Same minimal valid config, plus a deliberately loosely-typed permission section. */
function makeConfigWithPermission(permission: unknown): WayangConfig {
  return { ...makeConfig(), permission: permission as WayangConfig['permission'] };
}

describe('validateConfig: permission', () => {
  it('accepts an omitted permission section (existing configs unaffected)', () => {
    expect(validateConfig(makeConfig())).toBeNull();
  });

  it('accepts each field as an array of strings', () => {
    expect(
      validateConfig(
        makeConfigWithPermission({
          allowedDirs: ['/data/shared'],
          autoAllowRoots: ['/tmp'],
          sensitiveDirs: ['/data/keys'],
          // Deprecated alias of sensitiveDirs — still accepted and validated.
          deniedDirs: ['/data/secrets'],
          sensitiveMode: 'deny',
        }),
      ),
    ).toBeNull();
    expect(validateConfig(makeConfigWithPermission({}))).toBeNull();
  });

  it.each([
    ['allowedDirs', '/data/shared'],
    ['autoAllowRoots', 42],
    ['sensitiveDirs', { path: '/data/keys' }],
    ['deniedDirs', { path: '/data/secrets' }],
  ])('rejects %s when it is not an array', (key, value) => {
    const err = validateConfig(makeConfigWithPermission({ [key]: value }));
    expect(err).toContain(`permission.${key} must be an array of strings`);
  });

  it.each(['allowedDirs', 'autoAllowRoots', 'sensitiveDirs', 'deniedDirs'])('rejects %s containing a non-string', (key) => {
    const err = validateConfig(makeConfigWithPermission({ [key]: ['/data/shared', 7] }));
    expect(err).toContain(`permission.${key} must be an array of strings`);
    expect(err).toContain('7');
  });
});

/** Same minimal valid config, plus a `workers` section (loosely typed: the validator sees raw JSON). */
function makeConfigWithWorkers(workers: Record<string, unknown>): WayangConfig {
  return { ...makeConfig(), workers: workers as Record<string, WorkerConfig> };
}

describe('validateConfig: workers section (05 §5)', () => {
  it('accepts both new ACP worker types with a minimal row (command optional — provider default)', () => {
    expect(
      validateConfig(
        makeConfigWithWorkers({
          codebuddy: { type: 'codebuddy-acp', description: 'Tencent CodeBuddy (ACP)' },
          opencode: { type: 'opencode-acp', description: 'OpenCode (ACP, experimental)' },
        }),
      ),
    ).toBeNull();
  });

  it('accepts a full *-acp row: command/args/env/protocol/permissionMode', () => {
    expect(
      validateConfig(
        makeConfigWithWorkers({
          codebuddy: {
            type: 'codebuddy-acp',
            description: 'CodeBuddy',
            command: '/usr/local/bin/codebuddy',
            args: ['--acp'],
            env: { NO_COLOR: '1' },
            protocol: { handshakeMs: 20000, promptMs: 0, capabilities: { permissionRequests: true } },
            permissionMode: 'agent',
          },
        }),
      ),
    ).toBeNull();
  });

  it('rejects an unknown type and lists every allowed value', () => {
    const err = validateConfig(makeConfigWithWorkers({ bad: { type: 'gemini-acp', description: 'x' } }));
    expect(err).toContain('workers.bad.type "gemini-acp" is not supported');
    for (const allowed of WORKER_TYPES) {
      expect(err).toContain(allowed);
    }
  });

  it('rejects a missing type with the allowed list', () => {
    const err = validateConfig(makeConfigWithWorkers({ bad: { description: 'x' } }));
    expect(err).toContain('workers.bad.type is required');
    expect(err).toContain(WORKER_TYPES.join(', '));
  });

  it("rejects 'puppet' declared under workers with the built-in hint", () => {
    const err = validateConfig(makeConfigWithWorkers({ p: { type: 'puppet', description: 'x' } }));
    expect(err).toContain('puppet is a built-in worker type, do not declare it under workers');
  });

  it.each([
    ['handshakeMs', 0],
    ['handshakeMs', -1],
    ['sessionNewMs', 0],
    ['promptMs', -1],
    ['permissionMs', 0],
    ['cancelGraceMs', -5],
    ['sigtermWaitMs', 0],
  ])('rejects non-positive protocol.%s = %s (promptMs only allows >= 0)', (key, value) => {
    const err = validateConfig(
      makeConfigWithWorkers({
        codebuddy: { type: 'codebuddy-acp', description: 'x', protocol: { [key]: value } },
      }),
    );
    expect(err).toContain(`workers.codebuddy.protocol.${key}`);
  });

  it('accepts promptMs 0 (unlimited) and positive timeouts elsewhere', () => {
    expect(
      validateConfig(
        makeConfigWithWorkers({
          opencode: { type: 'opencode-acp', description: 'x', protocol: { promptMs: 0, permissionMs: 1 } },
        }),
      ),
    ).toBeNull();
  });

  it('rejects ACP launch fields on a claude-code row (two launch semantics must not mix)', () => {
    for (const key of ['command', 'args', 'env', 'protocol'] as const) {
      const value = key === 'args' ? ['--acp'] : key === 'env' ? {} : key === 'protocol' ? {} : 'codebuddy';
      const err = validateConfig(
        makeConfigWithWorkers({ cc: { type: 'claude-code', description: 'x', [key]: value } }),
      );
      expect(err).toContain(`workers.cc.${key} is not supported for type "claude-code"`);
      expect(err).toContain('claude-code uses cliPath');
    }
  });

  it.each([
    ['command', ''],
    ['args', ['--acp', 7]],
    ['env', { NO_COLOR: 1 }],
    ['permissionMode', 'auto'],
  ])('rejects a malformed *-acp %s', (key, value) => {
    const err = validateConfig(
      makeConfigWithWorkers({ codebuddy: { type: 'codebuddy-acp', description: 'x', [key]: value } }),
    );
    expect(err).toContain(`workers.codebuddy.${key}`);
  });

  it('rejects unknown protocol.capabilities keys and non-boolean values', () => {
    const unknownKey = validateConfig(
      makeConfigWithWorkers({
        codebuddy: { type: 'codebuddy-acp', description: 'x', protocol: { capabilities: { streaming: true } } },
      }),
    );
    expect(unknownKey).toContain('protocol.capabilities.streaming is not a known capability');
    expect(unknownKey).toContain('permissionRequests, toolCalls');

    const badValue = validateConfig(
      makeConfigWithWorkers({
        codebuddy: { type: 'codebuddy-acp', description: 'x', protocol: { capabilities: { toolCalls: 'yes' } } },
      }),
    );
    expect(badValue).toContain('protocol.capabilities.toolCalls must be a boolean');
  });

  it.each([
    ['description', ''],
    ['capabilities', ['code', 7]],
    ['emoji', 42],
  ])('rejects a malformed common field %s', (key, value) => {
    const err = validateConfig(
      makeConfigWithWorkers({ codebuddy: { type: 'codebuddy-acp', description: 'x', [key]: value } }),
    );
    expect(err).toContain(`workers.codebuddy.${key}`);
  });

  it('still validates a disabled worker (enable: false hides nothing)', () => {
    const err = validateConfig(
      makeConfigWithWorkers({ codebuddy: { type: 'codebuddy-acp', description: 'x', enable: false, permissionMode: 'nope' } }),
    );
    expect(err).toContain('workers.codebuddy.permissionMode');
  });

  it('leaves claude-code rows valid without any ACP fields (existing configs unaffected)', () => {
    expect(
      validateConfig(
        makeConfigWithWorkers({
          'claude-code': { type: 'claude-code', description: 'Coding assistant', cliPath: '/usr/bin/claude', maxTurns: 500 },
        }),
      ),
    ).toBeNull();
  });
});

describe('collectWorkerWarnings (05 §4: inert fields warn, never fail)', () => {
  it('warns about maxTurns and cliPath on *-acp rows', () => {
    const warnings = collectWorkerWarnings(
      makeConfigWithWorkers({
        codebuddy: { type: 'codebuddy-acp', description: 'x', maxTurns: 100, cliPath: '/bin/codebuddy' },
        opencode: { type: 'opencode-acp', description: 'x', maxTurns: 50 },
      }) as WayangConfig,
    );
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('workers.codebuddy.maxTurns has no effect');
    expect(warnings[1]).toContain('workers.codebuddy.cliPath has no effect');
    expect(warnings[2]).toContain('workers.opencode.maxTurns has no effect');
  });

  it('is silent for claude-code rows and configs without workers', () => {
    expect(
      collectWorkerWarnings(
        makeConfigWithWorkers({
          'claude-code': { type: 'claude-code', description: 'x', maxTurns: 100, cliPath: '/bin/claude' },
        }) as WayangConfig,
      ),
    ).toEqual([]);
    expect(collectWorkerWarnings(makeConfig())).toEqual([]);
  });
});
