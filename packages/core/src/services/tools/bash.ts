import { z } from 'zod';
import { execSync } from 'node:child_process';
import type { ExecException } from 'node:child_process';
import { defineTool, safeExecute } from './common';

export function bashTool(deps: { cwd?: string }) {
  return defineTool({
    description: 'Execute a shell command and return its output',
    parameters: z.object({
      command: z.string().describe('Shell command to execute'),
    }),
    execute: safeExecute('bash', async ({ command }) => {
      try {
        const output = execSync(command, {
          cwd: deps.cwd,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          encoding: 'utf-8',
        });
        return output || '(no output)';
      } catch (err) {
        // execSync failures carry status/stderr beyond the declared
        // ExecException fields (Node attaches them at runtime).
        const e = err as Partial<ExecException> & { status?: number | null };
        const stderr = e.stderr?.toString() || '';
        // Include the thrown message when stderr is empty (e.g. spawn failures,
        // timeout kills) — "Exit code 1" alone is undiagnosable.
        const detail = stderr || e.message || '';
        return `Exit code ${e.status ?? 1}\n${detail}`;
      }
    }),
  });
}
