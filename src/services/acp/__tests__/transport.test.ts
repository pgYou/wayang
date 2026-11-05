import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ACP_TIMEOUTS, type AcpLaunchConfig } from '@/services/acp/config';
import { AcpError } from '@/services/acp/errors';
import type { AcpExitInfo } from '@/services/acp/types';
import { StdioAcpTransport } from '@/services/acp/transport';

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

/** Scratch root inside the task workspace (AGENTS.md: never /tmp for artifacts). */
const scratchRoot = join(process.cwd(), '.agents', 'tmp', 'acp-transport-tests');

let scratchDir: string;

beforeEach(() => {
  mkdirSync(scratchRoot, { recursive: true });
  scratchDir = mkdtempSync(join(scratchRoot, 'run-'));
});

afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

// Root can execute anything, so permission-based spawn failures don't reproduce.
const itNonRoot = process.getuid?.() === 0 ? it.skip : it;

const nodeAgentConfig = (fixtureArgs: string[], overrides: Partial<AcpLaunchConfig> = {}): AcpLaunchConfig => ({
  command: process.execPath,
  args: fixtureArgs,
  env: { ...process.env } as Record<string, string>,
  cwd: scratchDir,
  timeouts: { ...DEFAULT_ACP_TIMEOUTS },
  ...overrides,
});

const nextMessage = (transport: StdioAcpTransport, filter?: (line: string) => boolean): Promise<string> =>
  new Promise((resolve) => {
    const unsubscribe = transport.onMessage((line) => {
      if (filter && !filter(line)) return;
      unsubscribe();
      resolve(line);
    });
  });

const nextClose = (transport: StdioAcpTransport): Promise<AcpExitInfo> =>
  new Promise((resolve) => transport.onClose((info) => resolve(info)));

describe('StdioAcpTransport.start', () => {
  it('spawns and surfaces the agent opening line, with env passed through', async () => {
    const transport = new StdioAcpTransport(
      nodeAgentConfig([fixture('echo-agent.mjs')], {
        env: { ...process.env, ACP_TEST_MARKER: 'marker-42' } as Record<string, string>,
      }),
    );
    await transport.start();
    expect(typeof transport.pid).toBe('number');
    const line = await nextMessage(transport);
    expect(JSON.parse(line)).toEqual({ ready: true, marker: 'marker-42' });
    await transport.close({ sigtermWaitMs: 2_000, reason: 'shutdown' });
  });

  it('is idempotent when called twice after success', async () => {
    const transport = new StdioAcpTransport(nodeAgentConfig([fixture('echo-agent.mjs')]));
    await transport.start();
    await expect(transport.start()).resolves.toBeUndefined();
    await transport.close({ sigtermWaitMs: 2_000, reason: 'shutdown' });
  });

  it('maps ENOENT to AcpError(cli-missing)', async () => {
    const transport = new StdioAcpTransport(nodeAgentConfig([], { command: 'wayang-no-such-command-xyz' }));
    await expect(transport.start()).rejects.toMatchObject({ code: 'cli-missing' });
  });

  itNonRoot('maps EACCES (non-executable file) to AcpError(cli-missing)', async () => {
    const noExec = join(scratchDir, 'no-exec.sh');
    writeFileSync(noExec, 'echo hi\n', { mode: 0o644 });
    const transport = new StdioAcpTransport(nodeAgentConfig([], { command: noExec }));
    await expect(transport.start()).rejects.toMatchObject({ code: 'cli-missing' });
  });

  // NOTE: ENOEXEC is not observable through node spawn on glibc: execvp
  // falls back to /bin/sh for ENOEXEC, so the spawn succeeds. The mapping
  // stays in code (frozen §2.2) for platforms without that fallback.
});

describe('StdioAcpTransport.write', () => {
  it('round-trips lines through the real pipe (newline appended)', async () => {
    const transport = new StdioAcpTransport(nodeAgentConfig([fixture('echo-agent.mjs')]));
    await transport.start();
    await nextMessage(transport); // opening line
    const echoed = nextMessage(transport, (line) => line.startsWith('echo:'));
    transport.write('{"jsonrpc":"2.0","id":1}');
    expect(await echoed).toBe('echo:{"jsonrpc":"2.0","id":1}');
    await transport.close({ sigtermWaitMs: 2_000, reason: 'shutdown' });
  });

  it('is a counted no-op after close', async () => {
    const transport = new StdioAcpTransport(nodeAgentConfig([fixture('echo-agent.mjs')]));
    await transport.start();
    await transport.close({ sigtermWaitMs: 2_000, reason: 'shutdown' });
    expect(() => transport.write('late')).not.toThrow();
    expect(transport.stats.writesAfterClose).toBe(1);
  });
});

