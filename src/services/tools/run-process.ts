import { z } from 'zod';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, openSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineTool, safeExecute } from './common';
import { expandHome } from './permission-rules';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_OUTPUT_CHARS = 10_000;
/** After a timeout SIGTERM, the process gets this long before SIGKILL. */
const KILL_GRACE_MS = 3_000;

/** Accrues a text stream up to `cap` chars; the marker is added OUTSIDE the cap. */
class CappedBuffer {
  private text = '';
  private total = 0;

  constructor(private readonly cap: number) {}

  push(chunk: string): void {
    this.total += chunk.length;
    if (this.text.length < this.cap) {
      this.text += chunk.slice(0, this.cap - this.text.length);
    }
  }

  result(): string {
    return this.total > this.cap
      ? `${this.text}\n[truncated: ${this.cap} of ${this.total} chars]`
      : this.text;
  }
}

export function runProcessTool(deps: { cwd?: string } = {}) {
  const workspace = deps.cwd ?? process.cwd();

  /** Resolve + validate the working dir the way file tools resolve paths. */
  function workingDir(rawCwd: string | undefined): string {
    const expanded = rawCwd === undefined ? workspace : expandHome(rawCwd).path;
    const resolved = resolve(workspace, expanded);
    const stat = statSync(resolved, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isDirectory()) {
      throw new Error(`cwd is not a directory: ${rawCwd ?? '(workspace)'} (resolved: ${resolved})`);
    }
    return resolved;
  }

  return defineTool({
    description: `Run a process from a structured argv array — no shell is involved, so shell metacharacters ($, backticks, ;, &&) are passed to the program literally. Use it instead of bash when driving a built CLI, a dev server or a smoke-test target. Foreground waits for exit and returns exitCode/signal/stdout/stderr/durationMs (timeout: SIGTERM, then SIGKILL after 3s); background=true starts it, logs to .agents/tmp/run-process-<ts>.log and returns pid + logFile immediately. Requires controller approval for every call. Approval limits: the static gate scans only the argv words and cwd (sensitive list + workspace/allowedDirs scope) — runtime side effects of the program itself (writes or network beyond argv) cannot be covered statically, which is why every call still asks.`,
    parameters: z.object({
      command: z.array(z.string()).min(1).describe('Argv to spawn: command[0] is the executable, the rest are its arguments (never shell-interpreted)'),
      cwd: z.string().optional().describe('Working directory (relative to workspace or absolute); defaults to the task workspace'),
      env: z.record(z.string(), z.string()).optional().describe('Extra environment variables, merged over the current environment'),
      timeoutMs: z.number().int().min(1).max(MAX_TIMEOUT_MS).optional().describe(`Foreground timeout in ms; default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS} (SIGTERM, SIGKILL after 3s grace)`),
      background: z.boolean().optional().describe('Start without waiting: output goes to a log file, pid + logFile return immediately; default false'),
      maxOutputChars: z.number().int().min(1).optional().describe('Per-stream (stdout / stderr) character cap with a [truncated] marker; default 10000'),
    }),
    execute: safeExecute('run_process', async ({ command, cwd, env, timeoutMs, background, maxOutputChars }) => {
      const [executable, ...argv] = command;
      const dir = workingDir(cwd);
      const childEnv = env === undefined ? process.env : { ...process.env, ...env };

      if (background) {
        // .agents/tmp/ is the workspace's sanctioned scratch area (AGENTS.md);
        // the log lives on after the call so the worker can read it back.
        const tmpDir = join(workspace, '.agents', 'tmp');
        mkdirSync(tmpDir, { recursive: true });
        const logFile = join(tmpDir, `run-process-${Date.now()}.log`);
        // stdout and stderr share one append fd — the child writes the file
        // directly, so nothing keeps the parent's event loop (or lifetime)
        // tied to the child; child.unref() detaches it for real.
        const fd = openSync(logFile, 'a');
        const child = spawn(executable, argv, {
          cwd: dir,
          env: childEnv,
          shell: false,
          stdio: ['ignore', fd, fd],
        });
        // A spawn failure (ENOENT & friends) is async and would otherwise be
        // an unhandled 'error' event — write it where the reader will look.
        child.on('error', (err) => {
          appendFileSync(logFile, `[spawn error] ${(err as Error).message}\n`);
        });
        child.unref();
        return JSON.stringify(
          {
            pid: child.pid,
            logFile,
            note: 'Background process is NOT managed by the task abort — read the log file yourself after it finishes.',
          },
          null,
          2,
        );
      }

      // Foreground: capture both streams (separately), enforce the timeout.
      const cap = maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
      const stdout = new CappedBuffer(cap);
      const stderr = new CappedBuffer(cap);
      const startedAt = Date.now();
      const child = spawn(executable, argv, {
        cwd: dir,
        env: childEnv,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.setEncoding('utf-8');
      child.stderr.setEncoding('utf-8');
      child.stdout.on('data', (chunk: string) => stdout.push(chunk));
      child.stderr.on('data', (chunk: string) => stderr.push(chunk));

      const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
      let timedOut = false;

      const outcome = await new Promise<{ exitCode: number | null; signal: string | null; error?: string }>((settle) => {
        // Whichever fires first settles; a promise ignores the later one.
        child.on('error', (err) => settle({ exitCode: null, signal: null, error: (err as Error).message }));
        const killTimer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          // A process that traps SIGTERM still dies here.
          setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref();
        }, timeout);
        child.on('close', (exitCode, signal) => settle({ exitCode, signal: signal ?? null }));
        // Never let the timers outlive the child.
        const clear = () => clearTimeout(killTimer);
        child.on('close', clear);
        child.on('error', clear);
      });

      return JSON.stringify(
        {
          exitCode: outcome.exitCode,
          signal: outcome.signal,
          stdout: stdout.result(),
          stderr: stderr.result(),
          durationMs: Date.now() - startedAt,
          ...(timedOut
            ? { timedOut: true, note: `killed after ${timeout}ms timeout (SIGTERM, SIGKILL after ${KILL_GRACE_MS}ms grace)` }
            : {}),
          ...(outcome.error !== undefined && { error: outcome.error }),
        },
        null,
        2,
      );
    }),
  });
}
