/**
 * e2e: CLI flag handling — exit codes and output of the real binary.
 *
 * Requires `npm run build` first (spawns dist/cli.js). The unit tests in
 * src/__tests__/cli-args.test.ts cover parse-result routing; these tests pin
 * the process-level contract: version/help exit 0, usage errors exit 1 with
 * the offending flag echoed on stderr and the help text printed.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI_ENTRY = join(ROOT, 'dist', 'cli.js');

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], timeoutMs = 30_000): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (c: string) => { stdout += c; });
    child.stderr.on('data', (c: string) => { stderr += c; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`wayang ${args.join(' ')} timed out`));
    }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

describe('e2e: CLI flags — version and help', () => {
  it('-v prints the package version and exits 0', async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf-8')) as { version: string };
    const run = await runCli(['-v']);
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toBe(pkg.version);
    expect(run.stderr).toBe('');
  });

  it('--version still works and exits 0', async () => {
    const run = await runCli(['--version']);
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('-v does not enable verbose mode (no app startup)', async () => {
    // If -v were still verbose, the process would start onboarding/UI instead
    // of exiting — the fast exit 0 with version output is the contract.
    const run = await runCli(['-v']);
    expect(run.code).toBe(0);
    expect(run.stdout).not.toContain('Usage');
  });

  it('-h prints help and exits 0', async () => {
    const run = await runCli(['-h']);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Usage');
    expect(run.stdout).toContain('--version, -v');
    expect(run.stdout).toContain('--help, -h');
    expect(run.stdout).toContain('--resume, -r');
    expect(run.stdout).toContain('--verbose');
  });

  it('--help still works and exits 0', async () => {
    const run = await runCli(['--help']);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Usage');
  });
});

describe('e2e: CLI flags — usage errors exit non-zero without starting', () => {
  it('unknown long flag: exit 1, flag echoed on stderr, help printed', async () => {
    const run = await runCli(['--definitely-not-a-flag']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('--definitely-not-a-flag');
    expect(run.stderr).toContain('Unknown option');
    expect(run.stdout).toContain('Usage');
  });

  it('unknown short flag: exit 1 with the flag echoed', async () => {
    const run = await runCli(['-x']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('-x');
  });

  it('string flag without a value: exit 1 with "requires a value"', async () => {
    const run = await runCli(['--config']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('--config');
    expect(run.stderr).toContain('requires a value');
    expect(run.stdout).toContain('Usage');
  });

  it('boolean flag with an inline value: exit 1 with "does not accept a value"', async () => {
    const run = await runCli(['--resume=abc']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('--resume');
    expect(run.stderr).toContain('does not accept a value');
  });

  it('case variant of a known flag (--Version) is rejected, not swallowed', async () => {
    const run = await runCli(['--Version']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('--Version');
  });

  it('server subcommand rejects unknown flags too', async () => {
    const run = await runCli(['server', '--nope']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('--nope');
  });

  it('server --session with an invalid value exits non-zero (existing validation)', async () => {
    const run = await runCli(['server', '--session', 'garbage']);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('--session');
  });
});

describe('e2e: CLI flags — valid combinations reach the app layer', () => {
  it('--verbose --version exits 0 with the version (verbose stays long-only)', async () => {
    const run = await runCli(['--verbose', '--version']);
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('-v --definitely-not-a-flag errors instead of printing the version', async () => {
    const run = await runCli(['-v', '--definitely-not-a-flag']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('--definitely-not-a-flag');
  });
});
