/**
 * connectRemoteServer — server child spawn + RPC handshake.
 *
 * Verifies the spawn contract from the client side: `--home-dir` must be
 * forwarded as-is (ROOT semantics — the server joins `.wayang` itself),
 * `--session` formatting, ready handshake, and the failure path when the
 * server dies before becoming ready.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';
import { connectRemoteServer } from '@/client/connect';
import { METHOD, NOTIFY } from '@/rpc/protocol';

// --- Fake child process ---

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn();
  return child;
}

/** Answer RPC requests written to stdin; shutdown responses exit the child. */
function serveRpc(child: FakeChild): void {
  let buffer = '';
  child.stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf-8');
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as { id: number; method: string };
      if (msg.method === METHOD.SHUTDOWN) {
        child.stdout.write(`${JSON.stringify({ id: msg.id, result: {} })}\n`);
        child.emit('exit', 0);
      }
    }
  });
}

// --- Setup ---

const FAKE_ENTRY = '/fake/wayang/dist/cli.js';
let originalArgv1: string;
let child: FakeChild;

beforeEach(() => {
  vi.mocked(spawn).mockReset();
  child = makeFakeChild();
  vi.mocked(spawn).mockReturnValue(child as never);
  originalArgv1 = process.argv[1];
  process.argv[1] = FAKE_ENTRY;
});

afterEach(() => {
  process.argv[1] = originalArgv1;
  vi.mocked(spawn).mockRestore();
});

function connect(options: Partial<Parameters<typeof connectRemoteServer>[0]> = {}) {
  return connectRemoteServer({
    configPath: '/fake/config.json',
    homeDir: '/fake/root',
    workspaceDir: '/fake/workspace',
    session: 'new',
    readyTimeoutMs: 1_000,
    ...options,
  });
}

// --- Tests ---

describe('connectRemoteServer — spawn contract', () => {
  it('forwards --home-dir as-is (ROOT semantics, no .wayang join) and formats resume session', async () => {
    serveRpc(child);
    const pending = connect({ session: { resume: '20260101-000000' }, logLevel: 'debug' });

    // Server becomes ready via the RPC ready notification.
    child.stdout.write(`${JSON.stringify({ method: NOTIFY.READY, params: {} })}\n`);
    const connection = await pending;

    expect(spawn).toHaveBeenCalledOnce();
    const [execPath, args] = vi.mocked(spawn).mock.calls[0];
    expect(execPath).toBe(process.execPath);
    expect(args).toEqual([
      FAKE_ENTRY,
      'server',
      '--config', '/fake/config.json',
      // Regression guard: the root is passed verbatim; the server joins
      // `.wayang` itself. Pre-joining here caused a double join server-side.
      '--home-dir', '/fake/root',
      '--workspace-dir', '/fake/workspace',
      '--session', 'resume:20260101-000000',
      '--log-level', 'debug',
    ]);

    // Graceful stop: shutdown request → response → clean exit, no force-kill.
    await connection.stop();
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
  });

  it('spawns with "--session new" for a new session and omits optional flags when unset', async () => {
    serveRpc(child);
    const pending = connect();

    child.stdout.write(`${JSON.stringify({ method: NOTIFY.READY, params: {} })}\n`);
    const connection = await pending;

    const args = vi.mocked(spawn).mock.calls[0][1];
    expect(args).toContain('--session');
    expect(args[args.indexOf('--session') + 1]).toBe('new');
    expect(args).not.toContain('--log-level');
    expect(args).not.toContain('--inject-previous-tasks');

    await connection.stop();
  });

  it('passes --inject-previous-tasks when requested', async () => {
    serveRpc(child);
    const pending = connect({ injectPreviousTasks: true });

    child.stdout.write(`${JSON.stringify({ method: NOTIFY.READY, params: {} })}\n`);
    const connection = await pending;

    const args = vi.mocked(spawn).mock.calls[0][1];
    expect(args).toContain('--inject-previous-tasks');

    await connection.stop();
  });
});

describe('connectRemoteServer — failure paths', () => {
  it('rejects with exit code and stderr tail when the server dies before ready', async () => {
    const pending = connect({ readyTimeoutMs: 500 });

    child.stderr.write('Fatal: Session "20260101-000000" not found.');
    // Let the stderr data event flush before the process dies (mirrors a real
    // fatal that prints its message before exiting).
    await new Promise((r) => setImmediate(r));
    child.emit('exit', 1);

    await expect(pending).rejects.toThrow(
      'Wayang server exited before becoming ready (code 1).\nFatal: Session "20260101-000000" not found.',
    );
  });
});
