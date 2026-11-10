import { describe, it, expect } from 'vitest';
import { validateConfig, collectWorkerWarnings, normalizeWorkerTypes, WORKER_TYPES, type WayangConfig, type WorkerConfig } from '@/types/config';
import type { AcpProtocolConfig } from '@/types/config';
import type { AcpProtocolOverrides } from '@/services/agents/acp/base-acp-worker';

// Compile-time lock (05 §3): the config layer's AcpProtocolConfig and the
// worker layer's AcpProtocolOverrides must stay mutually assignable — these
// are two names for ONE shape; a fork here is a wiring bug. A mismatch fails
// `npm run lint` (the Expect<> aliases below), not just this suite.
type Expect<T extends true> = T;
type _ConfigShapeMatchesWorker = Expect<AcpProtocolConfig extends AcpProtocolOverrides ? true : false>;
type _WorkerShapeMatchesConfig = Expect<AcpProtocolOverrides extends AcpProtocolConfig ? true : false>;

describe('AcpProtocolConfig shape lock (05 §3)', () => {
  it('stays shape-identical to the worker layer\'s AcpProtocolOverrides (compile-time lock)', () => {
    // Runtime mirror of the type-level assertions above.
    const lock: [_ConfigShapeMatchesWorker, _WorkerShapeMatchesConfig] = [true, true];
    expect(lock).toEqual([true, true]);
  });
});

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
          // Workspace-boundary extension (issue #77) — same shape rule.
          extraWorkspaceRoots: ['/codev'],
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
    ['extraWorkspaceRoots', '/codev'],
  ])('rejects %s when it is not an array', (key, value) => {
    const err = validateConfig(makeConfigWithPermission({ [key]: value }));
    expect(err).toContain(`permission.${key} must be an array of strings`);
  });

  it.each(['allowedDirs', 'autoAllowRoots', 'sensitiveDirs', 'deniedDirs', 'extraWorkspaceRoots'])('rejects %s containing a non-string', (key) => {
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
          codebuddy: { type: 'codebuddy', description: 'Tencent CodeBuddy (ACP)' },
          opencode: { type: 'opencode', description: 'OpenCode (ACP, experimental)' },
        }),
      ),
    ).toBeNull();
  });

  it('accepts a full *-acp row: command/args/env/protocol/permissionMode', () => {
    expect(
      validateConfig(
        makeConfigWithWorkers({
          codebuddy: {
            type: 'codebuddy',
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

  it('accepts the generic acp type with a command and full ACP fields', () => {
    expect(
      validateConfig(
        makeConfigWithWorkers({
          mycli: {
            type: 'acp',
            description: 'Generic ACP CLI',
            command: 'my-cli',
            args: ['acp'],
            env: { NO_COLOR: '1' },
            protocol: { promptMs: 0 },
            permissionMode: 'client',
            trustUpdatesAfterCancel: true,
          },
        }),
      ),
    ).toBeNull();
  });

  it('rejects the generic acp type without a command, naming the field path', () => {
    const err = validateConfig(makeConfigWithWorkers({ mycli: { type: 'acp', description: 'x' } }));
    expect(err).toContain('workers.mycli.command is required for type "acp"');
  });

  it('accepts mcp.enabled=false and a positive mcp.fallbackMs on an ACP row', () => {
    expect(validateConfig(makeConfigWithWorkers({
      mycli: { type: 'acp', command: 'my-cli', description: 'x', mcp: { enabled: false, fallbackMs: 30_000 } },
    }))).toBeNull();
  });

  it.each([
    [{ enabled: 'no' }, 'mcp.enabled must be a boolean'],
    [{ fallbackMs: 0 }, 'mcp.fallbackMs must be a positive number'],
    [{ fallbackMs: -1 }, 'mcp.fallbackMs must be a positive number'],
    [{ fallbackMs: 'soon' }, 'mcp.fallbackMs must be a positive number'],
    [{ typo: true }, 'mcp.typo is not a known option'],
  ])('rejects an invalid mcp option %j', (mcp, message) => {
    const err = validateConfig(makeConfigWithWorkers({
      mycli: { type: 'acp', command: 'my-cli', description: 'x', mcp },
    } as any));
    expect(err).toContain(message);
  });

  it('rejects a non-boolean trustUpdatesAfterCancel on an ACP row', () => {
    const err = validateConfig(
      makeConfigWithWorkers({ mycli: { type: 'acp', command: 'my-cli', description: 'x', trustUpdatesAfterCancel: 'yes' } }),
    );
    expect(err).toContain('workers.mycli.trustUpdatesAfterCancel must be a boolean');
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
        codebuddy: { type: 'codebuddy', description: 'x', protocol: { [key]: value } },
      }),
    );
    expect(err).toContain(`workers.codebuddy.protocol.${key}`);
  });

  it('accepts promptMs 0 (unlimited) and positive timeouts elsewhere', () => {
    expect(
      validateConfig(
        makeConfigWithWorkers({
          opencode: { type: 'opencode', description: 'x', protocol: { promptMs: 0, permissionMs: 1 } },
        }),
      ),
    ).toBeNull();
  });

  it('rejects ACP launch fields on a claude-code row (two launch semantics must not mix)', () => {
    for (const key of ['command', 'args', 'env', 'protocol', 'mcp'] as const) {
      const value = key === 'args' ? ['--acp'] : key === 'env' || key === 'protocol' || key === 'mcp' ? {} : 'codebuddy';
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
      makeConfigWithWorkers({ codebuddy: { type: 'codebuddy', description: 'x', [key]: value } }),
    );
    expect(err).toContain(`workers.codebuddy.${key}`);
  });

  it('rejects unknown protocol.capabilities keys and non-boolean values', () => {
    const unknownKey = validateConfig(
      makeConfigWithWorkers({
        codebuddy: { type: 'codebuddy', description: 'x', protocol: { capabilities: { streaming: true } } },
      }),
    );
    expect(unknownKey).toContain('protocol.capabilities.streaming is not a known capability');
    expect(unknownKey).toContain('permissionRequests, toolCalls');

    const badValue = validateConfig(
      makeConfigWithWorkers({
        codebuddy: { type: 'codebuddy', description: 'x', protocol: { capabilities: { toolCalls: 'yes' } } },
      }),
    );
    expect(badValue).toContain('protocol.capabilities.toolCalls must be a boolean');
  });

  it('accepts a boolean protocol.gatePermissions and rejects a non-boolean one', () => {
    expect(
      validateConfig(
        makeConfigWithWorkers({
          opencode: { type: 'opencode', description: 'x', protocol: { gatePermissions: false } },
        }),
      ),
    ).toBeNull();
    const err = validateConfig(
      makeConfigWithWorkers({
        opencode: { type: 'opencode', description: 'x', protocol: { gatePermissions: 'no' } },
      }),
    );
    expect(err).toContain('workers.opencode.protocol.gatePermissions must be a boolean');
  });

  it.each([
    ['description', ''],
    ['capabilities', ['code', 7]],
    ['emoji', 42],
  ])('rejects a malformed common field %s', (key, value) => {
    const err = validateConfig(
      makeConfigWithWorkers({ codebuddy: { type: 'codebuddy', description: 'x', [key]: value } }),
    );
    expect(err).toContain(`workers.codebuddy.${key}`);
  });

  it('still validates a disabled worker (enable: false hides nothing)', () => {
    const err = validateConfig(
      makeConfigWithWorkers({ codebuddy: { type: 'codebuddy', description: 'x', enable: false, permissionMode: 'nope' } }),
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
        codebuddy: { type: 'codebuddy', description: 'x', maxTurns: 100, cliPath: '/bin/codebuddy' },
        opencode: { type: 'opencode', description: 'x', maxTurns: 50 },
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

describe('normalizeWorkerTypes (legacy type names, config-parse exit)', () => {
  it('rewrites both legacy names in place and warns once per affected row', () => {
    const config = makeConfigWithWorkers({
      cb: { type: 'codebuddy-acp', description: 'x' },
      oc: { type: 'opencode-acp', description: 'x' },
    });
    const warnings: string[] = [];
    normalizeWorkerTypes(config as WayangConfig, (m) => warnings.push(m));

    expect((config.workers!.cb as { type: string }).type).toBe('codebuddy');
    expect((config.workers!.oc as { type: string }).type).toBe('opencode');
    expect(warnings).toEqual([
      "worker type 'codebuddy-acp' is deprecated, use 'codebuddy' (workers.cb)",
      "worker type 'opencode-acp' is deprecated, use 'opencode' (workers.oc)",
    ]);
  });

  it('the rewritten config validates cleanly (old configs keep loading)', () => {
    const config = makeConfigWithWorkers({
      cb: { type: 'codebuddy-acp', description: 'x' },
      oc: { type: 'opencode-acp', description: 'x' },
    });
    normalizeWorkerTypes(config as WayangConfig, () => undefined);
    expect(validateConfig(config)).toBeNull();
  });

  it('leaves canonical names and non-worker configs untouched (no warnings)', () => {
    const config = makeConfigWithWorkers({
      cb: { type: 'codebuddy', description: 'x' },
      mycli: { type: 'acp', command: 'my-cli', description: 'x' },
      cc: { type: 'claude-code', description: 'x' },
    });
    const warnings: string[] = [];
    normalizeWorkerTypes(config as WayangConfig, (m) => warnings.push(m));
    expect(warnings).toEqual([]);
    expect((config.workers!.cb as { type: string }).type).toBe('codebuddy');
  });
});
