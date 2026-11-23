// run_process: structured argv execution — no shell interpretation, timeout
// kill (SIGTERM → SIGKILL), per-stream output caps, background mode with a
// log file, and structured spawn errors.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runProcessTool } from '@/services/tools/run-process';

/** Helper to call a defineTool's execute function. */
async function exec(toolLike: any, args: Record<string, unknown>): Promise<string> {
  return toolLike.execute(args);
}

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'wayang-run-process-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('run_process argv semantics', () => {
  it('no shell is involved: metacharacters arrive at the program literally', async () => {
    const out = await exec(runProcessTool({ cwd }), {
      command: ['echo', '$HOME; rm -rf / && `whoami`'],
    });
    const result = JSON.parse(out);
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    // A shell would have expanded/interpolated; the raw text proves it did not.
    expect(result.stdout).toBe('$HOME; rm -rf / && `whoami`\n');
  });

  it('env entries reach the child; a non-zero exit code is reported', async () => {
    const out = await exec(runProcessTool({ cwd }), {
      command: [process.execPath, '-e', 'console.log(process.env.RUN_PROC_TEST); process.exit(3);'],
      env: { RUN_PROC_TEST: 'injected-value' },
    });
    const result = JSON.parse(out);
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe('injected-value\n');
  });

  it('cwd resolves inside the workspace and must be a directory', async () => {
    mkdirSync(join(cwd, 'sub'), { recursive: true });
    const ok = await exec(runProcessTool({ cwd }), { command: ['echo', 'in-subdir'], cwd: 'sub' });
    expect(JSON.parse(ok).stdout).toBe('in-subdir\n');

    writeFileSync(join(cwd, 'a-file'), 'x', 'utf-8');
    const bad = await exec(runProcessTool({ cwd }), { command: ['echo', 'hi'], cwd: 'a-file' });
    expect(bad).toContain('[ERROR] run_process: cwd is not a directory');
  });

  it('a missing executable returns a structured error instead of throwing', async () => {
    const out = await exec(runProcessTool({ cwd }), { command: ['no-such-executable-xyz', '--flag'] });
    const result = JSON.parse(out);
    expect(result.exitCode).toBeNull();
    expect(result.error).toContain('no-such-executable-xyz');
  });
});

describe('run_process timeout', () => {
  it('a foreground timeout kills the process with SIGTERM and reports it', async () => {
    const out = await exec(runProcessTool({ cwd }), { command: ['sleep', '30'], timeoutMs: 300 });
    const result = JSON.parse(out);
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe('SIGTERM');
    expect(result.exitCode).toBeNull();
    expect(result.durationMs).toBeGreaterThanOrEqual(300);
    expect(result.durationMs).toBeLessThan(10_000);
  });

  it('a process that traps SIGTERM is SIGKILLed after the 3s grace', async () => {
    const out = await exec(runProcessTool({ cwd }), {
      command: [process.execPath, '-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
      timeoutMs: 200,
    });
    const result = JSON.parse(out);
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe('SIGKILL');
    // 200ms timeout + 3000ms grace before the SIGKILL lands.
    expect(result.durationMs).toBeGreaterThanOrEqual(3_100);
  });
});

describe('run_process output caps', () => {
  it('stdout and stderr are each capped at maxOutputChars with a [truncated] marker', async () => {
    const out = await exec(runProcessTool({ cwd }), {
      command: [process.execPath, '-e', 'console.log("a".repeat(300)); console.error("b".repeat(300));'],
      maxOutputChars: 100,
    });
    const result = JSON.parse(out);
    expect(result.stdout.startsWith('a'.repeat(100))).toBe(true);
    expect(result.stdout).toContain('[truncated: 100 of 301 chars]');
    expect(result.stderr.startsWith('b'.repeat(100))).toBe(true);
    expect(result.stderr).toContain('[truncated: 100 of 301 chars]');
  });
});

describe('run_process background mode', () => {
  it('returns pid + logFile immediately; output lands in .agents/tmp log', async () => {
    const out = await exec(runProcessTool({ cwd }), {
      command: [
        process.execPath,
        '-e',
        'console.log("bg-line-1"); setTimeout(() => console.log("bg-line-2"), 200);',
      ],
      background: true,
    });
    const result = JSON.parse(out);
    expect(typeof result.pid).toBe('number');
    expect(result.logFile).toContain(join(cwd, '.agents', 'tmp'));
    expect(result.logFile).toMatch(/run-process-\d+\.log$/);
    expect(result.note).toContain('NOT managed');

    // Give the child time to flush, then read the log back.
    await new Promise((r) => setTimeout(r, 900));
    const log = readFileSync(result.logFile, 'utf-8');
    expect(log).toContain('bg-line-1');
    expect(log).toContain('bg-line-2');
  });
});
