import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { z } from 'zod';
import { defineTool, safeExecute } from './common';

/** Quote a string for safe shell argument usage. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function searchContentTool(deps: { cwd?: string }) {
  const workspace = deps.cwd ?? process.cwd();

  return defineTool({
    description:
      'Search file contents for a text pattern. Returns matching lines in file:line:content format.',
    parameters: z.object({
      query: z.string().describe('Search text or regex pattern'),
      path: z
        .string()
        .optional()
        .describe('Directory to search in (default: workspace root)'),
      include: z
        .string()
        .optional()
        .describe('File pattern to include (e.g. "*.ts", "*.py")'),
    }),
    execute: safeExecute('search_content', async ({ query, path, include }) => {
      const searchDir = path ? resolve(workspace, path) : workspace;
      let cmd = `grep -rn${include ? ` --include=${shellQuote(include)}` : ''} -- ${shellQuote(query)} ${shellQuote(searchDir)}`;

      try {
        const output = execSync(cmd, {
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
          encoding: 'utf-8',
        });
        return output || 'No matches found';
      } catch (err: any) {
        // grep exits with code 1 when no matches found — not a real error
        if (err.status === 1) return 'No matches found';
        return `Exit code ${err.status ?? 1}\n${err.stderr?.toString() || ''}`;
      }
    }),
  });
}