describe('StdioAcpTransport exit handling', () => {
  it('settles a natural exit once as crash with a 50-line stderr tail', async () => {
    const transport = new StdioAcpTransport(nodeAgentConfig([fixture('exit-agent.mjs'), '3', '60']));
    await transport.start();
    const info = await nextClose(transport);
    expect(info).toMatchObject({ code: 3, signal: null, reason: 'crash', cancelled: false });
    const tail = transport.stderrTail();
    expect(tail).toHaveLength(50);
    expect(tail[tail.length - 1]).toBe('stderr line 60 of 60');
    // Writes after exit are counted no-ops; close() after natural exit returns the recorded info.
    transport.write('late');
    expect(transport.stats.writesAfterClose).toBe(1);
    const again = await transport.close({ sigtermWaitMs: 2_000, reason: 'shutdown' });
    expect(again).toBe(info);
  });

  it('emits onClose exactly once (exit/error double arrival settles once)', async () => {
    const transport = new StdioAcpTransport(nodeAgentConfig([fixture('exit-agent.mjs'), '0']));
    await transport.start();
    let closeEvents = 0;
    let lastInfo: AcpExitInfo | null = null;
    transport.onClose((info) => {
      closeEvents += 1;
      lastInfo = info;
    });
    await nextClose(transport);
    await transport.close({ sigtermWaitMs: 2_000, reason: 'shutdown' });
    await transport.close({ sigtermWaitMs: 2_000, reason: 'cancel' });
    expect(closeEvents).toBe(1);
    expect(lastInfo).toMatchObject({ reason: 'crash' });
  });

  it('captures stderr even when the process exits 0', async () => {
    const transport = new StdioAcpTransport(nodeAgentConfig([fixture('exit-agent.mjs'), '0', '2']));
    await transport.start();
    const info = await nextClose(transport);
    expect(info).toMatchObject({ code: 0, reason: 'crash' });
    expect(transport.stderrTail()).toEqual(['stderr line 1 of 2', 'stderr line 2 of 2']);
  });
});

describe('StdioAcpTransport close / kill ladder', () => {
  it('SIGTERM is enough for a well-behaved agent (reason cancel)', async () => {
    const transport = new StdioAcpTransport(nodeAgentConfig([fixture('echo-agent.mjs')]));
    await transport.start();
    const info = await transport.close({ sigtermWaitMs: 2_000, reason: 'cancel' });
    expect(info).toMatchObject({ signal: 'SIGTERM', reason: 'cancel', cancelled: true });
    expect(transport.stats.sigkillEscalations).toBe(0);
  });

  it('escalates to SIGKILL after sigtermWaitMs when SIGTERM is ignored', async () => {
    const transport = new StdioAcpTransport(nodeAgentConfig([fixture('ignore-sigterm.mjs')]));
    await transport.start();
    // Wait for the fixture's readiness line so the SIGTERM handler is
    // registered before the ladder starts (no boot race).
    expect(await nextMessage(transport)).toBe('ready');
    const info = await transport.close({ sigtermWaitMs: 150, reason: 'cancel' });
    expect(info).toMatchObject({ code: null, signal: 'SIGKILL', reason: 'cancel', cancelled: true });
    expect(transport.stats.sigtermKills).toBe(1);
    expect(transport.stats.sigkillEscalations).toBe(1);
  }, 10_000);

  it('close() before start() settles with synthetic info', async () => {
    const transport = new StdioAcpTransport(nodeAgentConfig([fixture('echo-agent.mjs')]));
    const info = await transport.close({ sigtermWaitMs: 100, reason: 'shutdown' });
    expect(info).toEqual({ code: null, signal: null, reason: 'shutdown', cancelled: false });
    await expect(transport.start()).rejects.toMatchObject({ code: 'transport-closed' });
  });
});

describe('StdioAcpTransport framing guard', () => {
  it('rejects an oversized stdout line as protocol-mismatch and kills the process', async () => {
    const transport = new StdioAcpTransport(
      nodeAgentConfig([fixture('big-line-agent.mjs'), String(256 * 1024)], { maxLineBytes: 64 * 1024 }),
    );
    const errored = new Promise<AcpError>((resolve) => transport.onError((err) => resolve(err as AcpError)));
    const closed = nextClose(transport);
    await transport.start();
    const err = await errored;
    expect(err).toBeInstanceOf(AcpError);
    expect(err.code).toBe('protocol-mismatch');
    expect(transport.stats.framingErrors).toBe(1);
    const info = await closed;
    expect(info).toMatchObject({ reason: 'crash', cancelled: false });
    expect(typeof info.signal).toBe('string');
  }, 10_000);
});
